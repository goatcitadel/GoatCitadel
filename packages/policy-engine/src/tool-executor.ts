/* eslint-disable max-lines -- Tool execution policy remains intentionally centralized so grants, approvals, and audit behavior stay in one authoritative path. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  BrowserSessionAccessCheck,
  ChannelDeliveryStatus,
  ContextSourceAttribution,
  IngestionBackend,
  ToolExecutionTrustLevel,
  ToolGrantRecord,
  ToolInvokeRequest,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { clampInt, coerceRetryAfterMs, sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { hasVerifiedApprovalBypass } from "./approval-bypass.js";
import { assertReadPathAllowed, assertWritePathInJail, resolveReadPathAccess } from "./sandbox/path-jail.js";
import { assertHostAllowed, fetchAllowlistedOnce, redactUrlForError } from "./sandbox/network-guard.js";
import { executeBrowserTool, isBrowserToolName } from "./browser-tools.js";
import { scanBrowserContentGuard } from "./browser-content-guard.js";
import { collectLeakDetections, sanitizeForModel } from "./tool-security.js";
import {
  buildArtifactDesignReport,
  createArtifactDesignPlan,
  type ArtifactValidationCheck,
} from "./artifact-design.js";
import { ingestDocumentViaBackend, resolveIngestionTrustLevel, searchIngestedContext } from "./ingestion-backends.js";
import { parseIngestionSourceType } from "./ingestion-source-type.js";
import { matchesToolPattern } from "./tool-patterns.js";
import { classifyShellRisk } from "./sandbox/shell-risk-gate.js";
import { analyzePresentationDeckQuality, type PresentationDeckQualitySummary } from "./presentation-layout.js";
import {
  createPresentationPptxWithDiagnostics,
  type PresentationPptxDiagnostics,
  type PresentationSlide,
  type PresentationVisualAsset,
} from "./presentation-pptx.js";
import {
  createDocumentArtifact,
  documentArtifactExtension,
  type DocumentArtifactFormat,
  type DocumentArtifactSection,
} from "./document-artifacts.js";
const execFileAsync = promisify(execFile);
const MAX_HTTP_REDIRECTS = 5;
const MAX_HTTP_RETRIES = 2;
const MAX_HTTP_RETRY_DELAY_MS = 50;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const MAX_SHELL_OUTPUT_BYTES = 4096;
const TRUST_RESTRICTIVENESS: Record<ToolExecutionTrustLevel, number> = {
  trusted_operator: 0,
  trusted_workspace: 1,
  mixed_untrusted: 2,
  untrusted_external: 3,
};

export interface ToolExecutorRuntimeHooks {
  assertBrowserSessionAccess?: (check: BrowserSessionAccessCheck) => void;
}

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /key-[a-zA-Z0-9]{20,}/g,
  /Bearer [a-zA-Z0-9._-]{20,}/g,
  /[A-Z_]+=\S{20,}/g,
  /\/etc\/\S+/g,
  /\/home\/[^/]+\/\.[^\s]+/g,
  /C:\\Users\\[^\\]+\\AppData\S*/gi,
];
const FIXED_OUTBOUND_HOSTS_BY_TOOL = new Map<string, string[]>([
  ["calendar.create_event", ["www.googleapis.com"]],
  ["calendar.list", ["www.googleapis.com"]],
  ["discord.react", ["discord.com"]],
  ["discord.send", ["discord.com"]],
  ["discord.unsend", ["discord.com"]],
  ["gmail.read", ["gmail.googleapis.com"]],
  ["gmail.send", ["gmail.googleapis.com"]],
  ["line.send", ["api.line.me"]],
  ["slack.react", ["slack.com"]],
  ["slack.send", ["slack.com"]],
  ["slack.unsend", ["slack.com"]],
  ["telegram.react", ["api.telegram.org"]],
  ["telegram.send", ["api.telegram.org"]],
  ["telegram.unsend", ["api.telegram.org"]],
  ["whatsapp.send", ["graph.facebook.com"]],
  ["zalo.send", ["openapi.zalo.me"]],
]);
const FIXED_OUTBOUND_HOSTS_BY_CHANNEL_KEY = new Map<string, string[]>([
  ["discord", ["discord.com"]],
  ["gmail", ["gmail.googleapis.com"]],
  ["google-calendar", ["www.googleapis.com"]],
  ["line", ["api.line.me"]],
  ["slack", ["slack.com"]],
  ["telegram", ["api.telegram.org"]],
  ["whatsapp", ["graph.facebook.com"]],
  ["zalo", ["openapi.zalo.me"]],
]);

function scrubSensitiveOutput(text: string): string {
  let scrubbed = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, pattern.flags), "[REDACTED]");
  }
  return scrubbed.slice(0, MAX_SHELL_OUTPUT_BYTES);
}

export function resolveFixedOutboundHostsForTool(toolName: string, connectionKey?: string): string[] {
  const hosts = new Set(FIXED_OUTBOUND_HOSTS_BY_TOOL.get(toolName) ?? []);
  if (connectionKey && (toolName === "channel.send" || toolName === "channel.react" || toolName === "channel.unsend")) {
    for (const host of FIXED_OUTBOUND_HOSTS_BY_CHANNEL_KEY.get(connectionKey) ?? []) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

function resolveToolActorId(request: ToolInvokeRequest): string {
  return request.policyContext?.authActorId?.trim() || request.consentContext?.operatorId?.trim() || request.agentId;
}

export async function executeTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
  runtimeHooks: ToolExecutorRuntimeHooks = {},
): Promise<Record<string, unknown>> {
  const browserContentGuard = scanBrowserContentGuard(request.args);
  if (browserContentGuard.blocked) {
    throw new Error(
      `Browser content guard blocked tool args: ${browserContentGuard.reason ?? "untrusted_content_canary_leak"}.`,
    );
  }

  const argLeakDetections = collectLeakDetections(request.args);
  if (argLeakDetections.length > 0 && (request.authContext?.secretRefs?.length ?? 0) === 0) {
    throw new Error(
      `Tool args contain secret-like material (${argLeakDetections.join(", ")}); resolve secrets at the tool host boundary instead.`,
    );
  }

  if (isBrowserToolName(request.toolName)) {
    const rawResult = await executeBrowserTool(request.toolName, request.args, config, {
      sessionId: request.sessionId,
      signal: request.signal,
      matchedGrantAllowedHosts: resolveExecutionGrantAllowedHosts(request, storage),
      fullWebAccess: hasFullWebAccess(request),
      actorId: resolveToolActorId(request),
      ...(request.runId ? { runId: request.runId } : {}),
      assertBrowserSessionAccess: runtimeHooks.assertBrowserSessionAccess,
    });
    return finalizeToolResult(rawResult);
  }
  switch (request.toolName) {
    case "session.status":
      return finalizeToolResult({ sessionId: request.sessionId, status: "ok" });
    case "time.now":
      return finalizeToolResult(timeNow());
    case "fs.read":
      return finalizeToolResult(await fsRead(request, config, storage));
    case "file.read_range":
      return finalizeToolResult(await fileReadRange(request, config, storage));
    case "file.find":
      return finalizeToolResult(await fileFind(request, config, storage));
    case "code.search":
      return finalizeToolResult(await codeSearch(request, config, storage));
    case "code.search_files":
      return finalizeToolResult(await codeSearchFiles(request, config, storage));
    case "fs.write":
      return finalizeToolResult(await fsWrite(request.args, config));
    case "fs.list":
      return finalizeToolResult(await fsList(request, config, storage));
    case "fs.stat":
      return finalizeToolResult(await fsStat(request, config, storage));
    case "fs.copy":
      return finalizeToolResult(await fsCopy(request, config, storage));
    case "fs.move":
      return finalizeToolResult(await fsMove(request.args, config));
    case "fs.delete":
      return finalizeToolResult(await fsDelete(request.args, config));
    case "http.get":
      return finalizeToolResult(await httpGet(request, config, storage));
    case "http.post":
      return finalizeToolResult(await httpPost(request, config, storage));
    case "shell.exec":
      return finalizeToolResult(await shellExec(request, config, storage));
    case "shell.exec_background":
      return finalizeToolResult(await shellExecBackground(request, config, storage));
    case "git.status":
      return finalizeToolResult(await gitStatus());
    case "git.diff":
      return finalizeToolResult(await gitDiff(request.args));
    case "git.add":
      return finalizeToolResult(await gitAdd(request.args, config));
    case "git.commit":
      return finalizeToolResult(await gitCommit(request.args));
    case "git.branch.create":
      return finalizeToolResult(await gitBranchCreate(request.args));
    case "git.branch.switch":
      return finalizeToolResult(await gitBranchSwitch(request.args));
    case "git.worktree.create":
      return finalizeToolResult(await gitWorktreeCreate(request.args, config));
    case "git.worktree.remove":
      return finalizeToolResult(await gitWorktreeRemove(request.args, config));
    case "tests.run":
      return finalizeToolResult(await runRestricted("test", request, config, storage));
    case "lint.run":
      return finalizeToolResult(await runRestricted("lint", request, config, storage));
    case "build.run":
      return finalizeToolResult(await runRestricted("build", request, config, storage));
    case "memory.read":
      return finalizeToolResult(await memoryRead(request.args, storage));
    case "memory.write":
      return finalizeToolResult(await memoryWrite(request, storage, false));
    case "memory.upsert":
      return finalizeToolResult(await memoryWrite(request, storage, true));
    case "memory.search":
      return finalizeToolResult(await memorySearch(request.args, storage));
    case "citations.build":
      return finalizeToolResult(citationsBuild(request.args));
    case "docs.ingest":
      return finalizeToolResult(await docsIngest(request, config, storage));
    case "docs.search":
      return finalizeToolResult(docsSearch(request.args, storage));
    case "embeddings.index":
      return finalizeToolResult(await embeddingsIndex(request.args, storage));
    case "embeddings.query":
      return finalizeToolResult(await embeddingsQuery(request.args, storage));
    case "artifacts.create":
      return finalizeToolResult(await artifactsCreate(request.args, config));
    case "documents.create":
      return finalizeToolResult(await documentsCreate(request.args, config));
    case "presentations.create":
      return finalizeToolResult(await presentationsCreate(request.args, config));
    case "channel.send":
    case "channel.react":
    case "channel.unsend":
    case "webhook.send":
    case "gmail.read":
    case "gmail.send":
    case "calendar.list":
    case "calendar.create_event":
    case "discord.send":
    case "discord.react":
    case "discord.unsend":
    case "google-chat.send":
    case "line.send":
    case "mattermost.send":
    case "mattermost.react":
    case "mattermost.unsend":
    case "nextcloud-talk.send":
    case "nextcloud-talk.react":
    case "imessage.send":
    case "imessage.react":
    case "imessage.unsend":
    case "signal.send":
    case "slack.send":
    case "slack.react":
    case "slack.unsend":
    case "telegram.unsend":
    case "telegram.react":
    case "telegram.send":
    case "teams.send":
    case "whatsapp.send":
    case "whatsapp.react":
    case "zalo.send":
    case "zalouser.send":
      return finalizeToolResult(await commsInvoke(request, config, storage));
    default:
      throw new Error(`Unsupported tool executor: ${request.toolName}`);
  }
}

function isFullWebAccessEligibleTool(toolName: string): boolean {
  return (
    toolName === "browser.search" ||
    toolName === "browser.navigate" ||
    toolName === "browser.extract" ||
    toolName === "browser.screenshot" ||
    toolName === "http.get" ||
    toolName === "docs.ingest"
  );
}

function hasFullWebAccess(request: ToolInvokeRequest): boolean {
  return isFullWebAccessEligibleTool(request.toolName) && request.policyContext?.fullWebAccess !== false;
}

function resolveNetworkAllowlist(request: ToolInvokeRequest, config: ToolPolicyConfig): string[] {
  return hasFullWebAccess(request) ? [...config.sandbox.networkAllowlist, "*"] : config.sandbox.networkAllowlist;
}

function timeNow() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    epochMs: now.getTime(),
  };
}

async function fsRead(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const p = required(args.path, "path");
  assertReadPathAllowedForRequest(p, request, config, storage);
  const content = await fs.readFile(path.resolve(p), "utf8");
  return { path: path.resolve(p), bytes: content.length, content };
}

async function fileReadRange(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const p = required(args.path, "path");
  assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const content = await fs.readFile(full, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = clampInt(args.startLine, 1, 1, Math.max(lines.length, 1));
  const endLine = clampInt(args.endLine, startLine, startLine, Math.max(lines.length, startLine));
  const selected = lines.slice(startLine - 1, endLine);
  return {
    path: full,
    startLine,
    endLine,
    lineCount: selected.length,
    content: selected.join("\n"),
  };
}

async function fileFind(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  return searchFileContents({
    request,
    rootPath: required(args.path, "path"),
    pattern: required(args.pattern, "pattern"),
    caseSensitive: asBoolean(args.caseSensitive, false),
    limit: clampInt(args.limit, 25, 1, 200),
    config,
    storage,
  });
}

async function codeSearch(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  return searchFileContents({
    request,
    rootPath: required(args.path, "path"),
    pattern: required(args.query, "query"),
    caseSensitive: asBoolean(args.caseSensitive, false),
    limit: clampInt(args.limit, 25, 1, 200),
    config,
    storage,
    codeOnly: true,
  });
}

async function codeSearchFiles(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const rootPath = required(args.path, "path");
  assertReadPathAllowedForRequest(rootPath, request, config, storage);
  const fullRoot = path.resolve(rootPath);
  const query = required(args.query, "query");
  const caseSensitive = asBoolean(args.caseSensitive, false);
  const limit = clampInt(args.limit, 25, 1, 200);
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const matches: Array<{ path: string; name: string; type: "file" | "dir" }> = [];
  const pending = [fullRoot];

  while (pending.length > 0 && matches.length < limit) {
    const current = pending.pop() as string;
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      const name = path.basename(current);
      const haystack = caseSensitive ? name : name.toLowerCase();
      if (haystack.includes(normalizedQuery)) {
        matches.push({ path: current, name, type: "file" });
      }
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipSearchEntry(entry.name)) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      const haystack = caseSensitive ? entry.name : entry.name.toLowerCase();
      if (haystack.includes(normalizedQuery)) {
        matches.push({
          path: entryPath,
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        });
        if (matches.length >= limit) {
          break;
        }
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }

  return {
    path: fullRoot,
    query,
    count: matches.length,
    matches,
  };
}

async function fsWrite(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  const content = String(args.content ?? "");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return { path: full, bytesWritten: content.length };
}

async function fsList(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const p = asString(args.path) ?? ".";
  assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const items = await fs.readdir(full, { withFileTypes: true });
  return {
    path: full,
    items: items.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
    })),
  };
}

async function fsStat(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const p = required(args.path, "path");
  assertReadPathAllowedForRequest(p, request, config, storage);
  const full = path.resolve(p);
  const stat = await fs.stat(full);
  return {
    path: full,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function fsCopy(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const from = required(args.from, "from");
  const to = required(args.to, "to");
  assertReadPathAllowedForRequest(from, request, config, storage);
  assertWritePathInJail(to, config.sandbox.writeJailRoots);
  const fullTo = path.resolve(to);
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.copyFile(path.resolve(from), fullTo);
  return { from: path.resolve(from), to: fullTo };
}

async function fsMove(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const from = required(args.from, "from");
  const to = required(args.to, "to");
  assertWritePathInJail(from, config.sandbox.writeJailRoots);
  assertWritePathInJail(to, config.sandbox.writeJailRoots);
  const fullTo = path.resolve(to);
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.rename(path.resolve(from), fullTo);
  return { from: path.resolve(from), to: fullTo };
}

async function fsDelete(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  await fs.rm(path.resolve(p), { recursive: asBoolean(args.recursive, false), force: false });
  return { path: path.resolve(p), deleted: true };
}

async function httpGet(request: ToolInvokeRequest, config: ToolPolicyConfig, storage?: Storage) {
  const args = request.args;
  const url = required(args.url, "url");
  const res = await fetchAllowlisted(
    url,
    { method: "GET" },
    resolveNetworkAllowlist(request, config),
    request.signal,
    resolveExecutionGrantAllowedHosts(request, storage),
  );
  const text = await res.response.text();
  return {
    url: res.finalUrl,
    status: res.response.status,
    contentType: res.response.headers.get("content-type") ?? undefined,
    byteLength: Buffer.byteLength(text, "utf8"),
    body: text,
    bodySnippet: text.slice(0, 4000),
  };
}

async function httpPost(request: ToolInvokeRequest, config: ToolPolicyConfig, storage?: Storage) {
  const args = request.args;
  const url = required(args.url, "url");
  const body = JSON.stringify(args.body ?? {});
  const res = await fetchAllowlisted(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body },
    config.sandbox.networkAllowlist,
    request.signal,
    resolveExecutionGrantAllowedHosts(request, storage),
  );
  const text = await res.response.text();
  return {
    url: res.finalUrl,
    status: res.response.status,
    contentType: res.response.headers.get("content-type") ?? undefined,
    byteLength: Buffer.byteLength(text, "utf8"),
    body: text,
    bodySnippet: text.slice(0, 4000),
  };
}

async function shellExec(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const command = required(args.command, "command");
  const cwd = resolveOptionalCwd(args.cwd, request, config, storage);
  const shellRisk = classifyShellRisk(command, config.sandbox.riskyShellPatterns);
  const approvalBypass = hasVerifiedApprovalBypass(request, storage);
  if (shellRisk.risky && config.sandbox.requireApprovalForRiskyShell && !approvalBypass) {
    throw new Error(
      `Risky shell command requires approval (matched pattern: ${shellRisk.matchedPattern ?? "unknown"})`,
    );
  }
  const parsed = parseExecFileCommand(command);
  const executable = resolveExecutableCommand(parsed.file, parsed.args);
  try {
    const { stdout, stderr } = await execFileAsync(executable.file, executable.args, {
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      cwd,
    });
    return {
      command,
      cwd,
      executable: parsed.file,
      argv: parsed.args,
      stdout: scrubSensitiveOutput(stdout),
      stderr: scrubSensitiveOutput(stderr),
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = (error as { stdout?: string })?.stdout;
    const stderr = (error as { stderr?: string })?.stderr;
    const code = (error as { code?: number | string })?.code;
    return {
      command,
      cwd,
      executable: parsed.file,
      argv: parsed.args,
      stdout: scrubSensitiveOutput(stdout ?? ""),
      stderr: scrubSensitiveOutput(stderr ?? message),
      exitCode: typeof code === "number" ? code : -1,
    };
  }
}

async function shellExecBackground(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const args = request.args;
  const command = required(args.command, "command");
  const cwd = resolveOptionalCwd(args.cwd, request, config, storage);
  const shellRisk = classifyShellRisk(command, config.sandbox.riskyShellPatterns);
  const approvalBypass = hasVerifiedApprovalBypass(request, storage);
  if (shellRisk.risky && config.sandbox.requireApprovalForRiskyShell && !approvalBypass) {
    throw new Error(
      `Risky shell command requires approval (matched pattern: ${shellRisk.matchedPattern ?? "unknown"})`,
    );
  }
  const parsed = parseExecFileCommand(command);
  const executable = resolveExecutableCommand(parsed.file, parsed.args);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(executable.file, executable.args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.unref();
    setTimeout(() => {
      resolve({
        command,
        cwd,
        executable: parsed.file,
        argv: parsed.args,
        pid: child.pid,
        detached: true,
        started: true,
      });
    }, 20);
  });
}

async function gitStatus() {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], {
    timeout: 15000,
    windowsHide: true,
  });
  return { summary: stdout.slice(0, 10000) };
}

async function gitDiff(args: Record<string, unknown>) {
  const staged = asBoolean(args.staged, false);
  const { stdout } = await execFileAsync("git", staged ? ["diff", "--cached"] : ["diff"], {
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { staged, diffSnippet: stdout.slice(0, 12000), truncated: stdout.length > 12000 };
}

async function gitAdd(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const paths = stringArray(args.paths);
  // SEC: Always run jail check on every path, including ".". Never allow
  // wildcard staging that bypasses write-jail enforcement.
  const resolvedPaths = paths.length > 0 ? paths : ["."];
  for (const p of resolvedPaths) {
    assertWritePathInJail(path.resolve(p), config.sandbox.writeJailRoots);
  }
  await execFileAsync("git", ["add", ...resolvedPaths], { timeout: 15000, windowsHide: true });
  return { staged: resolvedPaths };
}

async function gitCommit(args: Record<string, unknown>) {
  const message = required(args.message, "message");
  const { stdout } = await execFileAsync("git", ["commit", "-m", message], { timeout: 20000, windowsHide: true });
  return { committed: true, output: stdout.slice(0, 4000) };
}

async function gitBranchCreate(args: Record<string, unknown>) {
  const branch = required(args.branch, "branch");
  await execFileAsync("git", ["branch", branch], { timeout: 10000, windowsHide: true });
  return { created: true, branch };
}

async function gitBranchSwitch(args: Record<string, unknown>) {
  const branch = required(args.branch, "branch");
  await execFileAsync("git", ["switch", branch], { timeout: 15000, windowsHide: true });
  return { switched: true, branch };
}

async function gitWorktreeCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  const branch = required(args.branch, "branch");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  await execFileAsync("git", ["worktree", "add", p, branch], { timeout: 30000, windowsHide: true });
  return { created: true, path: path.resolve(p), branch };
}

async function gitWorktreeRemove(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  await execFileAsync("git", ["worktree", "remove", p], { timeout: 30000, windowsHide: true });
  return { removed: true, path: path.resolve(p) };
}

async function runRestricted(
  kind: "test" | "lint" | "build",
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
) {
  const args = request.args;
  const manager = asString(args.manager) ?? "pnpm";
  const filter = asString(args.filter);
  const cwd = resolveOptionalCwd(args.cwd, request, config, storage);
  if (filter && !/^[a-zA-Z0-9@/_\-.]+$/.test(filter)) {
    throw new Error(`Invalid filter: ${filter}`);
  }
  if (manager !== "pnpm" && manager !== "npm") {
    throw new Error("Only pnpm/npm are allowed");
  }
  const cmdArgs = manager === "pnpm" ? [...(filter ? ["--filter", filter] : []), "run", kind] : ["run", kind];
  const command = resolveRestrictedCommand(manager, cmdArgs);
  const { stdout, stderr } = await execFileAsync(command.file, command.args, {
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    cwd,
  });
  return { manager, kind, cwd, stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 10000) };
}

export function resolveRestrictedCommand(
  manager: "pnpm" | "npm",
  cmdArgs: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  return resolveExecutableCommand(manager, cmdArgs, platform);
}

export function resolveExecutableCommand(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform !== "win32" || (file !== "pnpm" && file !== "npm")) {
    return { file, args };
  }
  return {
    file: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", [file, ...args].map(quoteForCmd).join(" ")],
  };
}

function quoteForCmd(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  let needsQuotes = false;
  for (const char of value) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === '"') {
      needsQuotes = true;
      break;
    }
    if (char === "&" || char === "(" || char === ")" || char === "^" || char === "<" || char === ">" || char === "|") {
      needsQuotes = true;
      break;
    }
  }
  if (!needsQuotes) {
    return value;
  }

  let escaped = '"';
  let pendingBackslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      pendingBackslashes += 1;
      continue;
    }
    if (char === '"') {
      escaped += "\\".repeat(pendingBackslashes * 2 + 1);
      escaped += '"';
      pendingBackslashes = 0;
      continue;
    }
    if (pendingBackslashes > 0) {
      escaped += "\\".repeat(pendingBackslashes);
      pendingBackslashes = 0;
    }
    if (char === "&" || char === "(" || char === ")" || char === "^" || char === "<" || char === ">" || char === "|") {
      escaped += `^${char}`;
      continue;
    }
    escaped += char;
  }
  if (pendingBackslashes > 0) {
    escaped += "\\".repeat(pendingBackslashes * 2);
  }
  escaped += '"';
  return escaped;
}

async function memoryWrite(request: ToolInvokeRequest, storage: Storage, upsert: boolean) {
  const args = request.args;
  const namespace = required(args.namespace, "namespace");
  const title = required(args.title, "title");
  const content = required(args.content, "content");
  const inputMetadata = record(args.metadata);
  const sourceAttribution = normalizeSourceAttributionForStorage(request.sourceAttribution);
  const carriedTrustLevel = resolveMostRestrictiveSourceTrustLevel(sourceAttribution);
  const ingestionMetadata = {
    ...record(inputMetadata.ingestion),
    ...(carriedTrustLevel ? { trustLevel: carriedTrustLevel } : {}),
  };
  const doc = storage.knowledge.createDocument({
    namespace,
    sourceType: "memory",
    sourceRef: upsert ? `upsert:${namespace}:${title}` : `memory:${Date.now()}`,
    title,
    metadata: {
      tags: stringArray(args.tags),
      ...inputMetadata,
      ...(sourceAttribution.length > 0 ? { sourceAttribution } : {}),
      ...(Object.keys(ingestionMetadata).length > 0 ? { ingestion: ingestionMetadata } : {}),
    },
  });
  const chunks = chunkText(content, 1200, 180, 400);
  storage.knowledge.appendChunks(
    doc.docId,
    chunks.map((chunk) => ({
      content: chunk,
      embedding: pseudoEmbedding(chunk),
    })),
  );
  const attribution = knowledgeDocumentAttribution(doc);
  return {
    mode: upsert ? "upsert" : "write",
    document: {
      ...doc,
      attribution,
    },
    attribution,
    ...(sourceAttribution.length > 0 ? { sourceAttribution } : {}),
    chunksSaved: chunks.length,
  };
}

async function memoryRead(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const query = (asString(args.query) ?? asString(args.title) ?? asString(args.key) ?? "").trim().toLowerCase();
  const limit = clampInt(args.limit, 5, 1, 50);
  const documents = storage.knowledge.listDocuments(namespace, 500);
  const chunkMap = new Map<string, ReturnType<Storage["knowledge"]["listChunksByDocument"]>>();
  const readChunks = (docId: string) => {
    const existing = chunkMap.get(docId);
    if (existing) {
      return existing;
    }
    const next = storage.knowledge.listChunksByDocument(docId, 25);
    chunkMap.set(docId, next);
    return next;
  };

  if (!query) {
    return {
      namespace: namespace ?? "all",
      items: documents.slice(0, limit).map((doc) => {
        const chunks = readChunks(doc.docId);
        return {
          docId: doc.docId,
          title: doc.title,
          sourceRef: doc.sourceRef,
          metadata: doc.metadata,
          attribution: knowledgeDocumentAttribution(doc),
          snippet: chunks[0]?.content.slice(0, 320) ?? "",
        };
      }),
    };
  }

  const items = documents
    .map((doc) => {
      const chunks = readChunks(doc.docId);
      const titleScore = scoreLexical(query, `${doc.title} ${doc.sourceRef}`.toLowerCase());
      const bestChunk = chunks
        .map((chunk) => ({
          chunk,
          score: scoreLexical(query, chunk.content.toLowerCase()),
        }))
        .sort((left, right) => right.score - left.score)[0];
      const score = Math.max(titleScore, bestChunk?.score ?? 0);
      return score > 0
        ? {
            docId: doc.docId,
            title: doc.title,
            sourceRef: doc.sourceRef,
            metadata: doc.metadata,
            attribution: knowledgeDocumentAttribution(doc),
            score,
            snippet: bestChunk?.chunk.content.slice(0, 320) ?? "",
          }
        : undefined;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    namespace: namespace ?? "all",
    query,
    items,
  };
}

async function memorySearch(args: Record<string, unknown>, storage: Storage) {
  const query = required(args.query, "query").toLowerCase();
  const namespace = asString(args.namespace);
  const limit = clampInt(args.limit, 12, 1, 100);
  const chunks = storage.knowledge.listChunksByNamespace(namespace, 2000);
  const docById = new Map(storage.knowledge.listDocuments(namespace, 500).map((doc) => [doc.docId, doc] as const));
  const items = chunks
    .map((chunk) => {
      const doc = docById.get(chunk.docId);
      if (!doc) {
        return undefined;
      }
      return {
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        score: scoreLexical(query, chunk.content.toLowerCase()),
        snippet: chunk.content.slice(0, 320),
        attribution: knowledgeDocumentAttribution(doc),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { namespace: namespace ?? "all", query, items };
}

function knowledgeDocumentAttribution(
  doc: ReturnType<Storage["knowledge"]["listDocuments"]>[number],
): ContextSourceAttribution {
  const ingestion = record(doc.metadata.ingestion);
  const backend = asString(ingestion.backend);
  return {
    sourceType: doc.sourceType,
    sourceRef: doc.sourceRef,
    title: doc.title,
    ...(backend === "native" || backend === "firecrawl" ? { backend: backend as IngestionBackend["backend"] } : {}),
    ...(asString(ingestion.fetchedAt) ? { fetchedAt: asString(ingestion.fetchedAt) } : {}),
    trustLevel: resolveIngestionTrustLevel(doc.sourceType, ingestion.trustLevel),
  };
}

function normalizeSourceAttributionForStorage(
  sourceAttribution: ToolInvokeRequest["sourceAttribution"],
): ContextSourceAttribution[] {
  return (sourceAttribution ?? []).map((source) => ({
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    ...(source.title ? { title: source.title } : {}),
    ...(source.backend ? { backend: source.backend } : {}),
    ...(source.fetchedAt ? { fetchedAt: source.fetchedAt } : {}),
    trustLevel: resolveIngestionTrustLevel(source.sourceType, source.trustLevel),
  }));
}

function resolveMostRestrictiveSourceTrustLevel(
  sourceAttribution: readonly ContextSourceAttribution[],
): ToolExecutionTrustLevel | undefined {
  let effectiveTrust: ToolExecutionTrustLevel | undefined;
  for (const source of sourceAttribution) {
    const sourceTrust = resolveIngestionTrustLevel(source.sourceType, source.trustLevel);
    if (!effectiveTrust || TRUST_RESTRICTIVENESS[sourceTrust] > TRUST_RESTRICTIVENESS[effectiveTrust]) {
      effectiveTrust = sourceTrust;
    }
  }
  return effectiveTrust;
}

function citationsBuild(args: Record<string, unknown>) {
  const rawSources = Array.isArray(args.sources) ? args.sources : [];
  const results = rawSources
    .map((entry, index) => {
      const source = record(entry);
      const url = asString(source.url);
      if (!url) {
        return undefined;
      }
      return {
        citationId: asString(source.citationId) ?? `citation-${index + 1}`,
        title: asString(source.title),
        url,
        snippet: asString(source.snippet) ?? asString(source.description),
        sourceType: asString(source.sourceType) ?? "web",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  return {
    count: results.length,
    results,
    citations: results,
    builtAt: new Date().toISOString(),
  };
}

async function docsIngest(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const sourceType = parseIngestionSourceType(request.args.sourceType);
  if (sourceType === "file") {
    assertReadPathAllowedForRequest(String(request.args.source ?? ""), request, config, storage);
  }
  const ingested = await ingestDocumentViaBackend({
    request,
    storage,
    networkAllowlist: resolveNetworkAllowlist(request, config),
    sourceAllowlist: resolveExecutionGrantAllowedHosts(request, storage),
    fetchUrl: async (url) => {
      const res = await fetchAllowlisted(
        url,
        { method: "GET" },
        resolveNetworkAllowlist(request, config),
        request.signal,
        resolveExecutionGrantAllowedHosts(request, storage),
      );
      const body = await res.response.text();
      return {
        finalUrl: res.finalUrl,
        statusCode: res.response.status,
        contentType: res.response.headers.get("content-type") ?? undefined,
        body,
      };
    },
  });
  return {
    backend: ingested.backend,
    fetchResult: ingested.fetchResult,
    document: ingested.document,
    chunksSaved: ingested.chunksSaved,
    cached: ingested.cached,
    chunks: ingested.chunks,
  };
}

function docsSearch(args: Record<string, unknown>, storage: Storage) {
  const query = required(args.query, "query");
  const namespace = asString(args.namespace);
  const limit = clampInt(args.limit, 8, 1, 50);
  return searchIngestedContext({
    storage,
    namespace,
    query,
    limit,
  });
}

async function embeddingsIndex(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const documentId = asString(args.documentId);
  const force = asBoolean(args.force, false);
  const chunks = documentId
    ? storage.knowledge.listChunksByDocument(documentId, 2000)
    : storage.knowledge.listChunksByNamespace(namespace, 2000);
  let indexed = 0;
  for (const chunk of chunks) {
    if (!chunk.embedding || force) {
      storage.knowledge.updateChunkEmbedding(chunk.chunkId, pseudoEmbedding(chunk.content));
      indexed += 1;
    }
  }
  return { namespace: namespace ?? "all", documentId, indexed };
}

async function embeddingsQuery(args: Record<string, unknown>, storage: Storage) {
  const namespace = asString(args.namespace);
  const query = required(args.query, "query");
  const limit = clampInt(args.limit, 10, 1, 100);
  const q = pseudoEmbedding(query);
  const chunks = storage.knowledge.listChunksByNamespace(namespace, 2000);
  const docById = new Map(storage.knowledge.listDocuments(namespace, 500).map((doc) => [doc.docId, doc] as const));
  const items = chunks
    .map((chunk) => {
      const doc = docById.get(chunk.docId);
      if (!doc) {
        return undefined;
      }
      return {
        chunkId: chunk.chunkId,
        docId: chunk.docId,
        score: cosine(q, chunk.embedding ?? pseudoEmbedding(chunk.content)),
        snippet: chunk.content.slice(0, 320),
        attribution: knowledgeDocumentAttribution(doc),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { namespace: namespace ?? "all", query, items, method: "pseudo-embedding" };
}

async function artifactsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const p = required(args.path, "path");
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const title = asString(args.title) ?? "Artifact";
  const template = asString(args.template) ?? "report";
  const body = asString(args.body) ?? "";
  const out = [
    `# ${title}`,
    "",
    `Template: ${template}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    body || "_No content provided._",
    "",
  ].join("\n");
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, out, "utf8");
  return { path: full, bytesWritten: out.length, template };
}

async function documentsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const requestedPath = required(args.path, "path");
  const format = resolveDocumentFormat(asString(args.format), requestedPath);
  const p = ensureDocumentPath(requestedPath, format);
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const full = path.resolve(p);
  const title = truncateText(asString(args.title) ?? inferTitleFromPath(full) ?? "Document", 120);
  const body = truncateText(asString(args.body) ?? asString(args.content) ?? "", 12000);
  const sections = normalizeDocumentSections(args.sections, body);
  const rows = normalizeDocumentRows(args.rows);
  const design = createArtifactDesignPlan({
    kind: documentDesignKind(format),
    title,
    body,
    sections,
    format,
    design: args.design,
    destination: args.destination,
  });
  const artifact = await createDocumentArtifact(format, {
    title,
    body,
    sections,
    rows,
    design,
  });
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (artifact.binary) {
    await fs.writeFile(full, artifact.data);
  } else {
    await fs.writeFile(full, artifact.data, "utf8");
  }
  return {
    path: full,
    bytesWritten: Buffer.isBuffer(artifact.data) ? artifact.data.length : Buffer.byteLength(artifact.data, "utf8"),
    format,
    mimeType: artifact.mimeType,
    title,
    sectionCount: sections.length,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: usedDocumentAssetIds(format, design.mode),
    }),
  };
}

async function presentationsCreate(args: Record<string, unknown>, config: ToolPolicyConfig) {
  const requestedPath = required(args.path, "path");
  const p = ensurePptxPath(requestedPath);
  assertWritePathInJail(p, config.sandbox.writeJailRoots);
  const title = truncateText(asString(args.title) ?? "Presentation", 120);
  const subtitle = truncateText(asString(args.subtitle) ?? "", 180);
  const slides = normalizePresentationSlides(args.slides, title, asString(args.body));
  const design = createArtifactDesignPlan({
    kind: "presentation",
    title,
    body: subtitle,
    slides,
    format: "pptx",
    design: normalizePresentationDesignInput(args),
    destination: args.destination,
  });
  const deckSlides: PresentationSlide[] = [
    {
      title,
      bullets: subtitle ? [subtitle] : [],
    },
    ...slides,
  ];
  const deckQuality = analyzePresentationDeckQuality(design, deckSlides);
  const visualAsset = normalizePresentationVisualAsset(args.visualAsset);
  const pptx = await createPresentationPptxWithDiagnostics({
    title,
    subtitle: subtitle || undefined,
    slides,
    design,
    visualAsset,
  });
  const full = path.resolve(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, pptx.buffer);
  return {
    path: full,
    bytesWritten: pptx.buffer.length,
    format: "pptx",
    title,
    slideCount: slides.length + 1,
    renderer: pptx.renderer,
    warnings: pptx.warnings,
    visualAsset: visualAsset
      ? {
          source: visualAsset.source,
          sourceModel: visualAsset.sourceModel,
          mimeType: visualAsset.mimeType,
        }
      : undefined,
    designReport: buildArtifactDesignReport(design, {
      localPath: full,
      usedAssetIds: pptx.usedAssetIds,
      validationResults: presentationValidationResults(deckQuality, pptx),
      residualRisks: pptx.warnings.length > 0 ? pptx.warnings : undefined,
    }),
  };
}

function presentationValidationResults(
  quality: PresentationDeckQualitySummary,
  pptx?: PresentationPptxDiagnostics,
): Record<string, Partial<Pick<ArtifactValidationCheck, "status" | "detail">>> {
  const templateWarnings = [...(quality.templateWarnings ?? []), ...(pptx?.fallbackTriggered ? pptx.warnings : [])];
  const contentWarnings = quality.contentWarnings ?? [];
  const templateStatus = templateWarnings.length > 0 ? "warning" : "passed";
  const contentDensityStatus = contentWarnings.length > 0 ? "warning" : "passed";
  const rendererSummary = Object.entries(quality.rendererCounts)
    .filter(([, count]) => count > 0)
    .map(([renderer, count]) => `${renderer}:${count}`)
    .join(", ");
  return {
    "presentation-template": {
      status: templateStatus,
      detail:
        templateStatus === "passed"
          ? `Resolved ${quality.contentSlideCount} content slide(s) through content-aware templates${
              rendererSummary ? ` (${rendererSummary})` : ""
            }.`
          : templateWarnings.join(" "),
    },
    "content-density": {
      status: contentDensityStatus,
      detail:
        contentDensityStatus === "passed"
          ? `Checked ${quality.contentSlideCount} content slide(s); sparse slides avoid forced columns and dense slides use column layouts.`
          : contentWarnings.join(" "),
    },
  };
}

function documentDesignKind(format: DocumentArtifactFormat): "document" | "html" | "pdf" | "data" {
  switch (format) {
    case "html":
      return "html";
    case "pdf":
      return "pdf";
    case "json":
    case "csv":
    case "txt":
      return "data";
    default:
      return "document";
  }
}

function normalizePresentationDesignInput(args: Record<string, unknown>): unknown {
  if (args.design !== undefined) {
    return args.design;
  }
  const theme = asString(args.theme);
  return theme ? { preset: theme } : undefined;
}

function usedDocumentAssetIds(format: DocumentArtifactFormat, mode: string): string[] {
  if (mode === "minimal" || mode === "plain") {
    return [];
  }
  switch (format) {
    case "docx":
      return ["renderer-generated-visual", "built-in-shapes-icons"];
    case "html":
      return ["built-in-shapes-icons"];
    default:
      return [];
  }
}

function resolveDocumentFormat(rawFormat: string | undefined, requestedPath: string): DocumentArtifactFormat {
  const raw = (rawFormat ?? path.extname(requestedPath).replace(/^\./, "")).trim().toLowerCase();
  switch (raw) {
    case "":
    case "md":
    case "markdown":
      return "markdown";
    case "txt":
    case "text":
      return "txt";
    case "html":
    case "htm":
      return "html";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "doc":
    case "docx":
    case "word":
      return "docx";
    case "pdf":
      return "pdf";
    default:
      throw new Error(`Unsupported document format: ${raw}`);
  }
}

function ensureDocumentPath(value: string, format: DocumentArtifactFormat): string {
  const extension = documentArtifactExtension(format);
  if (new RegExp(`${escapeRegExp(extension)}$`, "i").test(value)) {
    return value;
  }
  const parsed = path.parse(value);
  const fileName = parsed.name ? `${parsed.name}${extension}` : `document${extension}`;
  return path.join(parsed.dir, fileName);
}

function inferTitleFromPath(value: string): string | undefined {
  const baseName = path.basename(value, path.extname(value)).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!baseName) {
    return undefined;
  }
  return baseName.replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeDocumentSections(value: unknown, fallbackBody: string): DocumentArtifactSection[] {
  const rawSections = Array.isArray(value) ? value : [];
  const sections = rawSections
    .map((item, index) => {
      const section = record(item);
      const heading = truncateText(asString(section.heading) ?? asString(section.title) ?? `Section ${index + 1}`, 100);
      const body = truncateText(asString(section.body) ?? asString(section.content) ?? "", 2000);
      const bullets = normalizeDocumentBullets(section.bullets);
      return { heading, body, bullets };
    })
    .filter((section) => section.heading || section.body || section.bullets.length > 0)
    .slice(0, 40);
  if (sections.length > 0) {
    return sections;
  }
  return fallbackBody ? [{ heading: "Summary", body: fallbackBody, bullets: [] }] : [];
}

function normalizeDocumentRows(value: unknown): Array<Record<string, unknown> | unknown[]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .map((item) => (Array.isArray(item) ? item : record(item)))
    .filter((item) => (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0))
    .slice(0, 500);
}

function normalizeDocumentBullets(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
  return rawItems
    .map((item) => truncateText(asString(item) ?? "", 220))
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

function ensurePptxPath(value: string): string {
  if (/\.pptx$/i.test(value)) {
    return value;
  }
  const parsed = path.parse(value);
  const fileName = parsed.name ? `${parsed.name}.pptx` : "presentation.pptx";
  return path.join(parsed.dir, fileName);
}

function normalizePresentationSlides(
  value: unknown,
  fallbackTitle: string,
  fallbackBody?: string,
): PresentationSlide[] {
  const rawSlides = Array.isArray(value) ? value : [];
  const slides = rawSlides
    .map((item, index) => {
      const slide = record(item);
      const title = truncateText(asString(slide.title) ?? `Slide ${index + 1}`, 100);
      const bullets = normalizePresentationBullets(slide.bullets);
      return {
        title,
        bullets,
        speakerNotes: truncateText(asString(slide.speakerNotes) ?? "", 600) || undefined,
      } satisfies PresentationSlide;
    })
    .filter((slide) => slide.title || slide.bullets.length > 0)
    .slice(0, 40);
  if (slides.length > 0) {
    return slides;
  }
  const fallbackBullets = normalizePresentationBullets(fallbackBody);
  return [{ title: fallbackTitle, bullets: fallbackBullets }];
}

function normalizePresentationBullets(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n|;/g) : [];
  return rawItems
    .map((item) => truncateText(asString(item) ?? "", 180))
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function normalizePresentationVisualAsset(value: unknown): PresentationVisualAsset | undefined {
  const asset = record(value);
  const bytesBase64 = asString(asset.bytesBase64) ?? asString(asset.b64Json) ?? asString(asset.dataBase64);
  if (!bytesBase64) {
    return undefined;
  }
  const mimeType = asString(asset.mimeType) ?? "image/png";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    return undefined;
  }
  return {
    bytesBase64,
    mimeType,
    altText: truncateText(asString(asset.altText) ?? "", 220) || undefined,
    source: truncateText(asString(asset.source) ?? "", 80) || undefined,
    sourceModel: truncateText(asString(asset.sourceModel) ?? asString(asset.model) ?? "", 80) || undefined,
    revisedPrompt: truncateText(asString(asset.revisedPrompt) ?? "", 600) || undefined,
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...` : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finalizeToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const leakDetections = collectLeakDetections(result);
  const sanitized = sanitizeForModel(result);
  if (leakDetections.length === 0) {
    return sanitized;
  }
  return {
    ...sanitized,
    security: {
      sanitizedForModel: true,
      leakDetections,
    },
  };
}

async function commsInvoke(request: ToolInvokeRequest, config: ToolPolicyConfig, storage: Storage) {
  const toolName = request.toolName;
  const args = request.args;
  const grantAllowlist = resolveExecutionGrantAllowedHosts(request, storage);
  const connectionId = required(args.connectionId, "connectionId");
  const connection = storage.integrationConnections.get(connectionId);
  const target =
    asString(args.target) ?? resolveDefaultChannelTarget(connection.key, connection.config) ?? connection.key;
  const message = asString(args.message) ?? "";
  const queued = storage.commsDeliveries.createQueued({
    connectionId,
    channelKey: connection.key,
    target,
    payload: { toolName, args },
  });
  try {
    if (toolName === "gmail.read") {
      const records = await gmailRead(connection.config, args, config.sandbox.networkAllowlist, grantAllowlist);
      storage.commsDeliveries.markSent(queued.deliveryId, "gmail-read");
      return { ...queued, status: "sent", deliveryStatus: "sent", providerMessageId: "gmail-read", records };
    }
    if (toolName === "calendar.list") {
      const records = await calendarList(connection.config, args, config.sandbox.networkAllowlist, grantAllowlist);
      storage.commsDeliveries.markSent(queued.deliveryId, "calendar-list");
      return { ...queued, status: "sent", deliveryStatus: "sent", providerMessageId: "calendar-list", records };
    }
    const providerMessageId = await executeCommsTool(
      toolName,
      connection.key,
      connection.config,
      args,
      config.sandbox.networkAllowlist,
      grantAllowlist,
      target,
      message,
    );
    storage.commsDeliveries.markSent(queued.deliveryId, providerMessageId);
    return {
      ...queued,
      status: "sent",
      deliveryStatus: "sent",
      providerMessageId,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    const deliveryStatus = classifyChannelDeliveryFailure(errorMessage);
    storage.commsDeliveries.markFailed(queued.deliveryId, errorMessage);
    return {
      ...queued,
      status: "failed",
      deliveryStatus,
      error: errorMessage,
      fallbackReason: errorMessage,
      updatedAt: new Date().toISOString(),
    };
  }
}

function classifyChannelDeliveryFailure(message: string): ChannelDeliveryStatus {
  const normalized = message.toLowerCase();
  if (["408", "429", "502", "503", "504"].some((status) => normalized.includes(status))) {
    return "degraded";
  }
  if (
    ["allowlist", "blocked", "unsafe", "forbidden", "unauthorized", "http or https"].some((term) =>
      normalized.includes(term),
    )
  ) {
    return "blocked";
  }
  if (
    (normalized.includes("missing") && normalized.includes("url")) ||
    ["not supported", "does not support", "unavailable", "not configured"].some((term) => normalized.includes(term))
  ) {
    return "not_available";
  }
  return "degraded";
}

async function executeCommsTool(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist: string[] | undefined,
  target: string,
  message: string,
): Promise<string> {
  if (toolName === "gmail.send") {
    return gmailSend(connectionConfig, args, allowlist, grantAllowlist);
  }
  if (toolName === "calendar.create_event") {
    return calendarCreate(connectionConfig, args, allowlist, grantAllowlist);
  }
  if (toolName.endsWith(".react") || toolName === "channel.react") {
    return commsReact(toolName, connectionKey, connectionConfig, args, allowlist, target, grantAllowlist);
  }
  if (toolName.endsWith(".unsend") || toolName === "channel.unsend") {
    return commsUnsend(toolName, connectionKey, connectionConfig, args, allowlist, target, grantAllowlist);
  }
  const channelKey = toolName === "channel.send" ? connectionKey : toolName.slice(0, -".send".length);
  const sanitizedMessage = sanitizeCommsMessageForChannel(message, channelKey);
  const attachments = normalizeChannelAttachments(args.attachments);
  const renderedMessage = renderChannelMessage(sanitizedMessage, attachments);
  switch (channelKey) {
    case "slack":
      return slackSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "discord":
      return discordSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "line":
      return lineSend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "mattermost":
      return mattermostSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "nextcloud-talk":
      return nextcloudTalkSend(
        connectionConfig,
        args,
        allowlist,
        target,
        sanitizedMessage,
        attachments,
        grantAllowlist,
      );
    case "imessage":
      return imessageSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "signal":
      return signalSend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "telegram":
      return telegramSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "ntfy":
      return ntfySend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "teams":
      return teamsSend(connectionConfig, args, allowlist, sanitizedMessage, attachments, grantAllowlist);
    case "google-chat":
      return googleChatSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "whatsapp":
      return whatsappSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "zalo":
      return zaloSend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "zalouser":
      return zalouserSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    default:
      break;
  }
  const webhookUrl =
    asString(args.url) ??
    secretFrom(connectionConfig, "webhookUrl", "webhookUrlEnv") ??
    secretFrom(connectionConfig, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing webhook URL");
  }
  const payload = { text: renderedMessage, target, payload: record(args.payload) };
  const res = await fetchAllowlisted(
    webhookUrl,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    throw new Error(`${toolName} failed (${res.response.status})`);
  }
  return `${toolName}-${Date.now()}`;
}

function sanitizeCommsMessageForChannel(message: string, channelKey: string): string {
  return sanitizeChannelOutboundMessage(message, {
    neutralizeMentions: ["discord", "google-chat", "mattermost", "slack", "teams", "webhook"].includes(channelKey),
    maxLength: channelKey === "discord" ? 2000 : undefined,
  }).message;
}

async function commsReact(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const channelKey = toolName === "channel.react" ? connectionKey : toolName.slice(0, -".react".length);
  switch (channelKey) {
    case "slack":
      return slackReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "discord":
      return discordReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "mattermost":
      return mattermostReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "nextcloud-talk":
      return nextcloudTalkReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "telegram":
      return telegramReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "whatsapp":
      return whatsappReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "imessage":
      return imessageReact(connectionConfig, args, allowlist, target, grantAllowlist);
    default:
      throw new Error(`${toolName} is not supported for ${channelKey}`);
  }
}

async function commsUnsend(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const channelKey = toolName === "channel.unsend" ? connectionKey : toolName.slice(0, -".unsend".length);
  switch (channelKey) {
    case "slack":
      return slackUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "discord":
      return discordUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "telegram":
      return telegramUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "mattermost":
      return mattermostUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "imessage":
      return imessageUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    default:
      throw new Error(`${toolName} is not supported for ${channelKey}`);
  }
}

function resolveDefaultChannelTarget(connectionKey: string, config: Record<string, unknown>): string | undefined {
  const keys = CHANNEL_TARGET_KEYS[connectionKey] ?? ["target", "defaultTarget"];
  for (const key of keys) {
    const value = asString(config[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function renderChannelMessage(message: string, attachmentsRaw: unknown): string {
  const attachments = normalizeChannelAttachments(attachmentsRaw);
  if (attachments.length === 0) {
    return message;
  }
  const lines = attachments
    .map((attachment) => {
      const title = attachment.title;
      const url = attachment.url;
      if (title && url) {
        return `- ${title}: ${url}`;
      }
      if (url) {
        return `- ${url}`;
      }
      if (title) {
        return `- ${title}`;
      }
      if (attachment.attachmentId) {
        return `- attachment ${attachment.attachmentId}`;
      }
      if (attachment.dataBase64) {
        return "- inline attachment";
      }
      return null;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return message;
  }
  return `${message}\n\nAttachments:\n${lines.join("\n")}`;
}

type ChannelAttachment = {
  url?: string;
  title?: string;
  mimeType?: string;
  dataBase64?: string;
  attachmentId?: string;
};

function normalizeChannelAttachments(attachmentsRaw: unknown): ChannelAttachment[] {
  if (!Array.isArray(attachmentsRaw)) {
    return [];
  }
  return attachmentsRaw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((attachment) => ({
      url: asString(attachment.url),
      title: asString(attachment.title),
      mimeType: asString(attachment.mimeType),
      dataBase64: asString(attachment.dataBase64),
      attachmentId: asString(attachment.attachmentId),
    }))
    .filter((attachment) =>
      Boolean(
        attachment.url || attachment.title || attachment.mimeType || attachment.dataBase64 || attachment.attachmentId,
      ),
    );
}

async function slackSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "slack");
  const urlAttachments = attachments.filter((attachment) => Boolean(attachment.url));
  const inlineAttachments = attachments.filter((attachment) => Boolean(attachment.dataBase64));
  const renderedMessage = renderChannelMessage(message, urlAttachments);
  const blocks = buildSlackMessageBlocks(message, urlAttachments);
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  if (webhookUrl) {
    if (inlineAttachments.length > 0) {
      throw new Error(
        "Slack webhook connections do not support inline attachments; use a bot token connection instead",
      );
    }
    const res = await fetchAllowlisted(
      webhookUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: renderedMessage,
          ...(blocks ? { blocks } : {}),
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      throw new Error(`slack.send failed (${res.response.status})`);
    }
    return `slack-webhook-${Date.now()}`;
  }

  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChannel);
  const threadTs =
    asString(args.threadTs) ??
    asString(args.replyToMessageId) ??
    asString(args.replyTo) ??
    asString(config.defaultThreadTs);
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  let parentTs: string | undefined;
  let uploadChannelId = channel;
  if (message.trim() || urlAttachments.length > 0) {
    const res = await fetchAllowlisted(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel,
          text: renderedMessage,
          ...(blocks ? { blocks } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    const bodyText = await res.response.text();
    const body = parseJsonRecord(bodyText);
    if (!res.response.ok || body.ok === false) {
      throw new Error(`slack.send failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
    }
    parentTs = asString(body.ts) ?? parentTs;
    uploadChannelId = asString(body.channel) ?? uploadChannelId;
  }

  if (inlineAttachments.length > 0 && !isSlackConversationId(uploadChannelId)) {
    throw new Error(
      "Slack inline attachment uploads require a channel ID target or a text/url message that can resolve one",
    );
  }
  let uploadedFileId: string | undefined;
  for (const [index, attachment] of inlineAttachments.entries()) {
    uploadedFileId = await slackUploadAttachment(
      token,
      uploadChannelId,
      attachment,
      index,
      allowlist,
      grantAllowlist,
      threadTs ?? parentTs,
    );
  }

  return parentTs ?? uploadedFileId ?? `slack-${Date.now()}`;
}

async function slackReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? normalizeChannelTarget(target, "slack") ?? asString(config.defaultChannel);
  const timestamp = required(args.messageId, "Slack messageId");
  const reaction = normalizeSlackReaction(args.reaction);
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  const res = await fetchAllowlisted(
    "https://slack.com/api/reactions.add",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        timestamp,
        name: reaction,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`slack.react failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
  }
  return timestamp;
}

async function slackUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? normalizeChannelTarget(target, "slack") ?? asString(config.defaultChannel);
  const timestamp = required(args.messageId, "Slack messageId");
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  const res = await fetchAllowlisted(
    "https://slack.com/api/chat.delete",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        ts: timestamp,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`slack.unsend failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
  }
  return timestamp;
}

async function discordSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "discord");
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  const discordRequest = await buildDiscordMessageRequest(message, attachments, allowlist, grantAllowlist);
  if (webhookUrl) {
    const res = await fetchAllowlisted(
      appendDiscordWebhookQuery(webhookUrl, "wait", "true"),
      {
        method: "POST",
        headers: discordRequest.headers,
        body: discordRequest.body,
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      throw new Error(`discord.send failed (${res.response.status})`);
    }
    const body = parseJsonRecord(await res.response.text());
    return asString(body.id) ?? `discord-webhook-${Date.now()}`;
  }

  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channelId = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChannelId);
  if (!token) {
    throw new Error("Missing Discord bot token");
  }
  if (!channelId) {
    throw new Error("Missing Discord channel target");
  }
  const res = await fetchAllowlisted(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        ...(discordRequest.headers ?? {}),
      },
      body: discordRequest.body,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`discord.send failed (${res.response.status})`);
  }
  const body = parseJsonRecord(bodyText);
  return asString(body.id) ?? `discord-${Date.now()}`;
}

async function discordReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channelId =
    asString(args.target) ?? normalizeChannelTarget(target, "discord") ?? asString(config.defaultChannelId);
  const messageId = required(args.messageId, "Discord messageId");
  const emoji = required(args.reaction, "Discord reaction");
  if (!token) {
    throw new Error("Missing Discord bot token");
  }
  if (!channelId) {
    throw new Error("Missing Discord channel target");
  }
  const res = await fetchAllowlisted(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeDiscordEmoji(emoji)}/@me`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    const bodyText = await res.response.text();
    throw new Error(`discord.react failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  return messageId;
}

async function discordUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const messageId = required(args.messageId, "Discord messageId");
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  if (token) {
    const channelId =
      asString(args.target) ?? normalizeChannelTarget(target, "discord") ?? asString(config.defaultChannelId);
    if (!channelId) {
      throw new Error("Missing Discord channel target");
    }
    const res = await fetchAllowlisted(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bot ${token}`,
        },
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      const bodyText = await res.response.text();
      throw new Error(`discord.unsend failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
    }
    return messageId;
  }
  if (!webhookUrl) {
    throw new Error("Missing Discord bot token or webhook URL");
  }
  const deleteUrl = `${appendDiscordWebhookQuery(webhookUrl.replace(/\/+$/, ""), "wait", "true").replace(/\?wait=true$/, "")}/messages/${encodeURIComponent(messageId)}`;
  const res = await fetchAllowlisted(deleteUrl, { method: "DELETE" }, allowlist, undefined, grantAllowlist);
  if (!res.response.ok) {
    const bodyText = await res.response.text();
    throw new Error(`discord.unsend failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  return messageId;
}

async function buildDiscordMessageRequest(
  message: string,
  attachments: ChannelAttachment[],
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<{ headers?: Record<string, string>; body: BodyInit }> {
  const embeds = buildDiscordEmbeds(attachments);
  const uploadableAttachments = attachments.filter((attachment) => Boolean(attachment.dataBase64));
  const payload: Record<string, unknown> = {};
  if (message.trim()) {
    payload.content = message;
  }
  payload.allowed_mentions = { parse: [] };
  if (embeds.length > 0) {
    payload.embeds = embeds;
  }
  if (uploadableAttachments.length === 0) {
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  }

  const formData = new FormData();
  formData.append("payload_json", JSON.stringify(payload));
  for (const [index, attachment] of uploadableAttachments.entries()) {
    const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Discord", grantAllowlist);
    const fileName = resolveChannelAttachmentName(attachment, index);
    const blobBytes = new Uint8Array(attachmentData.bytes.length);
    blobBytes.set(attachmentData.bytes);
    formData.append(
      `files[${index}]`,
      new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
      fileName,
    );
  }
  return { body: formData };
}

function buildDiscordEmbeds(attachments: ChannelAttachment[]): Array<Record<string, unknown>> {
  return attachments
    .filter((attachment) => Boolean(attachment.url))
    .slice(0, 10)
    .map((attachment) => {
      const url = required(attachment.url, "Discord embed attachment URL");
      const embed: Record<string, unknown> = {};
      const title = asString(attachment.title);
      if (title) {
        embed.title = title;
      }
      if (title || !isImageChannelAttachment(attachment)) {
        embed.url = url;
      }
      if (isImageChannelAttachment(attachment)) {
        embed.image = { url };
      } else {
        embed.description = url;
      }
      return embed;
    });
}

function buildSlackMessageBlocks(
  message: string,
  attachments: ChannelAttachment[],
): Array<Record<string, unknown>> | undefined {
  const blocks: Array<Record<string, unknown>> = [];
  if (message.trim()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: message,
      },
    });
  }

  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    const title = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      const imageBlock: Record<string, unknown> = {
        type: "image",
        image_url: url,
        alt_text: title || "attachment",
      };
      if (title) {
        imageBlock.title = { type: "plain_text", text: title };
      }
      blocks.push(imageBlock);
      continue;
    }
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: title && title !== url ? `*<${url}|${title}>*` : `<${url}>`,
      },
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

function buildTeamsWebhookPayload(
  title: string,
  message: string,
  attachments: ChannelAttachment[],
): Record<string, unknown> {
  const unsupportedInline = attachments.some((attachment) => Boolean(attachment.dataBase64));
  if (unsupportedInline) {
    throw new Error("Teams webhook connections only support URL-backed attachments");
  }

  const body: Array<Record<string, unknown>> = [{ type: "TextBlock", text: title, weight: "Bolder", wrap: true }];
  if (message.trim()) {
    body.push({ type: "TextBlock", text: message, wrap: true });
  }

  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    const label = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      body.push({
        type: "Image",
        url,
        altText: label,
        size: "Medium",
      });
      continue;
    }
    body.push({
      type: "TextBlock",
      text: `[${label}](${url})`,
      wrap: true,
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          type: "AdaptiveCard",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

function buildGoogleChatWebhookPayload(message: string, attachments: ChannelAttachment[]): Record<string, unknown> {
  const unsupportedInline = attachments.some((attachment) => Boolean(attachment.dataBase64));
  if (unsupportedInline) {
    throw new Error("Google Chat webhook connections only support URL-backed attachments");
  }
  const widgets: Array<Record<string, unknown>> = [];
  if (message.trim()) {
    widgets.push({
      textParagraph: { text: message },
    });
  }
  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    const label = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      widgets.push({
        image: {
          imageUrl: url,
          altText: label,
        },
      });
      continue;
    }
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: label,
            onClick: {
              openLink: { url },
            },
          },
        ],
      },
    });
  }

  if (widgets.length === 0) {
    return { text: message };
  }

  return {
    text: message || "Attachment update",
    cardsV2: [
      {
        cardId: "goatcitadel-delivery",
        card: {
          sections: [
            {
              widgets,
            },
          ],
        },
      },
    ],
  };
}

async function lineSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeLineTarget(
    asString(args.target) ?? normalizeChannelTarget(target, "line") ?? resolveDefaultChannelTarget("line", config),
  );
  const channelAccessToken =
    secretFrom(config, "channelAccessToken", "channelAccessTokenEnv") ??
    secretFrom(config, "accessToken", "accessTokenEnv") ??
    secretFrom(config, "token", "tokenEnv");
  if (!channelAccessToken) {
    throw new Error("Missing LINE channel access token");
  }
  if (!resolvedTarget) {
    throw new Error("Missing LINE target");
  }

  const chunks = chunkText(message, 5000, 0, 20);
  if (chunks.length === 0) {
    throw new Error("Missing LINE message");
  }

  let requestId: string | undefined;
  for (let index = 0; index < chunks.length; index += 5) {
    const messages = chunks.slice(index, index + 5).map((text) => ({ type: "text", text }));
    const res = await fetchAllowlisted(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: resolvedTarget,
          messages,
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      throw new Error(`line.send failed (${res.response.status})`);
    }
    requestId = res.response.headers.get("x-line-request-id") ?? requestId;
  }

  return requestId ?? `line-${Date.now()}`;
}

async function telegramSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "telegram");
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChatId);
  const replyToMessageId = parseOptionalIntegerLike(args.replyToMessageId ?? args.replyTo);
  const replyMarkup = normalizeTelegramInlineKeyboard(args.interactiveActions);
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }

  if (attachments.length === 0) {
    return telegramSendText(config, allowlist, token, chatId, message, replyToMessageId, replyMarkup, grantAllowlist);
  }

  let lastMessageId: string | undefined;
  let caption = message.trim() || undefined;
  if (caption && caption.length > 1024) {
    lastMessageId = await telegramSendText(
      config,
      allowlist,
      token,
      chatId,
      message,
      replyToMessageId,
      undefined,
      grantAllowlist,
    );
    caption = undefined;
  }
  for (const [index, attachment] of attachments.entries()) {
    lastMessageId = await telegramSendAttachment(
      config,
      allowlist,
      token,
      chatId,
      attachment,
      index,
      caption,
      index === 0 ? replyToMessageId : undefined,
      grantAllowlist,
    );
    caption = undefined;
  }
  return lastMessageId ?? `telegram-${Date.now()}`;
}

async function telegramUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? normalizeChannelTarget(target, "telegram") ?? asString(config.defaultChatId);
  const messageId = required(args.messageId, "Telegram messageId");
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/deleteMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: Number.parseInt(messageId, 10),
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(
      `telegram.unsend failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`,
    );
  }
  return messageId;
}

async function telegramReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? normalizeChannelTarget(target, "telegram") ?? asString(config.defaultChatId);
  const messageId = required(args.messageId, "Telegram messageId");
  const reaction = required(args.reaction, "Telegram reaction").trim();
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/setMessageReaction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: Number.parseInt(messageId, 10),
        reaction: [{ type: "emoji", emoji: reaction }],
        is_big: args.isBig === true ? true : undefined,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`telegram.react failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`);
  }
  return messageId;
}

function normalizeTelegramInlineKeyboard(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const recordValue = value as Record<string, unknown>;
  if (recordValue.platform !== undefined && asString(recordValue.platform) !== "telegram") {
    return undefined;
  }
  if (!Array.isArray(recordValue.buttons)) {
    return undefined;
  }
  const buttons = recordValue.buttons
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const button = item as Record<string, unknown>;
      const text = asString(button.label);
      const callbackData = asString(button.callbackData);
      return text && callbackData ? { text, callback_data: callbackData } : undefined;
    })
    .filter((item): item is { text: string; callback_data: string } => Boolean(item))
    .slice(0, 8);
  return buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;
}

async function telegramSendText(
  config: Record<string, unknown>,
  allowlist: string[],
  token: string,
  chatId: string,
  message: string,
  replyToMessageId?: number,
  replyMarkup?: Record<string, unknown>,
  grantAllowlist?: string[],
): Promise<string> {
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: asString(config.parseMode) ?? undefined,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
        reply_markup: replyMarkup,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`telegram.send failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`);
  }
  const result = record(body.result);
  return providerMessageIdFromValue(result.message_id) ?? `telegram-${Date.now()}`;
}

async function telegramSendAttachment(
  config: Record<string, unknown>,
  allowlist: string[],
  token: string,
  chatId: string,
  attachment: ChannelAttachment,
  index: number,
  caption: string | undefined,
  replyToMessageId?: number,
  grantAllowlist?: string[],
): Promise<string> {
  const parseMode = asString(config.parseMode) ?? undefined;
  const isImage = isImageChannelAttachment(attachment);
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";
  let body: BodyInit;
  let headers: Record<string, string> | undefined;

  if (attachment.dataBase64) {
    const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Telegram", grantAllowlist);
    const fileName = resolveChannelAttachmentName(attachment, index);
    const blobBytes = new Uint8Array(attachmentData.bytes.length);
    blobBytes.set(attachmentData.bytes);
    const formData = new FormData();
    formData.set("chat_id", chatId);
    formData.set(
      field,
      new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
      fileName,
    );
    if (caption) {
      formData.set("caption", caption);
    }
    if (parseMode) {
      formData.set("parse_mode", parseMode);
    }
    if (replyToMessageId) {
      formData.set("reply_parameters", JSON.stringify({ message_id: replyToMessageId }));
    }
    body = formData;
  } else {
    body = JSON.stringify({
      chat_id: chatId,
      [field]: required(attachment.url, "Telegram attachment URL"),
      caption,
      parse_mode: parseMode,
      reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
    });
    headers = { "Content-Type": "application/json" };
  }

  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers,
      body,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const payload = parseJsonRecord(bodyText);
  if (!res.response.ok || payload.ok === false) {
    throw new Error(
      `telegram.send failed (${res.response.status})${payload.description ? `: ${payload.description}` : ""}`,
    );
  }
  const result = record(payload.result);
  return providerMessageIdFromValue(result.message_id) ?? `telegram-${Date.now()}`;
}

async function ntfySend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl) ?? "https://ntfy.sh";
  const topic = asString(args.target) ?? normalizeChannelTarget(target, "ntfy") ?? asString(config.topic);
  if (!topic) {
    throw new Error("Missing ntfy topic");
  }
  if (isEnabledFlag(args.dryRun) || isEnabledFlag(config.dryRun)) {
    return `ntfy-dry-run-${Date.now()}`;
  }
  const token = secretFrom(config, "token", "tokenEnv");
  const priority = clampInt(args.priority ?? config.priority, 3, 1, 5);
  const title = asString(args.title) ?? asString(config.title) ?? "GoatCitadel";
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Priority: String(priority),
    Title: title,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchAllowlisted(
    buildNtfyPublishUrl(baseUrl, topic),
    {
      method: "POST",
      headers,
      body: message,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`ntfy.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const messageId = res.response.headers.get("x-message-id") ?? asString(parseJsonRecord(bodyText).id);
  return messageId ?? `ntfy-${Date.now()}`;
}

function buildNtfyPublishUrl(baseUrl: string, topic: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/${encodeURIComponent(topic)}`;
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || asString(value)?.toLowerCase() === "true";
}

function parseOptionalIntegerLike(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = parseIntegerLike(value);
  if (parsed === undefined) {
    throw new Error("Expected an integer-like reply target");
  }
  return parsed;
}

async function teamsSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const webhookUrl =
    asString(args.url) ?? secretFrom(config, "webhookUrl", "webhookUrlEnv") ?? secretFrom(config, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing Teams webhook URL");
  }
  const title = asString(config.cardTitle) ?? "GoatCitadel";
  const payload = buildTeamsWebhookPayload(title, message, attachments);
  const res = await fetchAllowlisted(
    webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    throw new Error(`teams.send failed (${res.response.status})`);
  }
  return `teams-${Date.now()}`;
}

async function googleChatSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "google-chat");
  const webhookUrl =
    asString(args.url) ?? secretFrom(config, "webhookUrl", "webhookUrlEnv") ?? secretFrom(config, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing Google Chat webhook URL");
  }
  const url = new URL(webhookUrl);
  const threadKey = asString(args.target) ?? resolvedTarget ?? asString(config.defaultThreadKey);
  if (threadKey) {
    url.searchParams.set("threadKey", threadKey);
  }
  const res = await fetchAllowlisted(
    url.toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGoogleChatWebhookPayload(message, attachments)),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`google-chat.send failed (${res.response.status})`);
  }
  const body = parseJsonRecord(bodyText);
  return asString(body.name) ?? `google-chat-${Date.now()}`;
}

async function whatsappSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const phoneNumberId = asString(config.phoneNumberId) ?? asString(config.senderId);
  const resolvedTarget = normalizeWhatsAppTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "whatsapp") ??
      resolveDefaultChannelTarget("whatsapp", config),
  );
  const baseUrl = normalizeWhatsAppBaseUrl(asString(config.baseUrl), asString(config.apiVersion));
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }
  if (!phoneNumberId) {
    throw new Error("Missing WhatsApp phone number id");
  }
  if (!resolvedTarget) {
    throw new Error("Missing WhatsApp target");
  }
  if (isWhatsAppGroupTarget(resolvedTarget)) {
    throw new Error("WhatsApp Cloud API sender only supports direct recipients, not group JIDs");
  }

  const richAttachments = attachments.filter((attachment) => Boolean(attachment.url || attachment.dataBase64));
  const inlineOnlyAttachments = attachments.filter((attachment) => !attachment.url && !attachment.dataBase64);
  const outboundMessage = renderChannelMessage(message, inlineOnlyAttachments);
  const recipient = normalizeWhatsAppRecipient(resolvedTarget);

  let providerMessageId: string | undefined;
  if (outboundMessage.trim()) {
    providerMessageId = await whatsappSendPayload(
      baseUrl,
      phoneNumberId,
      accessToken,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { body: outboundMessage },
      },
      allowlist,
      grantAllowlist,
    );
  }

  for (let index = 0; index < richAttachments.length; index += 1) {
    const attachment = richAttachments[index] as ChannelAttachment;
    providerMessageId = await whatsappSendAttachment(
      baseUrl,
      phoneNumberId,
      accessToken,
      recipient,
      attachment,
      index,
      allowlist,
      grantAllowlist,
    );
  }

  if (!providerMessageId) {
    throw new Error("WhatsApp send requires a message or attachment");
  }
  return providerMessageId;
}

async function whatsappReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const phoneNumberId = asString(config.phoneNumberId) ?? asString(config.senderId);
  const resolvedTarget = normalizeWhatsAppTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "whatsapp") ??
      resolveDefaultChannelTarget("whatsapp", config),
  );
  const messageId = required(asString(args.messageId), "WhatsApp messageId");
  const reaction = required(asString(args.reaction), "WhatsApp reaction").trim();
  const baseUrl = normalizeWhatsAppBaseUrl(asString(config.baseUrl), asString(config.apiVersion));
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }
  if (!phoneNumberId) {
    throw new Error("Missing WhatsApp phone number id");
  }
  if (!resolvedTarget) {
    throw new Error("Missing WhatsApp target");
  }
  if (isWhatsAppGroupTarget(resolvedTarget)) {
    throw new Error("WhatsApp Cloud API sender only supports direct recipients, not group JIDs");
  }

  return whatsappSendPayload(
    baseUrl,
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppRecipient(resolvedTarget),
      type: "reaction",
      reaction: {
        message_id: messageId,
        emoji: reaction,
      },
    },
    allowlist,
    grantAllowlist,
  );
}

async function mattermostSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const resolvedTarget =
    asString(args.target) ??
    normalizeChannelTarget(target, "mattermost") ??
    resolveDefaultChannelTarget("mattermost", config);
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  if (!resolvedTarget) {
    throw new Error("Missing Mattermost target");
  }

  const parsedTarget = parseMattermostTarget(resolvedTarget);
  const botUser = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/users/me",
    allowlist,
    undefined,
    grantAllowlist,
  );
  const botUserId = required(botUser.id, "Mattermost bot user id");
  const channelId = await resolveMattermostChannelId(
    serverUrl,
    botToken,
    parsedTarget,
    botUserId,
    asString(args.team) ?? asString(config.defaultTeam),
    allowlist,
    grantAllowlist,
  );

  let fileIds: string[] | undefined;
  if (attachments.length > 0) {
    fileIds = [];
    for (const [index, attachment] of attachments.entries()) {
      const fileId = await mattermostUploadAttachment(
        serverUrl,
        botToken,
        channelId,
        attachment,
        index,
        allowlist,
        grantAllowlist,
      );
      fileIds.push(fileId);
    }
  }

  const post = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/posts",
    allowlist,
    {
      method: "POST",
      body: JSON.stringify({
        channel_id: channelId,
        message,
        ...(fileIds && fileIds.length > 0 ? { file_ids: fileIds } : {}),
      }),
    },
    grantAllowlist,
  );
  return asString(post.id) ?? `mattermost-${Date.now()}`;
}

async function mattermostReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  _target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const postId = required(args.messageId, "Mattermost messageId");
  const reaction = normalizeColonWrappedReaction(required(args.reaction, "Mattermost reaction"));
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  const botUser = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/users/me",
    allowlist,
    undefined,
    grantAllowlist,
  );
  const botUserId = required(botUser.id, "Mattermost bot user id");
  await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/reactions",
    allowlist,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: botUserId,
        post_id: postId,
        emoji_name: reaction,
      }),
    },
    grantAllowlist,
  );
  return postId;
}

async function mattermostUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  _target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const postId = required(args.messageId, "Mattermost messageId");
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  await mattermostApiRequest<void>(
    serverUrl,
    botToken,
    `/posts/${encodeURIComponent(postId)}`,
    allowlist,
    {
      method: "DELETE",
    },
    grantAllowlist,
  );
  return postId;
}

async function signalSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = normalizeSignalBaseUrl(asString(config.baseUrl) ?? asString(config.bridgeUrl));
  const account =
    asString(args.account) ?? asString(args.accountId) ?? asString(config.account) ?? asString(config.accountId);
  const resolvedTarget = normalizeSignalTarget(
    asString(args.target) ?? normalizeChannelTarget(target, "signal") ?? resolveDefaultChannelTarget("signal", config),
  );
  const outboundMessage = required(message, "Signal message");
  if (!baseUrl) {
    throw new Error("Missing Signal base URL");
  }
  if (!resolvedTarget) {
    throw new Error("Missing Signal target");
  }

  const params: Record<string, unknown> = {
    message: outboundMessage,
    ...buildSignalTargetParams(resolvedTarget),
  };
  if (account) {
    params.account = account;
  }

  const result = await signalRpcRequest<Record<string, unknown> | undefined>(
    baseUrl,
    "send",
    params,
    allowlist,
    grantAllowlist,
  );
  return result?.timestamp != null ? String(result.timestamp) : `signal-${Date.now()}`;
}

async function imessageSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = normalizeBlueBubblesBaseUrl(
    asString(config.bridgeUrl) ?? asString(config.baseUrl) ?? asString(config.serverUrl),
  );
  const password = secretFrom(config, "password", "passwordEnv") ?? secretFrom(config, "apiPassword", "apiPasswordEnv");
  const resolvedTarget =
    asString(args.target) ??
    normalizeChannelTarget(target, "imessage") ??
    resolveDefaultChannelTarget("imessage", config);
  if (!baseUrl) {
    throw new Error("Missing iMessage bridge URL");
  }
  if (!password) {
    throw new Error("Missing iMessage bridge password");
  }
  if (!resolvedTarget) {
    throw new Error("Missing iMessage target");
  }

  const parsedTarget = parseBlueBubblesTarget(resolvedTarget);
  const richAttachments = attachments.filter((attachment) => Boolean(attachment.url || attachment.dataBase64));
  const inlineOnlyAttachments = attachments.filter((attachment) => !attachment.url);
  const inlineMessage = renderChannelMessage(message, inlineOnlyAttachments);
  let chatGuid = await resolveBlueBubblesChatGuid(baseUrl, password, parsedTarget, allowlist, grantAllowlist);
  if (!chatGuid) {
    if (parsedTarget.kind === "handle") {
      if (richAttachments.length > 0) {
        await blueBubblesCreateChat(baseUrl, password, parsedTarget.address, undefined, allowlist, grantAllowlist);
        chatGuid = await resolveBlueBubblesChatGuid(baseUrl, password, parsedTarget, allowlist, grantAllowlist);
        if (!chatGuid) {
          throw new Error("BlueBubbles send failed: created chat could not be resolved for attachment send");
        }
      } else {
        return blueBubblesCreateChat(
          baseUrl,
          password,
          parsedTarget.address,
          required(inlineMessage, "iMessage message"),
          allowlist,
          grantAllowlist,
        );
      }
    }
  }

  if (!chatGuid) {
    throw new Error("BlueBubbles send failed: chatGuid not found for target");
  }

  const replyToMessageGuid = asString(args.replyToMessageGuid) ?? asString(args.replyTo);
  const replyToPartIndex = parseIntegerLike(args.replyToPartIndex ?? args.partIndex);
  const effectId = asString(args.effectId) ?? asString(args.effect);
  const subject = asString(args.subject);

  if (richAttachments.length === 0) {
    return blueBubblesSendText(
      baseUrl,
      password,
      {
        chatGuid,
        message: required(inlineMessage, "iMessage message"),
        replyToMessageGuid,
        replyToPartIndex,
        effectId,
      },
      allowlist,
      grantAllowlist,
    );
  }

  const uploadedAttachments: BlueBubblesMultipartAttachmentPart[] = [];
  for (let index = 0; index < richAttachments.length; index += 1) {
    const attachment = richAttachments[index] as ChannelAttachment;
    uploadedAttachments.push(
      await blueBubblesUploadAttachment(baseUrl, password, attachment, allowlist, index, grantAllowlist),
    );
  }

  return blueBubblesSendMultipart(
    baseUrl,
    password,
    {
      chatGuid,
      message: inlineMessage.trim() ? inlineMessage : undefined,
      attachments: uploadedAttachments,
      replyToMessageGuid,
      replyToPartIndex,
      effectId,
      subject,
    },
    allowlist,
    grantAllowlist,
  );
}

async function imessageReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const context = resolveBlueBubblesContext(config, args, target, "Missing iMessage target");
  const parsedTarget = parseBlueBubblesTarget(context.resolvedTarget);
  const chatGuid = await resolveBlueBubblesChatGuid(
    context.baseUrl,
    context.password,
    parsedTarget,
    allowlist,
    grantAllowlist,
  );
  if (!chatGuid) {
    throw new Error("BlueBubbles react failed: chatGuid not found for target");
  }
  const messageId = asString(args.messageId) ?? asString(args.messageGuid) ?? asString(args.selectedMessageGuid);
  const reaction = asString(args.reaction);
  const partIndex = parseIntegerLike(args.partIndex);
  return blueBubblesSendReaction(
    context.baseUrl,
    context.password,
    {
      chatGuid,
      messageId: required(messageId, "iMessage messageId"),
      reaction: required(reaction, "iMessage reaction"),
      partIndex,
      messageText: asString(args.messageText) ?? asString(args.selectedMessageText),
    },
    allowlist,
    grantAllowlist,
  );
}

async function imessageUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const context = resolveBlueBubblesContext(config, args, target, "");
  return blueBubblesUnsendMessage(
    context.baseUrl,
    context.password,
    {
      messageId: required(asString(args.messageId) ?? asString(args.messageGuid), "iMessage messageId"),
      partIndex: parseIntegerLike(args.partIndex),
    },
    allowlist,
    grantAllowlist,
  );
}

async function nextcloudTalkSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl);
  const secret =
    secretFrom(config, "token", "tokenEnv") ??
    secretFrom(config, "botSecret", "botSecretEnv") ??
    secretFrom(config, "secret", "secretEnv");
  const roomToken = normalizeNextcloudTalkTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "nextcloud-talk") ??
      resolveDefaultChannelTarget("nextcloud-talk", config),
  );
  const replyTo = asString(args.replyTo);
  const outboundMessage = required(message, "Nextcloud Talk message");
  if (!baseUrl) {
    throw new Error("Missing Nextcloud Talk base URL");
  }
  if (!secret) {
    throw new Error("Missing Nextcloud Talk token");
  }
  if (!roomToken) {
    throw new Error("Missing Nextcloud Talk target");
  }
  if (attachments.length > 0) {
    throw new Error("Nextcloud Talk does not support attachments in this adapter");
  }

  const payload: Record<string, unknown> = { message: outboundMessage };
  if (replyTo) {
    payload.replyTo = replyTo;
  }
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + outboundMessage)
    .digest("hex");
  const res = await fetchAllowlisted(
    `${baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`nextcloud-talk.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const body = parseJsonRecord(bodyText);
  const ocs = record(body.ocs);
  const data = record(ocs.data);
  return data.id != null ? String(data.id) : `nextcloud-talk-${Date.now()}`;
}

async function nextcloudTalkReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl);
  const secret =
    secretFrom(config, "token", "tokenEnv") ??
    secretFrom(config, "botSecret", "botSecretEnv") ??
    secretFrom(config, "secret", "secretEnv");
  const roomToken = normalizeNextcloudTalkTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "nextcloud-talk") ??
      resolveDefaultChannelTarget("nextcloud-talk", config),
  );
  const messageId = required(asString(args.messageId), "Nextcloud Talk messageId");
  const reaction = required(asString(args.reaction), "Nextcloud Talk reaction");
  if (!baseUrl) {
    throw new Error("Missing Nextcloud Talk base URL");
  }
  if (!secret) {
    throw new Error("Missing Nextcloud Talk token");
  }
  if (!roomToken) {
    throw new Error("Missing Nextcloud Talk target");
  }

  const payload = { reaction };
  const bodyText = JSON.stringify(payload);
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + bodyText)
    .digest("hex");
  const res = await fetchAllowlisted(
    `${baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/reaction/${encodeURIComponent(messageId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: bodyText,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const responseText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`nextcloud-talk.react failed (${res.response.status})${responseText ? `: ${responseText}` : ""}`);
  }
  return messageId;
}

async function zaloSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = normalizeZaloTarget(
    asString(args.target) ?? normalizeChannelTarget(target, "zalo") ?? resolveDefaultChannelTarget("zalo", config),
  );
  const outboundMessage = required(message, "Zalo message");
  if (!accessToken) {
    throw new Error("Missing Zalo access token");
  }
  if (!chatId) {
    throw new Error("Missing Zalo target");
  }

  const chunks = chunkText(outboundMessage, 2000, 0, 20);
  let messageId: string | undefined;
  for (const chunk of chunks) {
    const res = await fetchAllowlisted(
      "https://openapi.zalo.me/v2.0/oa/message",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: accessToken },
        body: JSON.stringify({
          recipient: { user_id: chatId },
          message: { text: chunk },
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    const bodyText = await res.response.text();
    const body = parseJsonRecord(bodyText);
    if (!res.response.ok || isZaloApiErrorPayload(body)) {
      const description = readZaloApiErrorDescription(body);
      throw new Error(`zalo.send failed (${res.response.status})${description ? `: ${description}` : ""}`);
    }
    messageId = readZaloMessageId(body) ?? messageId;
  }

  return messageId ?? `zalo-${Date.now()}`;
}

async function zalouserSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = normalizeZcaBaseUrl(
    asString(config.baseUrl) ?? asString(config.bridgeUrl) ?? asString(config.serverUrl),
  );
  const profile =
    asString(args.profile) ?? asString(config.profile) ?? asString(config.accountId) ?? asString(config.account);
  const resolvedTarget =
    asString(args.target) ??
    normalizeChannelTarget(target, "zalouser") ??
    resolveDefaultChannelTarget("zalouser", config);
  const authorization = resolveZcaAuthorizationHeader(config);
  const outboundMessage = required(message, "Zalo User message");
  if (!baseUrl) {
    throw new Error("Missing Zalo User bridge URL");
  }
  if (!resolvedTarget) {
    throw new Error("Missing Zalo User target");
  }

  const parsedTarget = parseZalouserTarget(resolvedTarget);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) {
    headers.Authorization = authorization;
  }
  const profilePrefix = profile ? `/api/${encodeURIComponent(profile)}` : "/api";
  const richAttachments = attachments.filter((attachment) => Boolean(attachment.url));
  const inlineOnlyAttachments = attachments.filter((attachment) => !attachment.url);
  const inlineMessage = renderChannelMessage(outboundMessage, inlineOnlyAttachments);

  if (richAttachments.length === 0) {
    return zcaSendText(baseUrl, profilePrefix, headers, parsedTarget, inlineMessage, allowlist, grantAllowlist);
  }

  let lastMessageId: string | undefined;
  let caption: string | undefined = inlineMessage.trim() ? inlineMessage : undefined;
  for (const attachment of richAttachments) {
    lastMessageId = await zcaSendAttachment(
      baseUrl,
      profilePrefix,
      headers,
      parsedTarget,
      attachment,
      caption,
      allowlist,
      grantAllowlist,
    );
    caption = undefined;
  }
  return lastMessageId ?? `zalouser-${Date.now()}`;
}

function parseJsonRecord(bodyText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return record(parsed);
  } catch {
    return {};
  }
}

function appendDiscordWebhookQuery(webhookUrl: string, key: string, value: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

function encodeDiscordEmoji(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeSlackReaction(value: unknown): string {
  return normalizeColonWrappedReaction(required(value, "Slack reaction"));
}

function isSlackConversationId(value: string): boolean {
  return /^[CDGU][A-Z0-9]+$/i.test(value.trim());
}

function normalizeColonWrappedReaction(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^:/, "").replace(/:$/, "");
}

function providerMessageIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeChannelTarget(target: string | undefined, channelKey: string): string | undefined {
  if (!target || target === channelKey) {
    return undefined;
  }
  return target;
}

const CHANNEL_TARGET_KEYS: Record<string, string[]> = {
  slack: ["defaultChannel", "defaultTarget", "target"],
  discord: ["defaultChannelId", "defaultTarget", "target"],
  telegram: ["defaultChatId", "defaultTarget", "target"],
  ntfy: ["topic", "defaultTopic", "defaultTarget", "target"],
  "google-chat": ["defaultThreadKey", "defaultTarget", "target"],
  whatsapp: ["defaultTarget", "defaultRecipient", "target"],
  signal: ["defaultRecipient", "defaultTarget", "target"],
  imessage: ["defaultHandle", "defaultTarget", "target"],
  mattermost: ["defaultChannel", "defaultTarget", "target"],
  "nextcloud-talk": ["defaultRoomId", "defaultConversationId", "defaultTarget", "target"],
  line: ["defaultTarget", "defaultUserId", "defaultGroupId", "defaultRoomId", "target"],
  zalo: ["defaultRecipientId", "defaultTarget", "target"],
  zalouser: ["defaultRecipientId", "defaultTarget", "target"],
};

type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

type BlueBubblesTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; address: string; service: "imessage" | "sms" | "auto" };

type ZalouserTarget = {
  threadId: string;
  isGroup: boolean;
};

function normalizeLineTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^line:(?:user|group|room):/i, "")
    .replace(/^line:/i, "")
    .trim();
}

function validateWhatsAppBaseUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const isAllowedMetaHost =
      hostname === "graph.facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "facebook.com" ||
      hostname.endsWith(".meta.com") ||
      hostname === "meta.com";

    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

    if (!isAllowedMetaHost && !isLoopback) {
      throw new Error(`WhatsApp outbound URL host "${parsed.hostname}" is not an allowed Meta or localhost domain.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not an allowed Meta or localhost domain")) {
      throw error;
    }
    throw new Error(`Invalid WhatsApp baseUrl: ${url}`, { cause: error });
  }
}

function normalizeWhatsAppBaseUrl(baseUrl: string | undefined, apiVersion: string | undefined): string {
  const trimmedBaseUrl = asString(baseUrl)?.trim();
  let result: string;
  if (trimmedBaseUrl) {
    result = trimmedBaseUrl.replace(/\/+$/, "");
  } else {
    const normalizedVersion = asString(apiVersion)?.trim() ?? "v23.0";
    result = `https://graph.facebook.com/${normalizedVersion.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }
  validateWhatsAppBaseUrl(result);
  return result;
}

function normalizeSignalBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = asString(baseUrl)?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function normalizeBlueBubblesBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = asString(baseUrl)?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function normalizeSignalTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^signal:/i, "").trim();
}

function normalizeZcaBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = asString(baseUrl)?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function normalizeWhatsAppTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  let candidate = trimmed;
  for (;;) {
    const next = candidate.replace(/^whatsapp:/i, "").trim();
    if (next === candidate) {
      break;
    }
    candidate = next;
  }
  if (!candidate) {
    return undefined;
  }
  const lower = candidate.toLowerCase();
  if (lower.endsWith("@g.us")) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return /^[0-9]+(?:-[0-9]+)*$/u.test(localPart) ? `${localPart}@g.us` : undefined;
  }
  const userMatch = candidate.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i) ?? candidate.match(/^(\d+)@lid$/i);
  if (userMatch) {
    return `+${userMatch[1]}`;
  }
  if (candidate.includes("@")) {
    return undefined;
  }
  const digits = candidate.replace(/[^\d]/g, "");
  return digits.length >= 2 ? `+${digits}` : undefined;
}

function isWhatsAppGroupTarget(target: string): boolean {
  return target.toLowerCase().endsWith("@g.us");
}

function normalizeWhatsAppRecipient(target: string): string {
  return target.replace(/[^\d]/g, "");
}

function resolveWhatsAppAttachmentType(attachment: ChannelAttachment): "audio" | "document" | "image" | "video" {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }

  const candidate = `${asString(attachment.title) ?? ""} ${asString(attachment.url) ?? ""}`.toLowerCase();
  if (/\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:$|[?#\s])/i.test(candidate)) {
    return "image";
  }
  if (/\.(mov|mp4|m4v|mkv|webm)(?:$|[?#\s])/i.test(candidate)) {
    return "video";
  }
  if (/\.(aac|m4a|mp3|oga|ogg|wav)(?:$|[?#\s])/i.test(candidate)) {
    return "audio";
  }
  return "document";
}

function normalizeNextcloudTalkTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
    .replace(/^room:/i, "")
    .trim();
}

function normalizeZaloTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^(zalo|zl):/i, "")
    .replace(/^group:/i, "")
    .trim();
}

function parseZaloErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function isZaloApiErrorPayload(body: Record<string, unknown>): boolean {
  const code = parseZaloErrorCode(body.error);
  if (code !== undefined) {
    return code !== 0;
  }
  return body.error !== undefined && body.error !== null && body.error !== "";
}

function readZaloApiErrorDescription(body: Record<string, unknown>): string | undefined {
  const error = record(body.error);
  return asString(body.message) ?? asString(body.description) ?? asString(error.message) ?? asString(body.error);
}

function readZaloMessageId(body: Record<string, unknown>): string | undefined {
  const data = record(body.data);
  const result = record(body.result);
  const message = record(body.message);
  return (
    providerMessageIdFromValue(data.message_id) ??
    providerMessageIdFromValue(data.msg_id) ??
    providerMessageIdFromValue(result.message_id) ??
    providerMessageIdFromValue(message.message_id) ??
    providerMessageIdFromValue(body.message_id)
  );
}

function stripZalouserTargetPrefix(target: string): string {
  return target
    .trim()
    .replace(/^(zalouser|zlu):/i, "")
    .trim();
}

function normalizeZalouserTarget(target: string): string | undefined {
  const trimmed = target.trim();
  const stripped = stripZalouserTargetPrefix(trimmed);
  if (!stripped) {
    return undefined;
  }
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith("group:")) {
    const groupId = stripped.slice("group:".length).trim();
    return groupId ? `group:${groupId}` : undefined;
  }
  if (lowered.startsWith("g:")) {
    const groupId = stripped.slice("g:".length).trim();
    return groupId ? `group:${groupId}` : undefined;
  }
  if (lowered.startsWith("user:")) {
    const userId = stripped.slice("user:".length).trim();
    return userId ? `user:${userId}` : undefined;
  }
  if (lowered.startsWith("dm:")) {
    const userId = stripped.slice("dm:".length).trim();
    return userId ? `user:${userId}` : undefined;
  }
  if (lowered.startsWith("u:")) {
    const userId = stripped.slice("u:".length).trim();
    return userId ? `user:${userId}` : undefined;
  }
  if (/^g-\S+$/i.test(stripped)) {
    return `group:${stripped}`;
  }
  if (/^u-\S+$/i.test(stripped)) {
    return `user:${stripped}`;
  }
  return stripped;
}

function buildSignalTargetParams(target: string): Record<string, unknown> {
  const trimmed = required(target, "Signal target");
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("group:")) {
    return { groupId: required(trimmed.slice("group:".length), "Signal group id") };
  }
  if (lowered.startsWith("username:")) {
    return { username: [required(trimmed.slice("username:".length), "Signal username")] };
  }
  if (lowered.startsWith("u:")) {
    return { username: [required(trimmed.slice("u:".length), "Signal username")] };
  }
  return { recipient: [trimmed] };
}

function parseZalouserTarget(target: string): ZalouserTarget {
  const normalized = normalizeZalouserTarget(target);
  if (!normalized) {
    throw new Error("Zalo User target is required");
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("group:")) {
    const threadId = required(normalized.slice("group:".length).trim(), "Zalo User group id");
    return { threadId, isGroup: true };
  }
  if (lowered.startsWith("user:")) {
    const threadId = required(normalized.slice("user:".length).trim(), "Zalo User user id");
    return { threadId, isGroup: false };
  }
  return { threadId: normalized, isGroup: false };
}

function resolveZcaAuthorizationHeader(config: Record<string, unknown>): string | undefined {
  const explicit = secretFrom(config, "authorization", "authorizationEnv")?.trim();
  if (explicit) {
    return explicit;
  }
  const bearer = secretFrom(config, "authToken", "authTokenEnv") ?? secretFrom(config, "accessToken", "accessTokenEnv");
  if (bearer) {
    return `Bearer ${bearer}`;
  }
  const basic = secretFrom(config, "basicAuth", "basicAuthEnv")?.trim();
  if (basic) {
    return /^Basic\s+/i.test(basic) ? basic : `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
  }
  return undefined;
}

function extractZcaMessageId(payload: Record<string, unknown>): string | undefined {
  const roots: Record<string, unknown>[] = [payload];
  for (const nested of [payload.data, payload.result, payload.message]) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      roots.push(nested as Record<string, unknown>);
    }
  }
  for (const root of roots) {
    for (const candidate of [root.messageId, root.message_id, root.msgId, root.msg_id, root.id]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }
  }
  return undefined;
}

async function zcaSendText(
  baseUrl: string,
  profilePrefix: string,
  headers: Record<string, string>,
  target: ZalouserTarget,
  message: string,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const res = await fetchAllowlisted(
    `${baseUrl}${profilePrefix}/messages/text`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: target.threadId,
        message,
        isGroup: target.isGroup,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok) {
    const detail = asString(body.error) ?? asString(record(body.error).message) ?? bodyText.trim();
    throw new Error(`zalouser.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  return extractZcaMessageId(body) ?? `zalouser-${Date.now()}`;
}

async function zcaSendAttachment(
  baseUrl: string,
  profilePrefix: string,
  headers: Record<string, string>,
  target: ZalouserTarget,
  attachment: ChannelAttachment,
  caption: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const url = required(attachment.url, "Zalo User attachment URL");
  const endpoint = classifyZcaAttachmentEndpoint(attachment);
  const res = await fetchAllowlisted(
    `${baseUrl}${profilePrefix}/messages/${endpoint}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: target.threadId,
        url,
        message: caption,
        caption,
        isGroup: target.isGroup,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok) {
    const detail = asString(body.error) ?? asString(record(body.error).message) ?? bodyText.trim();
    throw new Error(`zalouser.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  return extractZcaMessageId(body) ?? `zalouser-${Date.now()}`;
}

function classifyZcaAttachmentEndpoint(attachment: ChannelAttachment): "image" | "video" | "voice" | "link" {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  if (mimeType?.startsWith("audio/")) {
    return "voice";
  }
  const url = attachment.url?.trim().toLowerCase() ?? "";
  const pathname = url ? new URL(url).pathname.toLowerCase() : "";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(pathname)) {
    return "image";
  }
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(pathname)) {
    return "video";
  }
  if (/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i.test(pathname)) {
    return "voice";
  }
  return "link";
}

function normalizeBlueBubblesHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("imessage:")) {
    return normalizeBlueBubblesHandle(trimmed.slice("imessage:".length));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeBlueBubblesHandle(trimmed.slice("sms:".length));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeBlueBubblesHandle(trimmed.slice("auto:".length));
  }
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed.replace(/\s+/g, "");
}

function stripBlueBubblesPrefix(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("bluebubbles:") ? trimmed.slice("bluebubbles:".length).trim() : trimmed;
}

function parseBlueBubblesTarget(raw: string): BlueBubblesTarget {
  const trimmed = stripBlueBubblesPrefix(required(raw, "iMessage target"));
  const lowered = trimmed.toLowerCase();
  const servicePrefixes = [
    { prefix: "imessage:", service: "imessage" as const },
    { prefix: "sms:", service: "sms" as const },
    { prefix: "auto:", service: "auto" as const },
  ];
  for (const { prefix, service } of servicePrefixes) {
    if (lowered.startsWith(prefix)) {
      const remainder = trimmed.slice(prefix.length).trim();
      const remainderLower = remainder.toLowerCase();
      if (
        /^(chat_id|chatid|chat|chat_guid|chatguid|guid|chat_identifier|chatidentifier|chatident|group):/.test(
          remainderLower,
        )
      ) {
        return parseBlueBubblesTarget(remainder);
      }
      return {
        kind: "handle",
        address: required(normalizeBlueBubblesHandle(remainder), "iMessage handle"),
        service,
      };
    }
  }

  if (/^(chat_id:|chatid:|chat:)/i.test(trimmed)) {
    const value = trimmed.replace(/^(chat_id:|chatid:|chat:)/i, "").trim();
    const chatId = Number.parseInt(value, 10);
    if (!Number.isFinite(chatId)) {
      throw new Error("Invalid BlueBubbles chat_id target");
    }
    return { kind: "chat_id", chatId };
  }
  if (/^(chat_guid:|chatguid:|guid:)/i.test(trimmed)) {
    return {
      kind: "chat_guid",
      chatGuid: required(trimmed.replace(/^(chat_guid:|chatguid:|guid:)/i, "").trim(), "BlueBubbles chat guid"),
    };
  }
  if (/^(chat_identifier:|chatidentifier:|chatident:)/i.test(trimmed)) {
    return {
      kind: "chat_identifier",
      chatIdentifier: required(
        trimmed.replace(/^(chat_identifier:|chatidentifier:|chatident:)/i, "").trim(),
        "BlueBubbles chat identifier",
      ),
    };
  }
  if (/^group:/i.test(trimmed)) {
    const groupValue = trimmed.slice("group:".length).trim();
    const chatId = Number.parseInt(groupValue, 10);
    if (Number.isFinite(chatId)) {
      return { kind: "chat_id", chatId };
    }
    return { kind: "chat_guid", chatGuid: required(groupValue, "BlueBubbles group target") };
  }
  if (/^[^;]+;[+-];.+$/u.test(trimmed)) {
    return { kind: "chat_guid", chatGuid: trimmed };
  }
  if (
    /^chat\d+$/i.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
    /^[0-9a-f]{24,64}$/i.test(trimmed)
  ) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  return {
    kind: "handle",
    address: required(normalizeBlueBubblesHandle(trimmed), "iMessage handle"),
    service: "auto",
  };
}

function buildBlueBubblesApiUrl(baseUrl: string, path: string, password: string): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("password", password);
  return url.toString();
}

function extractHandleFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length === 3 && parts[1] === "-") {
    const handle = parts[2]?.trim();
    return handle ? normalizeBlueBubblesHandle(handle) : null;
  }
  return null;
}

function extractBlueBubblesChatGuid(chat: Record<string, unknown>): string | null {
  const candidates = [
    chat.chatGuid,
    chat.guid,
    chat.chat_guid,
    chat.identifier,
    chat.chatIdentifier,
    chat.chat_identifier,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractBlueBubblesChatId(chat: Record<string, unknown>): number | null {
  for (const candidate of [chat.chatId, chat.id, chat.chat_id]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractBlueBubblesChatIdentifierFromGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length < 3) {
    return null;
  }
  const identifier = parts[2]?.trim();
  return identifier || null;
}

function extractBlueBubblesParticipantAddresses(chat: Record<string, unknown>): string[] {
  const rawParticipants = Array.isArray(chat.participants)
    ? chat.participants
    : Array.isArray(chat.handles)
      ? chat.handles
      : Array.isArray(chat.participantHandles)
        ? chat.participantHandles
        : [];
  const results: string[] = [];
  for (const entry of rawParticipants) {
    if (typeof entry === "string" && entry.trim()) {
      results.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const recordEntry = entry as Record<string, unknown>;
    for (const candidate of [recordEntry.address, recordEntry.handle, recordEntry.id, recordEntry.identifier]) {
      if (typeof candidate === "string" && candidate.trim()) {
        results.push(candidate.trim());
        break;
      }
    }
  }
  return results;
}

async function queryBlueBubblesChats(
  baseUrl: string,
  password: string,
  offset: number,
  limit: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/chat/query", password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit,
        offset,
        with: ["participants"],
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    return [];
  }
  const body = parseJsonRecord(await res.response.text());
  return Array.isArray(body.data)
    ? body.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

async function resolveBlueBubblesChatGuid(
  baseUrl: string,
  password: string,
  target: BlueBubblesTarget,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string | null> {
  if (target.kind === "chat_guid") {
    return target.chatGuid;
  }

  const normalizedHandle = target.kind === "handle" ? normalizeBlueBubblesHandle(target.address) : "";
  let participantMatch: string | null = null;
  for (let offset = 0; offset < 5000; offset += 500) {
    const chats = await queryBlueBubblesChats(baseUrl, password, offset, 500, allowlist, grantAllowlist);
    if (chats.length === 0) {
      break;
    }
    for (const chat of chats) {
      if (target.kind === "chat_id") {
        const chatId = extractBlueBubblesChatId(chat);
        if (chatId != null && chatId === target.chatId) {
          return extractBlueBubblesChatGuid(chat);
        }
      }
      if (target.kind === "chat_identifier") {
        const guid = extractBlueBubblesChatGuid(chat);
        if (guid === target.chatIdentifier) {
          return guid;
        }
        const guidIdentifier = guid ? extractBlueBubblesChatIdentifierFromGuid(guid) : null;
        if (guidIdentifier && guidIdentifier === target.chatIdentifier) {
          return guid;
        }
        const directIdentifier =
          asString(chat.identifier) ?? asString(chat.chatIdentifier) ?? asString(chat.chat_identifier);
        if (directIdentifier && directIdentifier === target.chatIdentifier) {
          return guid ?? directIdentifier;
        }
      }
      if (normalizedHandle) {
        const guid = extractBlueBubblesChatGuid(chat);
        const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
        if (directHandle && directHandle === normalizedHandle) {
          return guid;
        }
        if (!participantMatch && guid && guid.includes(";-;")) {
          const participants = extractBlueBubblesParticipantAddresses(chat).map((entry) =>
            normalizeBlueBubblesHandle(entry),
          );
          if (participants.includes(normalizedHandle)) {
            participantMatch = guid;
          }
        }
      }
    }
  }
  return participantMatch;
}

function extractBlueBubblesMessageId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }
  const roots = [payload];
  const rootRecord = payload as Record<string, unknown>;
  for (const nested of [rootRecord.data, rootRecord.result, rootRecord.payload, rootRecord.message]) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      roots.push(nested);
    }
  }
  if (Array.isArray(rootRecord.data) && rootRecord.data[0] && typeof rootRecord.data[0] === "object") {
    roots.push(rootRecord.data[0]);
  }
  for (const root of roots) {
    const candidateRecord = root as Record<string, unknown>;
    for (const candidate of [
      candidateRecord.message_id,
      candidateRecord.messageId,
      candidateRecord.messageGuid,
      candidateRecord.message_guid,
      candidateRecord.guid,
      candidateRecord.id,
      candidateRecord.uuid,
    ]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }
  }
  return "unknown";
}

function resolveBlueBubblesContext(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  target: string,
  missingTargetMessage: string,
): {
  baseUrl: string;
  password: string;
  resolvedTarget: string;
} {
  const baseUrl = normalizeBlueBubblesBaseUrl(
    asString(config.bridgeUrl) ?? asString(config.baseUrl) ?? asString(config.serverUrl),
  );
  const password = secretFrom(config, "password", "passwordEnv") ?? secretFrom(config, "apiPassword", "apiPasswordEnv");
  const resolvedTarget =
    asString(args.target) ??
    normalizeChannelTarget(target, "imessage") ??
    resolveDefaultChannelTarget("imessage", config);
  if (!baseUrl) {
    throw new Error("Missing iMessage bridge URL");
  }
  if (!password) {
    throw new Error("Missing iMessage bridge password");
  }
  if (!resolvedTarget && missingTargetMessage) {
    throw new Error(missingTargetMessage);
  }
  return {
    baseUrl,
    password,
    resolvedTarget: resolvedTarget ?? "",
  };
}

async function blueBubblesCreateChat(
  baseUrl: string,
  password: string,
  address: string,
  message: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    addresses: [address],
  };
  const trimmedMessage = message?.trim();
  if (trimmedMessage) {
    requestBody.message = trimmedMessage;
    requestBody.tempGuid = `temp-${randomUUID()}`;
  }
  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/chat/new", password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`BlueBubbles create chat failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  return extractBlueBubblesMessageId(parsed);
}

async function blueBubblesSendText(
  baseUrl: string,
  password: string,
  payload: {
    chatGuid: string;
    message: string;
    replyToMessageGuid?: string;
    replyToPartIndex?: number;
    effectId?: string;
  },
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    chatGuid: payload.chatGuid,
    tempGuid: randomUUID(),
    message: payload.message,
  };
  if (payload.replyToMessageGuid || payload.effectId) {
    requestBody.method = "private-api";
  }
  if (payload.replyToMessageGuid) {
    requestBody.selectedMessageGuid = payload.replyToMessageGuid;
    requestBody.partIndex = payload.replyToPartIndex ?? 0;
  }
  if (payload.effectId) {
    requestBody.effectId = payload.effectId;
  }

  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/message/text", password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`BlueBubbles send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  return extractBlueBubblesMessageId(parsed);
}

async function blueBubblesSendReaction(
  baseUrl: string,
  password: string,
  payload: {
    chatGuid: string;
    messageId: string;
    reaction: string;
    partIndex?: number;
    messageText?: string;
  },
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    chatGuid: payload.chatGuid,
    selectedMessageGuid: payload.messageId,
    reaction: payload.reaction,
  };
  if (payload.partIndex != null) {
    requestBody.partIndex = payload.partIndex;
  }
  if (payload.messageText) {
    requestBody.selectedMessageText = payload.messageText;
  }
  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/message/react", password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`BlueBubbles react failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  const providerMessageId = extractBlueBubblesMessageId(parsed);
  return providerMessageId === "unknown" ? payload.messageId : providerMessageId;
}

async function blueBubblesUnsendMessage(
  baseUrl: string,
  password: string,
  payload: {
    messageId: string;
    partIndex?: number;
  },
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const requestBody: Record<string, unknown> = {};
  if (payload.partIndex != null) {
    requestBody.partIndex = payload.partIndex;
  }
  const encodedMessageId = payload.messageId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, `/api/v1/message/${encodedMessageId}/unsend`, password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`BlueBubbles unsend failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  const providerMessageId = bodyText ? extractBlueBubblesMessageId(parsed) : "unknown";
  return providerMessageId === "unknown" ? payload.messageId : providerMessageId;
}

type BlueBubblesMultipartAttachmentPart = {
  hash: string;
  name: string;
};

async function blueBubblesUploadAttachment(
  baseUrl: string,
  password: string,
  attachment: ChannelAttachment,
  allowlist: string[],
  index: number,
  grantAllowlist?: string[],
): Promise<BlueBubblesMultipartAttachmentPart> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "BlueBubbles", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const blobBytes = new Uint8Array(attachmentData.bytes.length);
  blobBytes.set(attachmentData.bytes);
  const formData = new FormData();
  formData.append(
    "attachment",
    new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
    fileName,
  );

  const uploadRes = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/attachment/upload", password),
    {
      method: "POST",
      body: formData,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await uploadRes.response.text();
  if (!uploadRes.response.ok) {
    throw new Error(
      `BlueBubbles attachment upload failed (${uploadRes.response.status})${bodyText ? `: ${bodyText}` : ""}`,
    );
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  const hash = extractBlueBubblesAttachmentHash(parsed);
  if (!hash) {
    throw new Error("BlueBubbles attachment upload failed: missing attachment hash");
  }
  return { hash, name: fileName };
}

async function resolveChannelAttachmentBytes(
  attachment: ChannelAttachment,
  allowlist: string[],
  providerLabel: string,
  grantAllowlist?: string[],
): Promise<{
  bytes: Buffer;
  contentType?: string;
}> {
  if (attachment.dataBase64) {
    return {
      bytes: Buffer.from(attachment.dataBase64, "base64"),
      contentType: attachment.mimeType,
    };
  }
  const sourceUrl = required(attachment.url, `${providerLabel} attachment URL`);
  const attachmentRes = await fetchAllowlisted(sourceUrl, { method: "GET" }, allowlist, undefined, grantAllowlist);
  if (!attachmentRes.response.ok) {
    throw new Error(`${providerLabel} attachment fetch failed (${attachmentRes.response.status})`);
  }
  return {
    bytes: Buffer.from(await attachmentRes.response.arrayBuffer()),
    contentType: attachmentRes.response.headers.get("content-type") ?? attachment.mimeType ?? undefined,
  };
}

async function blueBubblesSendMultipart(
  baseUrl: string,
  password: string,
  payload: {
    chatGuid: string;
    message?: string;
    attachments: BlueBubblesMultipartAttachmentPart[];
    replyToMessageGuid?: string;
    replyToPartIndex?: number;
    effectId?: string;
    subject?: string;
  },
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const parts: Array<Record<string, unknown>> = [];
  let partIndex = 0;
  if (payload.message?.trim()) {
    parts.push({ partIndex, text: payload.message });
    partIndex += 1;
  }
  for (const attachment of payload.attachments) {
    parts.push({
      partIndex,
      attachment: attachment.hash,
      name: attachment.name,
    });
    partIndex += 1;
  }
  const requestBody: Record<string, unknown> = {
    chatGuid: payload.chatGuid,
    parts,
  };
  if (payload.replyToMessageGuid) {
    requestBody.selectedMessageGuid = payload.replyToMessageGuid;
    requestBody.partIndex = payload.replyToPartIndex ?? 0;
  }
  if (payload.effectId) {
    requestBody.effectId = payload.effectId;
  }
  if (payload.subject) {
    requestBody.subject = payload.subject;
  }

  const res = await fetchAllowlisted(
    buildBlueBubblesApiUrl(baseUrl, "/api/v1/message/multipart", password),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`BlueBubbles multipart send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const parsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
  return extractBlueBubblesMessageId(parsed);
}

function extractBlueBubblesAttachmentHash(payload: unknown): string | null {
  const body = record(payload);
  const directData = record(body.data);
  for (const candidate of [directData.hash, directData.id, body.hash, body.id]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function resolveChannelAttachmentName(attachment: ChannelAttachment, index: number): string {
  const explicitTitle = asString(attachment.title)?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const attachmentUrl = asString(attachment.url);
  if (attachmentUrl) {
    try {
      const pathname = new URL(attachmentUrl).pathname;
      const basename = pathname.split("/").pop()?.trim();
      if (basename) {
        return decodeURIComponent(basename);
      }
    } catch {
      // Ignore URL parsing failures and fall back to a generated name.
    }
  }

  const ext = inferAttachmentExtension(attachment.mimeType);
  return `attachment-${index + 1}${ext}`;
}

function isImageChannelAttachment(attachment: ChannelAttachment): boolean {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  const candidate = asString(attachment.title) ?? asString(attachment.url) ?? "";
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(candidate);
}

function inferAttachmentExtension(mimeType: string | undefined): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized || !normalized.includes("/")) {
    return "";
  }
  const subtype = normalized.split("/", 2)[1]?.split(";", 1)[0]?.trim();
  if (!subtype) {
    return "";
  }
  if (subtype === "jpeg") {
    return ".jpg";
  }
  return `.${subtype.replace(/[^a-z0-9.+-]/g, "")}`;
}

function parseIntegerLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMattermostTarget(target: string): MattermostTarget {
  const trimmed = required(target, "Mattermost target");
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("channel:")) {
    const channelTarget = required(trimmed.slice("channel:".length), "Mattermost channel target");
    if (channelTarget.startsWith("#")) {
      return { kind: "channel-name", name: required(channelTarget.slice(1), "Mattermost channel name") };
    }
    return looksLikeMattermostId(channelTarget)
      ? { kind: "channel", id: channelTarget }
      : { kind: "channel-name", name: channelTarget };
  }
  if (lowered.startsWith("user:")) {
    return { kind: "user", id: required(trimmed.slice("user:".length), "Mattermost user id") };
  }
  if (lowered.startsWith("mattermost:")) {
    return { kind: "user", id: required(trimmed.slice("mattermost:".length), "Mattermost user id") };
  }
  if (trimmed.startsWith("@")) {
    return { kind: "user", username: required(trimmed.slice(1), "Mattermost username") };
  }
  if (trimmed.startsWith("#")) {
    return { kind: "channel-name", name: required(trimmed.slice(1), "Mattermost channel name") };
  }
  return looksLikeMattermostId(trimmed) ? { kind: "channel", id: trimmed } : { kind: "channel-name", name: trimmed };
}

function looksLikeMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/i.test(value.trim());
}

async function resolveMattermostChannelId(
  serverUrl: string,
  botToken: string,
  target: MattermostTarget,
  botUserId: string,
  defaultTeam: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  if (target.kind === "channel") {
    return target.id;
  }
  if (target.kind === "user") {
    const userId =
      target.id || (await resolveMattermostUserId(serverUrl, botToken, target.username, allowlist, grantAllowlist));
    const channel = await mattermostApiRequest<Record<string, unknown>>(
      serverUrl,
      botToken,
      "/channels/direct",
      allowlist,
      {
        method: "POST",
        body: JSON.stringify([botUserId, userId]),
      },
      grantAllowlist,
    );
    return required(channel.id, "Mattermost DM channel id");
  }

  const teamIds = defaultTeam
    ? [await resolveMattermostTeamId(serverUrl, botToken, defaultTeam, allowlist, grantAllowlist)]
    : await resolveMattermostTeamIds(serverUrl, botToken, botUserId, allowlist, grantAllowlist);

  for (const teamId of teamIds) {
    try {
      const channel = await mattermostApiRequest<Record<string, unknown>>(
        serverUrl,
        botToken,
        `/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(target.name)}`,
        allowlist,
        undefined,
        grantAllowlist,
      );
      return required(channel.id, "Mattermost channel id");
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        continue;
      }
      throw error;
    }
  }

  if (teamIds.length === 0) {
    throw new Error("Mattermost bot is not a member of any team");
  }

  throw new Error(`Mattermost channel "#${target.name}" not found`);
}

async function resolveMattermostUserId(
  serverUrl: string,
  botToken: string,
  username: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const user = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    `/users/username/${encodeURIComponent(required(username, "Mattermost username"))}`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return required(user.id, "Mattermost user id");
}

async function resolveMattermostTeamId(
  serverUrl: string,
  botToken: string,
  teamName: string,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const team = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    `/teams/name/${encodeURIComponent(teamName)}`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return required(team.id, "Mattermost team id");
}

async function resolveMattermostTeamIds(
  serverUrl: string,
  botToken: string,
  botUserId: string,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string[]> {
  const teams = await mattermostApiRequest<Array<Record<string, unknown>>>(
    serverUrl,
    botToken,
    `/users/${encodeURIComponent(botUserId)}/teams`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return teams.map((team) => asString(team.id)).filter((teamId): teamId is string => Boolean(teamId));
}

async function mattermostApiRequest<T>(
  serverUrl: string,
  botToken: string,
  apiPath: string,
  allowlist: string[],
  init: RequestInit = {},
  grantAllowlist?: string[],
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/v4${apiPath}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${botToken}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetchAllowlisted(
    url,
    {
      ...init,
      headers,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    const detail = bodyText.trim();
    throw new Error(`mattermost.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!bodyText) {
    return undefined as T;
  }
  return JSON.parse(bodyText) as T;
}

async function mattermostUploadAttachment(
  serverUrl: string,
  botToken: string,
  channelId: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Mattermost", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const blobBytes = new Uint8Array(attachmentData.bytes.length);
  blobBytes.set(attachmentData.bytes);
  const formData = new FormData();
  formData.set("channel_id", channelId);
  formData.append(
    "files",
    new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
    fileName,
  );
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${botToken}`);
  const res = await fetchAllowlisted(
    `${serverUrl.replace(/\/+$/, "")}/api/v4/files`,
    {
      method: "POST",
      headers,
      body: formData,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`mattermost.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const body = parseJsonRecord(bodyText);
  const fileInfos = Array.isArray(body.file_infos)
    ? body.file_infos.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const firstFile = fileInfos[0];
  return required(firstFile?.id, "Mattermost uploaded file id");
}

async function slackUploadAttachment(
  token: string,
  channel: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
  threadTs?: string,
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Slack", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const metadataRes = await fetchAllowlisted(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        filename: fileName,
        length: attachmentData.bytes.length,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const metadataBodyText = await metadataRes.response.text();
  const metadataBody = parseJsonRecord(metadataBodyText);
  if (!metadataRes.response.ok || metadataBody.ok === false) {
    throw new Error(
      `slack.send failed (${metadataRes.response.status})${metadataBody.error ? `: ${metadataBody.error}` : ""}`,
    );
  }
  const uploadUrl = required(metadataBody.upload_url, "Slack upload URL");
  const fileId = required(metadataBody.file_id, "Slack file id");

  const uploadRes = await fetchAllowlisted(
    uploadUrl,
    {
      method: "POST",
      headers: attachmentData.contentType ? { "Content-Type": attachmentData.contentType } : undefined,
      body: new Uint8Array(attachmentData.bytes),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const uploadBodyText = await uploadRes.response.text();
  if (!uploadRes.response.ok) {
    throw new Error(`slack.send failed (${uploadRes.response.status})${uploadBodyText ? `: ${uploadBodyText}` : ""}`);
  }

  const completeRes = await fetchAllowlisted(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        files: [
          {
            id: fileId,
            title: attachment.title?.trim() || fileName,
          },
        ],
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const completeBodyText = await completeRes.response.text();
  const completeBody = parseJsonRecord(completeBodyText);
  if (!completeRes.response.ok || completeBody.ok === false) {
    throw new Error(
      `slack.send failed (${completeRes.response.status})${completeBody.error ? `: ${completeBody.error}` : ""}`,
    );
  }
  return fileId;
}

async function whatsappSendPayload(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const res = await fetchAllowlisted(
    `${baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || Object.keys(record(body.error)).length > 0) {
    const errorBody = record(body.error);
    const detail = asString(errorBody.message) ?? bodyText.trim();
    throw new Error(`whatsapp.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  const messages = Array.isArray(body.messages)
    ? body.messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  return asString(messages[0]?.id) ?? `whatsapp-${Date.now()}`;
}

async function whatsappSendAttachment(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  recipient: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const type = resolveWhatsAppAttachmentType(attachment);
  const attachmentField: Record<string, unknown> = {};
  if (attachment.dataBase64) {
    attachmentField.id = await whatsappUploadAttachment(
      baseUrl,
      phoneNumberId,
      accessToken,
      attachment,
      index,
      allowlist,
      grantAllowlist,
    );
  } else {
    attachmentField.link = required(attachment.url, "WhatsApp attachment URL");
  }
  if (type === "document") {
    attachmentField.filename = resolveChannelAttachmentName(attachment, index);
  }
  return whatsappSendPayload(
    baseUrl,
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type,
      [type]: attachmentField,
    },
    allowlist,
    grantAllowlist,
  );
}

async function whatsappUploadAttachment(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "WhatsApp", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const blobBytes = new Uint8Array(attachmentData.bytes.length);
  blobBytes.set(attachmentData.bytes);
  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  if (attachmentData.contentType) {
    formData.set("type", attachmentData.contentType);
  }
  formData.append(
    "file",
    new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
    fileName,
  );
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetchAllowlisted(
    `${baseUrl}/${encodeURIComponent(phoneNumberId)}/media`,
    {
      method: "POST",
      headers,
      body: formData,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || Object.keys(record(body.error)).length > 0) {
    const errorBody = record(body.error);
    const detail = asString(errorBody.message) ?? bodyText.trim();
    throw new Error(`whatsapp.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  return required(body.id, "WhatsApp uploaded media id");
}

async function signalRpcRequest<T>(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<T> {
  const res = await fetchAllowlisted(
    `${baseUrl}/api/v1/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: randomUUID(),
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (res.response.status === 201) {
    return undefined as T;
  }
  const bodyText = await res.response.text();
  if (!bodyText) {
    throw new Error(`Signal RPC empty response (status ${res.response.status})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Signal RPC returned malformed JSON (status ${res.response.status})`, { cause: error });
  }

  const body = record(parsed);
  const errorBody = record(body.error);
  if (Object.keys(errorBody).length > 0) {
    const code = errorBody.code != null ? String(errorBody.code) : "unknown";
    const message = asString(errorBody.message) ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${message}`);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "result")) {
    throw new Error(`Signal RPC returned invalid response envelope (status ${res.response.status})`);
  }
  if (!res.response.ok) {
    throw new Error(`signal.send failed (${res.response.status})`);
  }
  return body.result as T;
}

async function gmailRead(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const token = secretFrom(config, "accessToken", "accessTokenEnv");
  if (!token) {
    throw new Error("Missing Gmail access token");
  }
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  if (asString(args.query)) {
    url.searchParams.set("q", asString(args.query) as string);
  }
  url.searchParams.set("maxResults", String(clampInt(args.maxResults, 10, 1, 50)));
  const res = await fetchAllowlisted(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`gmail.read failed (${res.response.status})`);
  }
  return (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
}

async function gmailSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const token = secretFrom(config, "accessToken", "accessTokenEnv");
  if (!token) {
    throw new Error("Missing Gmail access token");
  }
  const to = stringArray(args.to);
  if (to.length === 0) {
    throw new Error("gmail.send requires args.to");
  }
  const subject = required(args.subject, "subject");
  const bodyText = required(args.bodyText, "bodyText");
  const rawMessage = [
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    bodyText,
  ].join("\r\n");
  const raw = Buffer.from(rawMessage).toString("base64url");
  const res = await fetchAllowlisted(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ raw }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`gmail.send failed (${res.response.status})`);
  }
  return (JSON.parse(body) as { id?: string }).id ?? `gmail-${Date.now()}`;
}

async function calendarList(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const token = secretFrom(config, "accessToken", "accessTokenEnv");
  if (!token) {
    throw new Error("Missing Calendar access token");
  }
  const calendarId = encodeURIComponent(asString(args.calendarId) ?? "primary");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
  if (asString(args.fromIso)) url.searchParams.set("timeMin", asString(args.fromIso) as string);
  if (asString(args.toIso)) url.searchParams.set("timeMax", asString(args.toIso) as string);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(clampInt(args.maxResults, 10, 1, 100)));
  const res = await fetchAllowlisted(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`calendar.list failed (${res.response.status})`);
  }
  return (JSON.parse(body) as { items?: unknown[] }).items ?? [];
}

async function calendarCreate(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const token = secretFrom(config, "accessToken", "accessTokenEnv");
  if (!token) {
    throw new Error("Missing Calendar access token");
  }
  const calendarId = encodeURIComponent(asString(args.calendarId) ?? "primary");
  const payload = {
    summary: required(args.title, "title"),
    description: asString(args.description),
    start: { dateTime: required(args.startIso, "startIso"), timeZone: asString(args.timeZone) ?? "UTC" },
    end: { dateTime: required(args.endIso, "endIso"), timeZone: asString(args.timeZone) ?? "UTC" },
    attendees: stringArray(args.attendees).map((email) => ({ email })),
  };
  const res = await fetchAllowlisted(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`calendar.create_event failed (${res.response.status})`);
  }
  return (JSON.parse(body) as { id?: string }).id ?? `calendar-${Date.now()}`;
}

async function fetchAllowlisted(
  url: string,
  init: RequestInit,
  allowlist: string[],
  signal?: AbortSignal,
  grantAllowlist?: string[],
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop += 1) {
    assertHostAllowed(current, allowlist);
    if (grantAllowlist && grantAllowlist.length > 0) {
      assertHostAllowed(current, grantAllowlist);
    }
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      response = await fetchAllowlistedOnce(current, {
        allowlist,
        init: {
          ...init,
          redirect: "manual",
          signal: composeAbortSignal(20000, signal),
        },
      });
      if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt >= MAX_HTTP_RETRIES) {
        break;
      }
      await waitForHttpRetry(response, attempt, signal);
    }
    if (!(response.status >= 300 && response.status < 400)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect missing location for ${redactUrlForError(current)}`);
    }
    current = new URL(location, current).toString();
  }
  throw new Error(`Too many redirects for ${redactUrlForError(url)}`);
}

async function waitForHttpRetry(response: Response, attempt: number, signal?: AbortSignal): Promise<void> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const delayMs = Math.min(retryAfterMs ?? 25 * (attempt + 1), MAX_HTTP_RETRY_DELAY_MS);
  if (delayMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("request aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
      },
      { once: true },
    );
  });
}

function parseRetryAfterMs(value: string | null): number | undefined {
  return coerceRetryAfterMs(value, { maxMs: MAX_HTTP_RETRY_DELAY_MS });
}

function composeAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function secretFrom(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined {
  const direct = asString(config[directKey]);
  if (direct) return direct;
  const envName = asString(config[envKey]);
  if (!envName) return undefined;
  const envValue = process.env[envName];
  return envValue?.trim() || undefined;
}

function chunkText(text: string, targetChars: number, overlap: number, maxChunks: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length && out.length < maxChunks) {
    const end = Math.min(trimmed.length, cursor + targetChars);
    const chunk = trimmed.slice(cursor, end).trim();
    if (chunk) out.push(chunk);
    if (end >= trimmed.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

function pseudoEmbedding(text: string, dimensions = 64): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    const index = lower.charCodeAt(i) % dimensions;
    vec[index] = (vec[index] ?? 0) + 1;
  }
  const mag = Math.sqrt(vec.reduce((acc, value) => acc + value * value, 0)) || 1;
  return vec.map((value) => value / mag);
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function scoreLexical(query: string, candidate: string): number {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function required(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function resolveOptionalCwd(
  value: unknown,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: Storage,
): string | undefined {
  const cwd = asString(value);
  if (!cwd) {
    return undefined;
  }
  assertReadPathAllowedForRequest(cwd, request, config, storage);
  return path.resolve(cwd);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}

function parseExecFileCommand(command: string): { file: string; args: string[] } {
  const input = command.trim();
  if (input.includes("\u0000")) {
    throw new Error("shell.exec command contains invalid null byte");
  }

  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      const next = input[index + 1] ?? "";
      const escapable = next === '"' || next === "'" || next === "\\" || /\s/.test(next);
      if (!escapable) {
        current += char;
        continue;
      }
      escaping = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || inSingle || inDouble) {
    throw new Error("shell.exec command has unmatched quotes or escape sequence");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  const file = tokens[0] as string;
  const args = tokens.slice(1);
  return { file, args };
}

async function searchFileContents(input: {
  request: ToolInvokeRequest;
  rootPath: string;
  pattern: string;
  caseSensitive: boolean;
  limit: number;
  config: ToolPolicyConfig;
  storage: Storage;
  codeOnly?: boolean;
}): Promise<Record<string, unknown>> {
  assertReadPathAllowedForRequest(input.rootPath, input.request, input.config, input.storage);
  const fullRoot = path.resolve(input.rootPath);
  const normalizedPattern = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
  const matches: Array<{
    path: string;
    line: number;
    lineText: string;
  }> = [];
  const pending = [fullRoot];

  while (pending.length > 0 && matches.length < input.limit) {
    const current = pending.pop() as string;
    const stat = await fs.stat(current);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (shouldSkipSearchEntry(entry.name)) {
          continue;
        }
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (input.codeOnly && !looksLikeCodeFile(entry.name)) {
          continue;
        }
        pending.push(entryPath);
      }
      continue;
    }
    if (input.codeOnly && !looksLikeCodeFile(path.basename(current))) {
      continue;
    }
    const content = await fs.readFile(current, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      const haystack = input.caseSensitive ? lineText : lineText.toLowerCase();
      if (!haystack.includes(normalizedPattern)) {
        continue;
      }
      matches.push({
        path: current,
        line: index + 1,
        lineText: lineText.slice(0, 400),
      });
      if (matches.length >= input.limit) {
        break;
      }
    }
  }

  return {
    path: fullRoot,
    pattern: input.pattern,
    count: matches.length,
    matches,
  };
}

function assertReadPathAllowedForRequest(
  targetPath: string,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage?: Storage,
): void {
  if (canBypassReadPath(targetPath, request, config, storage)) {
    return;
  }
  assertReadPathAllowed(targetPath, config.sandbox.writeJailRoots, config.sandbox.readOnlyRoots);
}

function canBypassReadPath(
  targetPath: string,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage?: Storage,
): boolean {
  const readAccessMode = getStrictestReadAccessMode(
    config.sandbox.readAccessMode,
    request.policyContext?.permissionProfile?.readAccessMode,
  );
  const matchedExecutionGrant = resolveMatchedExecutionAllowGrant(request, storage);
  const matchedAllowedPaths = matchedExecutionGrant ? getAllowedGrantReadPaths(matchedExecutionGrant) : [];
  if (matchedAllowedPaths.length > 0) {
    const resolvedPath = resolveReadPathAccess(
      targetPath,
      config.sandbox.writeJailRoots,
      config.sandbox.readOnlyRoots,
    ).resolvedPath;
    return isPathWithinAnyGrantRoot(resolvedPath, matchedAllowedPaths);
  }
  const grants = resolveMatchingAllowGrants(request, storage);
  const grantsWithPathConstraints = grants
    .map((grant) => ({
      grant,
      allowedPaths: getAllowedGrantReadPaths(grant),
    }))
    .filter((entry) => entry.allowedPaths.length > 0);
  const resolvedPath = resolveReadPathAccess(
    targetPath,
    config.sandbox.writeJailRoots,
    config.sandbox.readOnlyRoots,
  ).resolvedPath;
  if (grantsWithPathConstraints.length > 0) {
    return grantsWithPathConstraints.some((entry) => isPathWithinAnyGrantRoot(resolvedPath, entry.allowedPaths));
  }
  if (readAccessMode === "full_disk") {
    return true;
  }
  if (readAccessMode === "approval_required" && storage && hasVerifiedApprovalBypass(request, storage)) {
    return true;
  }
  if (grants.length === 0) {
    return false;
  }
  return grants.some((grant) => {
    const allowedPaths = getAllowedGrantReadPaths(grant);
    if (allowedPaths.length === 0) {
      return false;
    }
    return isPathWithinAnyGrantRoot(resolvedPath, allowedPaths);
  });
}

function getAllowedGrantReadPaths(grant: ToolGrantRecord): string[] {
  return [
    ...(grant.constraints?.allowedPaths ?? []),
    ...(grant.constraints?.referenceRoots ?? []).map((item) => item.rootPath),
  ];
}

function resolveExecutionGrantAllowedHosts(request: ToolInvokeRequest, storage?: Storage): string[] | undefined {
  const contextHosts = request.policyContext?.matchedGrantAllowedHosts
    ?.map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (contextHosts && contextHosts.length > 0) {
    return contextHosts;
  }
  if (request.policyContext?.matchedGrantId) {
    const matchedGrant = resolveMatchedExecutionAllowGrant(request, storage);
    const grantHosts = matchedGrant?.constraints?.allowedHosts?.map((host) => host.trim()).filter(Boolean);
    return grantHosts && grantHosts.length > 0 ? grantHosts : undefined;
  }
  const matchingGrant = resolveMatchingAllowGrants(request, storage).find(
    (grant) => (grant.constraints?.allowedHosts?.length ?? 0) > 0,
  );
  const grantHosts = matchingGrant?.constraints?.allowedHosts?.map((host) => host.trim()).filter(Boolean);
  return grantHosts && grantHosts.length > 0 ? grantHosts : undefined;
}

function resolveMatchedExecutionAllowGrant(request: ToolInvokeRequest, storage?: Storage): ToolGrantRecord | undefined {
  const grantId = request.policyContext?.matchedGrantId?.trim();
  const grantRepo = storage?.toolGrants as
    | (Storage["toolGrants"] & { get?: (grantId: string) => ToolGrantRecord })
    | undefined;
  if (!grantId || !grantRepo?.get) {
    return undefined;
  }
  try {
    const grant = grantRepo.get(grantId);
    if (grant.decision !== "allow" || !matchesGrantToolPattern(grant.toolPattern, request.toolName)) {
      return undefined;
    }
    if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
      return undefined;
    }
    return grant;
  } catch {
    return undefined;
  }
}

function getStrictestReadAccessMode(
  configMode?: ToolPolicyConfig["sandbox"]["readAccessMode"],
  profileMode?: ToolPolicyConfig["sandbox"]["readAccessMode"],
): ToolPolicyConfig["sandbox"]["readAccessMode"] {
  const rank = { roots_only: 0, approval_required: 1, full_disk: 2 } as const;
  const normalizedConfigMode = configMode ?? "roots_only";
  if (!profileMode) {
    return normalizedConfigMode;
  }
  return rank[profileMode] < rank[normalizedConfigMode] ? profileMode : normalizedConfigMode;
}

function resolveMatchingAllowGrants(request: ToolInvokeRequest, storage?: Storage): ToolGrantRecord[] {
  const grantRepo = storage?.toolGrants;
  if (!grantRepo?.list) {
    return [];
  }
  const grants: ToolGrantRecord[] = [];
  for (const candidate of buildGrantScopeCandidates(request)) {
    const activeGrantRepo = grantRepo as typeof grantRepo & { listActive?: typeof grantRepo.list };
    const scoped = (
      activeGrantRepo.listActive
        ? activeGrantRepo.listActive(candidate.scope, candidate.scopeRef)
        : grantRepo
            .list(candidate.scope, candidate.scopeRef, Number.MAX_SAFE_INTEGER)
            .filter((grant) => isGrantActive(grant))
    )
      .filter((grant) => grant.decision === "allow")
      .filter((grant) => matchesGrantToolPattern(grant.toolPattern, request.toolName));
    grants.push(...scoped);
  }
  return grants;
}

function buildGrantScopeCandidates(
  request: ToolInvokeRequest,
): Array<{ scope: "task" | "agent" | "session" | "workspace" | "global"; scopeRef: string }> {
  const out: Array<{ scope: "task" | "agent" | "session" | "workspace" | "global"; scopeRef: string }> = [];
  if (request.taskId) {
    out.push({ scope: "task", scopeRef: request.taskId });
  }
  out.push({ scope: "agent", scopeRef: request.agentId });
  out.push({ scope: "session", scopeRef: request.sessionId });
  if (request.workspaceId) {
    out.push({ scope: "workspace", scopeRef: request.workspaceId });
  }
  out.push({ scope: "global", scopeRef: "global" });
  return out;
}

function matchesGrantToolPattern(pattern: string, toolName: string): boolean {
  return matchesToolPattern(pattern, toolName);
}

function isGrantActive(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
    return false;
  }
  if (typeof grant.usesRemaining === "number" && grant.usesRemaining <= 0) {
    return false;
  }
  return true;
}

function isPathWithinAnyGrantRoot(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = normalizePathForGrantMatch(candidate);
  return roots.some((root) => {
    if (root.trim() === "*") {
      return true;
    }
    const resolvedRoot = normalizePathForGrantMatch(root);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`);
  });
}

function normalizePathForGrantMatch(candidate: string): string {
  return path.resolve(candidate).replace(/\\/g, "/").toLowerCase();
}

function shouldSkipSearchEntry(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "build" ||
    name === "coverage" ||
    name === ".next"
  );
}

function looksLikeCodeFile(name: string): boolean {
  return /\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|mts|php|py|rb|rs|sh|sql|swift|toml|ts|tsx|vue|yaml|yml)$/i.test(
    name,
  );
}
