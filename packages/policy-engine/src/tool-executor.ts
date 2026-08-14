/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import fsSync from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type {
  BrowserSessionAccessCheck,
  ChangePlanModelToolResult,
  ChangePlanRequest,
  ChatSessionStatusModelProjection,
  DocumentPatchProposalToolInput,
  NotifyRequest,
  ToolGrantRecord,
  ToolInvokeRequest,
  ToolPolicyActorContext,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { coerceRetryAfterMs, isChangePlanRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { hasVerifiedApprovalBypass } from "./approval-bypass.js";
import { assertReadPathAllowed, assertWritePathInJail, resolveReadPathAccess } from "./sandbox/path-jail.js";
import { assertHostAllowed, fetchAllowlistedOnce, redactUrlForError } from "./sandbox/network-guard.js";
import {
  assertSafeRedirectTransition,
  HttpMutationOutcomeUnknownError,
  isHttpRequestSafeToRetry,
} from "./sandbox/http-request-policy.js";
import { executeBrowserTool, isBrowserToolName } from "./browser-tools.js";
import { scanBrowserContentGuard } from "./browser-content-guard.js";
import type { ResolveOfficialSearchCredential } from "./research-search-official-providers.js";
import { collectLeakDetections, sanitizeForModel } from "./tool-security.js";
import { matchesToolPattern } from "./tool-patterns.js";
import {
  CHANGE_REQUEST_TOOL_NAME,
  RUNTIME_CONFIGURATION_TARGET_IDS,
  RUNTIME_CONFIGURE_TOOL_NAME,
  type RuntimeConfigurationTargetId,
} from "./tool-registry.js";
import type { AcquireLocalEmbeddingLease, PrepareEmbeddingUsageDispatch } from "./local-embeddings.js";
import { classifyShellRisk } from "./sandbox/shell-risk-gate.js";
import {
  killBackgroundProcess,
  registerBackgroundProcess,
  terminateShellProcessTree,
} from "./tool-executor/background-processes.js";
import { executeArtifactTool, isArtifactToolName } from "./tool-executor/artifact-executor.js";
import type { PreparePresentationVisuals } from "./presentation-visual-runtime.js";
import { executeCommsTool } from "./tool-executor/comms-executor.js";
import {
  executeRoutedContextTool,
  isRoutedContextToolName,
  listAvailableRoutedContextTools,
} from "./tool-executor/context-executor.js";
import { executeFilesystemTool, isFilesystemToolName } from "./tool-executor/filesystem-executor.js";
import { executeKnowledgeTool, isKnowledgeToolName } from "./tool-executor/knowledge-executor.js";
import {
  executeScheduleManage,
  executeSubagentFanout,
  executeSubmitWorkResult,
} from "./tool-executor/schedule-agent-executor.js";
export { killAllBackgroundProcesses, killBackgroundProcess } from "./tool-executor/background-processes.js";
export { resolveFixedOutboundHostsForTool } from "./tool-executor/fixed-outbound-hosts.js";
const execFileAsync = promisify(execFile);
const SHELL_EXEC_DEFAULT_TIMEOUT_MS = 20000;
const SHELL_EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_DIFF_SNIPPET_BYTES = 12_000;
const GIT_DIFF_ERROR_BYTES = 4_000;
let shellExecTimeoutMs = SHELL_EXEC_DEFAULT_TIMEOUT_MS;

/**
 * Test-only override for the shell.exec hard-kill timeout. Production keeps the
 * 20s default; tests use this to exercise the timeout/tree-kill path quickly.
 * Pass no argument (or the default) to restore the production value.
 */
export function setShellExecTimeoutMsForTesting(ms: number = SHELL_EXEC_DEFAULT_TIMEOUT_MS): void {
  shellExecTimeoutMs = Math.max(1, Math.floor(ms));
}

const MAX_HTTP_REDIRECTS = 5;
const MAX_HTTP_RETRIES = 2;
const MAX_HTTP_RETRY_DELAY_MS = 50;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const MAX_SHELL_OUTPUT_BYTES = 4096;

export interface ToolExecutorRuntimeHooks {
  /**
   * Acquire a request-scoped runtime lease only when the resolved embedding
   * transport is the configured local llama.cpp service.
   */
  acquireLocalEmbeddingLease?: AcquireLocalEmbeddingLease;
  prepareEmbeddingUsageDispatch?: PrepareEmbeddingUsageDispatch;
  assertBrowserSessionAccess?: (check: BrowserSessionAccessCheck) => void;
  /** Resolve protected official-search credentials at execution time, before environment fallback. */
  resolveCredential?: ResolveOfficialSearchCredential;
  /** Resolve a protected approval action bearer only inside the native comms provider adapter. */
  resolveApprovalActionTokenSecret?: (secretRef: string) => string;
  /** Remove a protected approval action bearer after a terminal provider outcome. */
  deleteApprovalActionTokenSecret?: (secretRef: string) => void;
  /** Revalidate authenticated callback ingress immediately before a protected provider send. */
  isApprovalActionConnectorReady?: (connectionId: string) => Promise<boolean>;
  /** Called at the concrete provider or irreversible mutation boundary. */
  beforeExternalSideEffect?: () => void;
  /**
   * Final process-local precondition for the five cwd-bearing builtin process
   * tools. The executor awaits it after command/cwd resolution and immediately
   * before spawn/execFile; it is never serialized into a tool request.
   */
  beforeProcessSpawn?: (boundary: ToolProcessSpawnBoundary) => void | Promise<void>;
  /**
   * Impure `schedule.manage` fulfillment. The cron mutation (create/list/cancel
   * an `agent_turn` job) lives in the gateway, not this pure package, so the
   * executor delegates back through this hook — mirroring how browser session
   * access is delegated via {@link assertBrowserSessionAccess}. The gateway
   * implementation forces `action:"agent_turn"`, persists the creator actor from
   * `policyContext` onto the job, and enforces the anti-recursion bounds
   * (per-creator cap, ≥15min interval floor, depth-1 chain cap). When the hook is
   * absent the tool is unfulfillable and `schedule.manage` raises a clear error.
   */
  scheduleManage?: (
    args: Record<string, unknown>,
    policyContext: ToolPolicyActorContext | undefined,
  ) => Promise<Record<string, unknown>>;
  /**
   * Impure `agent.fanout` fulfillment (R3-8). Spawning delegated child turns
   * lives in the gateway (it needs the active turn's prepared context), so the
   * executor delegates the whole invoke request back through this hook —
   * mirroring {@link scheduleManage}. The gateway implementation resolves the
   * fan-out executor registered for the request's session, enforces the
   * ≤3-subtask cap, floors every child to `subagentPolicy:"off"` and
   * `orchestrationEnabled:false` (no recursion by construction), and returns
   * the aggregated per-subtask results. When the hook is absent the tool is
   * unfulfillable and `agent.fanout` raises a clear error.
   */
  subagentFanout?: (request: ToolInvokeRequest) => Promise<Record<string, unknown>>;
  /** Gateway-owned canonical status projection used by the model-safe `session.status` tool. */
  getChatSessionStatus?: (sessionId: string) => Promise<ChatSessionStatusModelProjection>;
  /** Gateway-owned governed attention request; operator-authored rules select external targets. */
  requestNotification?: (request: ToolInvokeRequest, input: NotifyRequest) => Promise<Record<string, unknown>>;
  /** Gateway-bound assistant proposal. The model cannot supply runtime identity or apply the document mutation. */
  proposeDocumentPatch?: (
    request: ToolInvokeRequest,
    input: DocumentPatchProposalToolInput,
  ) => Promise<Record<string, unknown>>;
  /** Record a delegated worker result or approval-gated filesystem scope request. */
  submitWorkResult?: (request: ToolInvokeRequest) => Promise<Record<string, unknown>>;
  /** Gateway-owned secure configuration flow. Secret material must never be returned through this hook. */
  configureRuntime?: (request: ToolInvokeRequest, targetId: RuntimeConfigurationTargetId) => void | Promise<void>;
  /** Plan creation only. The hook must return a model-safe projection without action nonces. */
  requestChangePlan?: (request: ToolInvokeRequest, intent: ChangePlanRequest) => Promise<ChangePlanModelToolResult>;
  /** Post-authorization, Gateway-owned presentation image generation hook. */
  preparePresentationVisuals?: PreparePresentationVisuals;
}

export type ToolProcessSpawnName = "shell.exec" | "shell.exec_background" | "tests.run" | "lint.run" | "build.run";

export interface ToolProcessSpawnBoundary {
  toolName: ToolProcessSpawnName;
  cwd?: string;
}

export class ToolBeforeProcessSpawnError extends Error {
  public constructor(
    public readonly boundaryCause: unknown,
    public readonly cancelled: boolean,
  ) {
    super(
      cancelled
        ? "Tool process spawn was cancelled before execution."
        : `Tool process spawn precondition failed: ${errorMessage(boundaryCause)}`,
    );
    this.name = "ToolBeforeProcessSpawnError";
  }
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
function scrubSensitiveOutput(text: string): string {
  let scrubbed = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed.slice(0, MAX_SHELL_OUTPUT_BYTES);
}

function resolveToolActorId(request: ToolInvokeRequest): string {
  return request.policyContext?.authActorId?.trim() || request.consentContext?.operatorId?.trim() || request.agentId;
}

const executeKnowledgeFamily = (
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  runtimeHooks: ToolExecutorRuntimeHooks,
) =>
  executeKnowledgeTool(request, config, storage, {
    ...(runtimeHooks.acquireLocalEmbeddingLease
      ? { acquireLocalEmbeddingLease: runtimeHooks.acquireLocalEmbeddingLease }
      : {}),
    ...(runtimeHooks.prepareEmbeddingUsageDispatch
      ? { prepareEmbeddingUsageDispatch: runtimeHooks.prepareEmbeddingUsageDispatch }
      : {}),
    assertReadPathAllowedForRequest,
    fetchAllowlisted,
    resolveExecutionGrantAllowedHosts,
    resolveNetworkAllowlist,
  });

export async function executeTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
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
      matchedGrantAllowedHosts: await resolveExecutionGrantAllowedHosts(request, storage),
      fullWebAccess: hasFullWebAccess(request),
      actorId: resolveToolActorId(request),
      ...(request.runId ? { runId: request.runId } : {}),
      assertBrowserSessionAccess: runtimeHooks.assertBrowserSessionAccess,
      resolveCredential: runtimeHooks.resolveCredential,
    });
    return finalizeToolResult(rawResult);
  }
  if (isFilesystemToolName(request.toolName)) {
    return finalizeToolResult(
      await executeFilesystemTool(request, config, storage, {
        assertReadPathAllowedForRequest,
      }),
    );
  }
  if (isArtifactToolName(request.toolName)) {
    return finalizeToolResult(
      await executeArtifactTool(request.toolName, request.args, config, {
        request,
        preparePresentationVisuals: runtimeHooks.preparePresentationVisuals,
      }),
    );
  }
  if (isKnowledgeToolName(request.toolName)) {
    return finalizeToolResult(await executeKnowledgeFamily(request, config, storage, runtimeHooks));
  }
  if (isRoutedContextToolName(request.toolName)) {
    return finalizeToolResult(
      await executeRoutedContextTool(request, storage, {
        ...(runtimeHooks.acquireLocalEmbeddingLease
          ? { acquireLocalEmbeddingLease: runtimeHooks.acquireLocalEmbeddingLease }
          : {}),
        ...(runtimeHooks.prepareEmbeddingUsageDispatch
          ? { prepareEmbeddingUsageDispatch: runtimeHooks.prepareEmbeddingUsageDispatch }
          : {}),
      }),
    );
  }
  switch (request.toolName) {
    case CHANGE_REQUEST_TOOL_NAME: {
      if (!runtimeHooks.requestChangePlan) {
        throw new Error("Change Plan requests are unavailable in this runtime.");
      }
      const intent = readChangePlanIntent(request.args);
      return finalizeToolResult({ ...(await runtimeHooks.requestChangePlan(request, intent)) });
    }
    case RUNTIME_CONFIGURE_TOOL_NAME: {
      const targetId = readRuntimeConfigurationTarget(request.args);
      if (!runtimeHooks.configureRuntime) {
        throw new Error("Secure runtime configuration is unavailable in this runtime.");
      }
      await runtimeHooks.configureRuntime(request, targetId);
      return finalizeToolResult({
        status: "configuration_required",
        configurationRequired: true,
        targetId,
      });
    }
    case "session.status":
      return finalizeToolResult(
        runtimeHooks.getChatSessionStatus
          ? { ...(await runtimeHooks.getChatSessionStatus(request.sessionId)) }
          : {
              sessionId: request.sessionId,
              status: "unavailable",
              reason: "Gateway session status service is unavailable.",
              attachedContextTools: listAvailableRoutedContextTools(request, storage),
            },
      );
    case "notify.request": {
      if (!runtimeHooks.requestNotification) {
        throw new Error("Notification routing is unavailable in this runtime.");
      }
      const input = readNotifyRequest(request.args);
      return finalizeToolResult(await runtimeHooks.requestNotification(request, input));
    }
    case "document.propose_patch": {
      if (!runtimeHooks.proposeDocumentPatch) {
        throw new Error("Document patch proposals are unavailable in this runtime.");
      }
      return finalizeToolResult(
        await runtimeHooks.proposeDocumentPatch(request, readDocumentPatchProposal(request.args)),
      );
    }
    case "time.now":
      return finalizeToolResult(timeNow());
    case "http.get":
      return finalizeToolResult(await httpGet(request, config, storage));
    case "http.post":
      return finalizeToolResult(await httpPost(request, config, storage, runtimeHooks));
    case "shell.exec":
      return finalizeToolResult(await shellExec(request, config, storage, runtimeHooks));
    case "shell.exec_background":
      return finalizeToolResult(await shellExecBackground(request, config, storage, runtimeHooks));
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
      return finalizeToolResult(await runRestricted("test", request, config, storage, runtimeHooks));
    case "lint.run":
      return finalizeToolResult(await runRestricted("lint", request, config, storage, runtimeHooks));
    case "build.run":
      return finalizeToolResult(await runRestricted("build", request, config, storage, runtimeHooks));
    case "schedule.manage":
      return finalizeToolResult(await executeScheduleManage(request, runtimeHooks));
    case "agent.fanout":
      return finalizeToolResult(await executeSubagentFanout(request, runtimeHooks));
    case "submit_work_result":
      return finalizeToolResult(await executeSubmitWorkResult(request, runtimeHooks));
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
      return finalizeToolResult(
        await executeCommsTool(
          request,
          config,
          storage,
          await resolveExecutionGrantAllowedHosts(request, storage),
          runtimeHooks,
        ),
      );
    default:
      throw new Error(`Unsupported tool executor: ${request.toolName}`);
  }
}

function readChangePlanIntent(args: Record<string, unknown>): ChangePlanRequest {
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, "intent")) {
    throw new Error("change.request accepts only intent.");
  }
  if (!isChangePlanRequest(args.intent)) {
    throw new Error("change.request intent must be an allowlisted bounded Change Plan request.");
  }
  return args.intent;
}

function readRuntimeConfigurationTarget(args: Record<string, unknown>): RuntimeConfigurationTargetId {
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, "targetId")) {
    throw new Error("runtime.configure accepts only targetId.");
  }
  const targetId = args.targetId;
  if (typeof targetId !== "string" || !(RUNTIME_CONFIGURATION_TARGET_IDS as readonly string[]).includes(targetId)) {
    throw new Error("runtime.configure targetId must identify a supported secure configuration target.");
  }
  return targetId as RuntimeConfigurationTargetId;
}

function readNotifyRequest(args: Record<string, unknown>): NotifyRequest {
  const eventType = args.eventType;
  const title = args.title;
  const message = args.message;
  if (typeof eventType !== "string" || typeof title !== "string" || typeof message !== "string") {
    throw new Error("notify.request requires eventType, title, and message.");
  }
  return { eventType: eventType as NotifyRequest["eventType"], title, message };
}

function readDocumentPatchProposal(args: Record<string, unknown>): DocumentPatchProposalToolInput {
  const targetKind = args.targetKind;
  const targetId = args.targetId;
  const proposedContent = args.proposedContent;
  if (
    (targetKind !== "personal_note" && targetKind !== "generated_artifact") ||
    typeof targetId !== "string" ||
    !targetId.trim() ||
    typeof proposedContent !== "string"
  ) {
    throw new Error("document.propose_patch requires targetKind, targetId, and proposedContent.");
  }
  const baseRevision = args.baseRevision;
  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || (baseRevision as number) < 1)) {
    throw new Error("document.propose_patch baseRevision must be a positive integer.");
  }
  const baseContentHash = args.baseContentHash;
  if (
    baseContentHash !== undefined &&
    (typeof baseContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(baseContentHash))
  ) {
    throw new Error("document.propose_patch baseContentHash must be a SHA-256 hash.");
  }
  return {
    targetKind,
    targetId: targetId.trim(),
    proposedContent,
    ...(baseRevision === undefined ? {} : { baseRevision: baseRevision as number }),
    ...(baseContentHash === undefined ? {} : { baseContentHash }),
  };
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

async function httpGet(request: ToolInvokeRequest, config: ToolPolicyConfig, storage?: AsyncStorage) {
  const args = request.args;
  const url = required(args.url, "url");
  const res = await fetchAllowlisted(
    url,
    { method: "GET" },
    resolveNetworkAllowlist(request, config),
    request.signal,
    await resolveExecutionGrantAllowedHosts(request, storage),
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

async function httpPost(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage | undefined,
  runtimeHooks: ToolExecutorRuntimeHooks,
) {
  const args = request.args;
  const url = required(args.url, "url");
  const body = JSON.stringify(args.body ?? {});
  const allowlist = config.sandbox.networkAllowlist;
  const grantAllowlist = await resolveExecutionGrantAllowedHosts(request, storage);
  assertHostAllowed(url, allowlist);
  if (grantAllowlist && grantAllowlist.length > 0) {
    assertHostAllowed(url, grantAllowlist);
  }
  if (request.signal?.aborted) {
    throw request.signal.reason instanceof Error
      ? request.signal.reason
      : new Error("http.post aborted before dispatch");
  }
  try {
    runtimeHooks.beforeExternalSideEffect?.();
    const res = await fetchAllowlisted(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      allowlist,
      request.signal,
      grantAllowlist,
    );
    const text = await res.response.text();
    const externalOutcomeUnknown = RETRYABLE_HTTP_STATUSES.has(res.response.status) || res.response.status >= 500;
    return {
      url: res.finalUrl,
      status: res.response.status,
      contentType: res.response.headers.get("content-type") ?? undefined,
      byteLength: Buffer.byteLength(text, "utf8"),
      body: text,
      bodySnippet: text.slice(0, 4000),
      ...(externalOutcomeUnknown ? { externalOutcome: "unknown_after_send", manualReconciliationRequired: true } : {}),
    };
  } catch (error) {
    if (error instanceof HttpMutationOutcomeUnknownError) {
      throw error;
    }
    throw new HttpMutationOutcomeUnknownError("http.post", error);
  }
}

async function shellExec(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  runtimeHooks: ToolExecutorRuntimeHooks,
) {
  const args = request.args;
  const command = required(args.command, "command");
  const cwd = await resolveOptionalCwd(args.cwd, request, config, storage);
  const shellRisk = classifyShellRisk(command, config.sandbox.riskyShellPatterns);
  const approvalBypass = await hasVerifiedApprovalBypass(request, storage);
  if (shellRisk.risky && config.sandbox.requireApprovalForRiskyShell && !approvalBypass) {
    throw new Error(
      `Risky shell command requires approval (matched pattern: ${shellRisk.matchedPattern ?? "unknown"})`,
    );
  }
  const parsed = parseExecFileCommand(command);
  const executable = resolveExecutableCommand(parsed.file, parsed.args);
  await assertBeforeProcessSpawn(runtimeHooks, request, "shell.exec", cwd);
  const outcome = await runShellExecToCompletion(executable, cwd, request.signal);
  return {
    command,
    cwd,
    executable: parsed.file,
    argv: parsed.args,
    ...(typeof outcome.pid === "number" ? { pid: outcome.pid } : {}),
    stdout: scrubSensitiveOutput(outcome.stdout),
    stderr: scrubSensitiveOutput(outcome.stderr),
    exitCode: outcome.exitCode,
  };
}

interface ShellExecOutcome {
  pid?: number;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a resolved shell command via a manual spawn so the whole process TREE can
 * be killed on timeout or abort. On non-Windows we spawn detached to obtain a
 * killable process group; on Windows the tree is reaped with `taskkill /T`.
 * Output is capped at {@link SHELL_EXEC_MAX_BUFFER_BYTES} per stream, matching
 * the previous execFile maxBuffer behavior.
 */
function runShellExecToCompletion(
  executable: { file: string; args: string[] },
  cwd: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ShellExecOutcome> {
  return new Promise<ShellExecOutcome>((resolve) => {
    const posixProcessGroup = process.platform !== "win32";
    const child = spawn(executable.file, executable.args, {
      cwd,
      windowsHide: true,
      detached: posixProcessGroup,
    });

    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    let stderrCapped = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const collect = (chunk: Buffer, isStdout: boolean) => {
      if (isStdout) {
        if (stdoutCapped) {
          return;
        }
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") >= SHELL_EXEC_MAX_BUFFER_BYTES) {
          stdout = stdout.slice(0, SHELL_EXEC_MAX_BUFFER_BYTES);
          stdoutCapped = true;
        }
        return;
      }
      if (stderrCapped) {
        return;
      }
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") >= SHELL_EXEC_MAX_BUFFER_BYTES) {
        stderr = stderr.slice(0, SHELL_EXEC_MAX_BUFFER_BYTES);
        stderrCapped = true;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));

    const killTree = (label: string) => {
      terminateShellProcessTree(child, label, posixProcessGroup, { command: executable.file, cwd });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("shell.exec timeout");
    }, shellExecTimeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killTree("shell.exec abort");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const finish = (exitCode: number, extraStderr?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
        stdout,
        stderr: extraStderr ? (stderr ? `${stderr}\n${extraStderr}` : extraStderr) : stderr,
        exitCode,
      });
    };

    child.once("error", (error) => {
      finish(-1, error instanceof Error ? error.message : String(error));
    });
    child.once("close", (code, closeSignal) => {
      if (timedOut) {
        finish(-1, `shell.exec timed out after ${shellExecTimeoutMs}ms; process tree killed.`);
        return;
      }
      if (aborted) {
        finish(-1, "shell.exec aborted; process tree killed.");
        return;
      }
      if (typeof code === "number") {
        finish(code);
        return;
      }
      finish(-1, closeSignal ? `Process terminated by signal ${closeSignal}.` : undefined);
    });
  });
}

async function shellExecBackground(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  runtimeHooks: ToolExecutorRuntimeHooks,
) {
  const args = request.args;
  const command = required(args.command, "command");
  const cwd = await resolveOptionalCwd(args.cwd, request, config, storage);
  const shellRisk = classifyShellRisk(command, config.sandbox.riskyShellPatterns);
  const approvalBypass = await hasVerifiedApprovalBypass(request, storage);
  if (shellRisk.risky && config.sandbox.requireApprovalForRiskyShell && !approvalBypass) {
    throw new Error(
      `Risky shell command requires approval (matched pattern: ${shellRisk.matchedPattern ?? "unknown"})`,
    );
  }
  const parsed = parseExecFileCommand(command);
  const executable = resolveExecutableCommand(parsed.file, parsed.args);
  await assertBeforeProcessSpawn(runtimeHooks, request, "shell.exec_background", cwd);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(executable.file, executable.args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    const pid = child.pid;
    registerBackgroundProcess(child, command, cwd);
    const onAbort = () => {
      if (typeof pid === "number") {
        killBackgroundProcess(pid);
      }
    };
    if (request.signal) {
      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
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
  const result = await readGitDiffBounded(staged ? ["diff", "--cached"] : ["diff"]);
  return { staged, diffSnippet: result.stdout, truncated: result.truncated };
}

function readGitDiffBounded(args: string[]): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const collect = (chunk: Buffer | string, target: "stdout" | "stderr") => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const isStdout = target === "stdout";
      const limit = isStdout ? GIT_DIFF_SNIPPET_BYTES : GIT_DIFF_ERROR_BYTES;
      const currentBytes = isStdout ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, limit - currentBytes);
      if (remaining > 0) {
        (isStdout ? stdoutChunks : stderrChunks).push(buffer.subarray(0, remaining));
      }
      const acceptedBytes = Math.min(buffer.byteLength, remaining);
      if (isStdout) {
        stdoutBytes += acceptedBytes;
        truncated ||= acceptedBytes < buffer.byteLength;
      } else {
        stderrBytes += acceptedBytes;
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, "stderr"));

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error("git diff timed out after 15000ms"));
    }, 15_000);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, truncated });
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(
        new Error(
          `git diff failed (${code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`}): ${stderr || "no stderr"}`,
        ),
      );
    });
  });
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
  storage: AsyncStorage,
  runtimeHooks: ToolExecutorRuntimeHooks,
) {
  const args = request.args;
  const manager = asString(args.manager) ?? "pnpm";
  const filter = asString(args.filter);
  const cwd = await resolveOptionalCwd(args.cwd, request, config, storage);
  if (filter && !/^[a-zA-Z0-9@/_\-.]+$/.test(filter)) {
    throw new Error(`Invalid filter: ${filter}`);
  }
  if (manager !== "pnpm" && manager !== "npm") {
    throw new Error("Only pnpm/npm are allowed");
  }
  const cmdArgs = manager === "pnpm" ? [...(filter ? ["--filter", filter] : []), "run", kind] : ["run", kind];
  const command = resolveRestrictedCommand(manager, cmdArgs);
  const toolName = `${kind === "test" ? "tests" : kind}.run` as ToolProcessSpawnName;
  await assertBeforeProcessSpawn(runtimeHooks, request, toolName, cwd);
  const { stdout, stderr } = await execFileAsync(command.file, command.args, {
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    cwd,
  });
  return { manager, kind, cwd, stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 10000) };
}

async function assertBeforeProcessSpawn(
  runtimeHooks: ToolExecutorRuntimeHooks,
  request: ToolInvokeRequest,
  toolName: ToolProcessSpawnName,
  cwd: string | undefined,
): Promise<void> {
  if (request.signal?.aborted) {
    throw new ToolBeforeProcessSpawnError(undefined, true);
  }
  try {
    await runtimeHooks.beforeProcessSpawn?.({ toolName, ...(cwd ? { cwd } : {}) });
  } catch (error) {
    throw new ToolBeforeProcessSpawnError(error, false);
  }
  if (request.signal?.aborted) {
    throw new ToolBeforeProcessSpawnError(undefined, true);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (
        !isHttpRequestSafeToRetry(init) ||
        !RETRYABLE_HTTP_STATUSES.has(response.status) ||
        attempt >= MAX_HTTP_RETRIES
      ) {
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
    const next = new URL(location, current).toString();
    assertHostAllowed(next, allowlist);
    if (grantAllowlist && grantAllowlist.length > 0) {
      assertHostAllowed(next, grantAllowlist);
    }
    assertSafeRedirectTransition(current, next, init);
    current = next;
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

async function resolveOptionalCwd(
  value: unknown,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
): Promise<string | undefined> {
  const cwd = asString(value);
  if (!cwd) {
    return undefined;
  }
  await assertReadPathAllowedForRequest(cwd, request, config, storage);
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

async function assertReadPathAllowedForRequest(
  targetPath: string,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage?: AsyncStorage,
): Promise<void> {
  if (await canBypassReadPath(targetPath, request, config, storage)) {
    return;
  }
  assertReadPathAllowed(targetPath, config.sandbox.writeJailRoots, config.sandbox.readOnlyRoots);
}

async function canBypassReadPath(
  targetPath: string,
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage?: AsyncStorage,
): Promise<boolean> {
  const readAccessMode = getStrictestReadAccessMode(
    config.sandbox.readAccessMode,
    request.policyContext?.permissionProfile?.readAccessMode,
  );
  const matchedExecutionGrant = await resolveMatchedExecutionAllowGrant(request, storage);
  const matchedAllowedPaths = matchedExecutionGrant ? getAllowedGrantReadPaths(matchedExecutionGrant) : [];
  if (matchedAllowedPaths.length > 0) {
    const resolvedPath = resolveReadPathAccess(
      targetPath,
      config.sandbox.writeJailRoots,
      config.sandbox.readOnlyRoots,
    ).resolvedPath;
    return isPathWithinAnyGrantRoot(resolvedPath, matchedAllowedPaths);
  }
  const grants = await resolveMatchingAllowGrants(request, storage);
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
  if (readAccessMode === "approval_required" && storage && (await hasVerifiedApprovalBypass(request, storage))) {
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

async function resolveExecutionGrantAllowedHosts(
  request: ToolInvokeRequest,
  storage?: AsyncStorage,
): Promise<string[] | undefined> {
  const contextHosts = request.policyContext?.matchedGrantAllowedHosts
    ?.map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (contextHosts && contextHosts.length > 0) {
    return contextHosts;
  }
  if (request.policyContext?.matchedGrantId) {
    const matchedGrant = await resolveMatchedExecutionAllowGrant(request, storage);
    const grantHosts = matchedGrant?.constraints?.allowedHosts?.map((host) => host.trim()).filter(Boolean);
    return grantHosts && grantHosts.length > 0 ? grantHosts : undefined;
  }
  const matchingGrant = (await resolveMatchingAllowGrants(request, storage)).find(
    (grant) => (grant.constraints?.allowedHosts?.length ?? 0) > 0,
  );
  const grantHosts = matchingGrant?.constraints?.allowedHosts?.map((host) => host.trim()).filter(Boolean);
  return grantHosts && grantHosts.length > 0 ? grantHosts : undefined;
}

async function resolveMatchedExecutionAllowGrant(
  request: ToolInvokeRequest,
  storage?: AsyncStorage,
): Promise<ToolGrantRecord | undefined> {
  const grantId = request.policyContext?.matchedGrantId?.trim();
  const grantRepo = storage?.toolGrants;
  if (!grantId || !grantRepo) {
    return undefined;
  }
  try {
    const grant = await grantRepo.findActive(grantId);
    if (!grant) {
      return undefined;
    }
    if (grant.decision !== "allow" || !matchesGrantToolPattern(grant.toolPattern, request.toolName)) {
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

async function resolveMatchingAllowGrants(
  request: ToolInvokeRequest,
  storage?: AsyncStorage,
): Promise<ToolGrantRecord[]> {
  const grantRepo = storage?.toolGrants;
  if (!grantRepo?.listActive) {
    return [];
  }
  const grants: ToolGrantRecord[] = [];
  for (const candidate of buildGrantScopeCandidates(request)) {
    const scoped = (await grantRepo.listActive(candidate.scope, candidate.scopeRef))
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

function isPathWithinAnyGrantRoot(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = normalizePathForGrantMatch(candidate);
  return roots.some((root) => {
    if (root.trim() === "*") {
      return true;
    }
    return normalizePathVariantsForGrantMatch(root).some(
      (resolvedRoot) => resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`),
    );
  });
}

function normalizePathForGrantMatch(candidate: string): string {
  return path.resolve(candidate).replace(/\\/g, "/").toLowerCase();
}

function normalizePathVariantsForGrantMatch(candidate: string): string[] {
  const resolvedCandidate = normalizePathForGrantMatch(candidate);
  try {
    const realCandidate = fsSync.realpathSync(path.resolve(candidate)).replace(/\\/g, "/").toLowerCase();
    return realCandidate === resolvedCandidate ? [resolvedCandidate] : [resolvedCandidate, realCandidate];
  } catch {
    return [resolvedCandidate];
  }
}
