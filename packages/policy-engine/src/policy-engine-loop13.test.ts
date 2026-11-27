import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { redactSecretText } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { withLegacyToolApprovalPreview } from "./knowledge-approval-preview.js";
import { resolveExecutableCommand, resolveRestrictedCommand } from "./tool-executor.js";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = path.join(os.tmpdir(), `goatcitadel-policy-loop13-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  createdDirs.push(root);
  return root;
}

function createConfig(
  root: string,
  approvalMode: ToolPolicyConfig["tools"]["approvalMode"] = "approve_risky",
): ToolPolicyConfig {
  return {
    tools: { approvalMode, allow: ["*"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: ["Remove-Item"],
      requireApprovalForRiskyShell: true,
    },
  };
}

function createStorageStub(): AsyncStorage {
  return {
    runImmediateTransaction: vi.fn(
      async <T>(operation: () => T | Promise<T>): Promise<Awaited<T>> => await operation(),
    ),
    approvals: {
      create: vi.fn(async (input) => ({
        approvalId: "approval-loop13",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-05-14T00:00:00.000Z",
        expiresAt: input.expiresAt,
        explanationStatus: "not_requested",
      })),
      createWithTtlDuration: vi.fn(async (input, ttlMs) => ({
        approvalId: "approval-loop13",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        explanationStatus: "not_requested",
      })),
    },
    approvalEvents: { append: vi.fn(async () => undefined) },
    audit: { append: vi.fn(async () => undefined) },
    db: { prepare: vi.fn(() => ({ run: vi.fn(async () => undefined) })) },
    pendingApprovalActions: {
      find: vi.fn(async () => undefined),
      markResolved: vi.fn(async () => undefined),
      upsertPending: vi.fn(async () => undefined),
    },
    toolAccessDecisions: {
      countToolCallsInLastHourInScope: vi.fn(async () => 0),
      countWritesInLastHourInScope: vi.fn(async () => 0),
      record: vi.fn(async () => undefined),
    },
    toolGrants: {
      consumeOne: vi.fn(async () => true),
      list: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
    },
  } as unknown as AsyncStorage;
}

function request(toolName: string, args: Record<string, unknown> = {}) {
  return {
    toolName,
    args,
    agentId: "agent-loop13",
    sessionId: "session-loop13",
  };
}

describe("policy engine loop13 branch tails", () => {
  it("executes low-risk tools and evaluates write targets from to/from fallback paths", async () => {
    const root = createRoot();
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(createConfig(root), storage);

    await expect(engine.invoke(request("session.status"))).resolves.toMatchObject({
      outcome: "executed",
      result: { sessionId: "session-loop13", status: "unavailable" },
    });

    expect(await engine.evaluateAccess(request("fs.move", { to: path.join(root, "dest.txt") }))).toMatchObject({
      allowed: true,
    });
    expect(await engine.evaluateAccess(request("fs.delete", { from: path.join(root, "obsolete.txt") }))).toMatchObject({
      allowed: true,
    });
    expect(await engine.evaluateAccess(request("fs.delete"))).toMatchObject({
      allowed: false,
      reasonCodes: expect.arrayContaining(["structural_safety_block"]),
    });
  });

  it("builds approval previews from target and command fallbacks without executing risky tools", async () => {
    const root = createRoot();
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(createConfig(root), storage);

    await expect(engine.invoke(request("shell.exec", { command: "Remove-Item old.txt" }))).resolves.toMatchObject({
      outcome: "approval_required",
    });
    expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          command: "Remove-Item old.txt",
        }),
      }),
      expect.any(Number),
    );

    await expect(engine.invoke(request("http.post", { host: "example.com" }))).resolves.toMatchObject({
      outcome: "approval_required",
    });
    expect(storage.approvals.createWithTtlDuration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          target: "example.com",
        }),
      }),
      expect.any(Number),
    );
  });

  it("saves the reviewed default channel destination without changing the executable message arguments", async () => {
    const root = createRoot();
    const storage = createStorageStub();
    const connection = {
      connectionId: "updates-channel",
      revision: "connection-version-1",
      kind: "channel",
      key: "slack",
      label: "Updates",
      config: { defaultChannel: "C-FIXTURE" },
    };
    Object.assign(storage, { integrationConnections: { get: vi.fn(async () => connection) } });
    const engine = new ToolPolicyEngine(createConfig(root), storage);
    const args = { connectionId: connection.connectionId, message: "Local approval review fixture" };
    await expect(engine.invoke(request("channel.send", args))).resolves.toMatchObject({ outcome: "approval_required" });
    expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: args,
        preview: expect.objectContaining({
          reviewKind: "communications.operation",
          target: "C-FIXTURE",
          input: args.message,
        }),
      }),
      expect.any(Number),
    );
    expect(storage.pendingApprovalActions.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ args, defaultChannelConnectionRevision: connection.revision }),
      }),
    );
  });

  it.each([
    ["capabilities.search", { query: "browser controls" }, { query: "browser controls" }],
    ["skills.read", { skillId: "bundled:notes" }, { input: "Skill id: bundled:notes\nRelative path: SKILL.md" }],
    ["session.status", {}, { input: "No additional selectors" }],
    ["context.list", {}, { input: "No additional selectors" }],
    ["context.grep", { pattern: "budget", caseSensitive: false }, { input: "Pattern: budget\nCase sensitive: false" }],
    ["context.query", { query: "budget", entryIndex: 0 }, { input: "Query: budget\nEntry index: 0" }],
    [
      "context.read_range",
      { entryIndex: 0, startLine: 1, endLine: 3 },
      { input: "Entry index: 0\nStart line: 1\nEnd line: 3" },
    ],
    ["project.files.list", { prefix: "drafts", limit: 3 }, { input: "Prefix: drafts\nLimit: 3" }],
    ["project.files.read", { path: "draft.md" }, { input: "Path: draft.md" }],
    ["fs.list", { path: "." }, { input: "Path: ." }],
    [
      "file.read_range",
      { path: "draft.md", startLine: 2, endLine: 3 },
      { input: "Path: draft.md\nStart line: 2\nEnd line: 3" },
    ],
    ["file.find", { path: ".", pattern: "budget" }, { input: "Path: .\nPattern: budget" }],
    ["code.search", { path: ".", query: "budget" }, { input: "Path: .\nQuery: budget" }],
    ["code.search_files", { path: ".", query: "draft" }, { input: "Path: .\nQuery: draft" }],
    ["docs.read_bytes", { attachmentId: "attachment", length: 32 }, { input: "Attachment id: attachment\nLength: 32" }],
    [
      "docs.extract_text",
      { attachmentId: "attachment", maxChars: 32 },
      { input: "Attachment id: attachment\nMax chars: 32" },
    ],
    [
      "user_input.request",
      { title: "Layout", question: "Compact or spacious?" },
      { input: "Title: Layout\nQuestion: Compact or spacious?" },
    ],
    [
      "chat.reminder.preview",
      { localDueAt: "2026-11-28T10:00", timezone: "America/Los_Angeles" },
      { input: "Local due at: 2026-11-28T10:00\nTimezone: America/Los_Angeles" },
    ],
    [
      "document.propose_patch",
      { targetKind: "personal_note", targetId: "note", proposedContent: "New text" },
      { input: "Target kind: personal_note\nTarget id: note\nProposed content: New text" },
    ],
    ["runtime.configure", { targetId: "search.brave" }, { input: "Target id: search.brave" }],
  ] as const)("projects new and saved Approve All reviews for %s", async (toolName, args, reviewed) => {
    const root = createRoot();
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(createConfig(root, "approve_all"), storage);
    const expected = { reviewKind: "knowledge.operation", toolName, ...reviewed };

    // Managed project reads have their own admission path. Exercise their saved review projection below.
    if (!toolName.startsWith("project.files.")) {
      const invokeArgs = "path" in args ? { ...args, path: path.join(root, args.path) } : args;
      await expect(engine.invoke(request(toolName, invokeArgs))).resolves.toMatchObject({
        outcome: "approval_required",
      });
      expect(storage.approvals.createWithTtlDuration).toHaveBeenCalledWith(
        expect.objectContaining({
          preview: expect.objectContaining({
            ...expected,
            ...("path" in args && "input" in reviewed
              ? {
                  input: reviewed.input.replace(
                    `Path: ${args.path}`,
                    `Path: ${redactSecretText(path.join(root, args.path), { env: process.env }).value}`,
                  ),
                }
              : {}),
          }),
        }),
        expect.any(Number),
      );
    }
    const legacy: ApprovalRequest = {
      approvalId: "legacy-local-read",
      kind: toolName,
      riskLevel: "safe",
      status: "pending",
      explanationStatus: "not_requested",
      createdAt: "2026-11-27T00:00:00Z",
      payload: args,
      preview: { toolName },
      linkage: { actionType: "tool.invoke", toolName },
    };
    expect(withLegacyToolApprovalPreview(legacy).preview).toMatchObject(expected);
  });

  it("quotes Windows package-manager commands and leaves non-package managers untouched", async () => {
    const win = resolveRestrictedCommand("pnpm", ["--filter", "@scope/pkg name", "run", "test"], "win32");
    expect(win.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(win.args.join(" ")).toContain('^"@scope/pkg^ name^"');

    const npm = resolveExecutableCommand("npm", ["run", "build&check", "C:\\temp tail\\"], "win32");
    expect(npm.args.join(" ")).toContain('^"build^&check^"');
    expect(npm.args.join(" ")).toContain('^"C:\\temp^ tail\\\\^"');

    expect(resolveExecutableCommand("git", ["status"], "win32")).toEqual({ file: "git", args: ["status"] });
    expect(resolveExecutableCommand("pnpm", ["test"], "linux")).toEqual({ file: "pnpm", args: ["test"] });
  });
});
