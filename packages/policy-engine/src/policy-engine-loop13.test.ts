import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
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
    profiles: { danger: ["*"] },
    tools: { profile: "danger", approvalMode, allow: [], deny: [] },
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

  it("quotes Windows package-manager commands and leaves non-package managers untouched", async () => {
    const win = resolveRestrictedCommand("pnpm", ["--filter", "@scope/pkg name", "run", "test"], "win32");
    expect(win.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(win.args.join(" ")).toContain('"@scope/pkg name"');

    const npm = resolveExecutableCommand("npm", ["run", "build&check", "C:\\temp tail\\"], "win32");
    expect(npm.args.join(" ")).toContain('"build^&check"');
    expect(npm.args.join(" ")).toContain('"C:\\temp tail\\\\"');

    expect(resolveExecutableCommand("git", ["status"], "win32")).toEqual({ file: "git", args: ["status"] });
    expect(resolveExecutableCommand("pnpm", ["test"], "linux")).toEqual({ file: "pnpm", args: ["test"] });
  });
});
