import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

function createStorageStub(): Storage & AsyncStorage {
  return {
    runImmediateTransaction: vi.fn(async <T>(work: () => T | Promise<T>): Promise<T> => await work()),
    approvals: {
      create: vi.fn((input) => ({
        approvalId: "approval-operator-roots",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        createdAt: "2026-10-16T00:00:00.000Z",
        expiresAt: input.expiresAt,
        explanationStatus: "not_requested",
      })),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: { list: vi.fn(() => []), listActive: vi.fn(() => []), consumeOne: vi.fn() },
    pendingApprovalActions: { upsertPending: vi.fn(), find: vi.fn(() => undefined), markResolved: vi.fn() },
    db: { prepare: vi.fn(() => ({ run: vi.fn() })) },
  } as unknown as Storage & AsyncStorage;
}

const base = path.join(os.tmpdir(), "goat-engine-operator-roots");
const runtimeRoot = path.join(base, "runtime");
const jailRoot = path.join(runtimeRoot, "data");
const secretsDir = path.join(jailRoot, "secrets");
const writeOnlyRoot = path.join(base, "write-only");
const deletableRoot = path.join(base, "temp-like");

function createConfig(deny: string[] = []): ToolPolicyConfig {
  return {
    tools: { approvalMode: "bypass", allow: ["*"], deny },
    agents: {},
    sandbox: {
      writeJailRoots: [jailRoot],
      readOnlyRoots: [],
      readAccessMode: "roots_only",
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
      operatorWriteRoots: [
        { path: writeOnlyRoot, allowDelete: false },
        { path: deletableRoot, allowDelete: true },
      ],
      runtimeWriteProtection: { rootDir: runtimeRoot, protectedPaths: [secretsDir] },
    },
  };
}

async function evaluate(engine: ToolPolicyEngine, toolName: string, args: Record<string, unknown>) {
  return await engine.evaluateAccess({ toolName, args, agentId: "agent", sessionId: "session" });
}

describe("ToolPolicyEngine operator write roots", () => {
  it("admits writes into operator roots and deletes only where the root opted in", async () => {
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub());

    expect((await evaluate(engine, "fs.write", { path: path.join(writeOnlyRoot, "a.txt") })).allowed).toBe(true);
    expect((await evaluate(engine, "fs.delete", { path: path.join(deletableRoot, "a.txt") })).allowed).toBe(true);

    const blockedDelete = await evaluate(engine, "fs.delete", { path: path.join(writeOnlyRoot, "a.txt") });
    expect(blockedDelete.allowed).toBe(false);
    expect(blockedDelete.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("treats the source of a move as a delete", async () => {
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub());
    const move = await evaluate(engine, "fs.move", {
      from: path.join(writeOnlyRoot, "a.txt"),
      to: path.join(jailRoot, "a.txt"),
    });
    expect(move.allowed).toBe(false);
    expect(move.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("refuses deleting an operator root itself and runtime-protected targets", async () => {
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub());

    const rootDelete = await evaluate(engine, "fs.delete", { path: deletableRoot, recursive: true });
    expect(rootDelete.allowed).toBe(false);
    expect(rootDelete.reasonCodes).toEqual(["structural_safety_block"]);

    const secretWrite = await evaluate(engine, "fs.write", { path: path.join(secretsDir, "vault.bin") });
    expect(secretWrite.allowed).toBe(false);
    expect(secretWrite.reasonCodes).toEqual(["structural_safety_block"]);
  });

  it("lets filesystem reads list operator roots under roots_only read access", async () => {
    const engine = new ToolPolicyEngine(createConfig(), createStorageStub());
    expect((await evaluate(engine, "fs.list", { path: deletableRoot })).allowed).toBe(true);
    expect((await evaluate(engine, "fs.list", { path: path.join(base, "elsewhere") })).allowed).toBe(false);
  });

  it("keeps deny-wins authoritative inside an operator root", async () => {
    const engine = new ToolPolicyEngine(createConfig(["fs.delete"]), createStorageStub());
    const denied = await evaluate(engine, "fs.delete", { path: path.join(deletableRoot, "a.txt") });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCodes).not.toContain("structural_safety_block");
  });
});
