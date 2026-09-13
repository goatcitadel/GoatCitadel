import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { ToolExecutionPreconditionError, ToolPolicyEngine } from "./engine.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ToolPolicyEngine execution fence", () => {
  it.each(["complete", "fail"] as const)(
    "awaits durable effect recording before a file mutation (%s)",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-effect-marker-"));
      tempRoots.push(root);
      const source = path.join(root, "source.txt"),
        destination = path.join(root, "destination.txt");
      await fs.writeFile(source, "bounded fixture");
      const storage = new Storage({
        dbPath: ":memory:",
        transcriptsDir: path.join(root, "transcripts"),
        auditDir: path.join(root, "audit"),
      });
      const asyncStorage = createSqliteAsyncStorage(storage);
      const engine = new ToolPolicyEngine(createPolicy(root), asyncStorage);
      let release!: () => void;
      let entered!: () => void;
      const markerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const markerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const markerFailure = new Error("durable boundary unavailable");
      const invocation = engine.invoke(
        {
          toolName: "fs.copy",
          args: { from: source, to: destination },
          agentId: "assistant",
          sessionId: "effect-marker-session",
        },
        {
          externalSideEffect: {
            markStarted: async () => {
              entered();
              await markerGate;
              if (mode === "fail") throw markerFailure;
            },
            markNotRequired: () => undefined,
          },
        },
      );
      // Attach rejection handling before releasing the gate.
      const observed = invocation.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await markerEntered;
        await expect(fs.access(destination)).rejects.toThrow();
        release();
        const outcome = await observed;
        if (mode === "complete") {
          expect(outcome).toMatchObject({ result: { outcome: "executed" } });
          expect(await fs.readFile(destination, "utf8")).toBe("bounded fixture");
        } else {
          expect(outcome).toEqual({ error: markerFailure });
          await expect(fs.access(destination)).rejects.toThrow();
        }
      } finally {
        release();
        await observed;
        await asyncStorage.close();
      }
    },
    20_000,
  );
  it("checks durable ownership at the concrete executor boundary before fs.copy starts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tool-fence-"));
    tempRoots.push(root);
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "copy me", "utf8");
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const policy: ToolPolicyConfig = {
      tools: {
        approvalMode: "bypass",
        profile: "danger",
        allow: ["*"],
        deny: [],
      },
      agents: {},
      sandbox: {
        writeJailRoots: [root],
        readOnlyRoots: [root],
        readAccessMode: "full_disk",
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    };
    const asyncStorage = createSqliteAsyncStorage(storage);
    const engine = new ToolPolicyEngine(policy, asyncStorage);
    const lostLease = new Error("durable worker lease was taken over");
    lostLease.name = "DurableWorkerInterruptionError";
    const beforeExecute = vi.fn(() => {
      throw lostLease;
    });

    try {
      await expect(
        engine.invoke(
          {
            toolName: "fs.copy",
            args: { from: source, to: destination },
            agentId: "assistant",
            sessionId: "session-tool-fence",
          },
          { beforeExecute },
        ),
      ).rejects.toBe(lostLease);

      expect(beforeExecute).toHaveBeenCalledTimes(1);
      await expect(fs.access(destination)).rejects.toThrow();
    } finally {
      await asyncStorage.close();
    }
  }, 20_000);

  it.each([
    ["shell.exec", { command: "node --version" }],
    ["shell.exec_background", { command: "node --version" }],
    ["tests.run", { manager: "pnpm" }],
    ["lint.run", { manager: "pnpm" }],
    ["build.run", { manager: "pnpm" }],
  ] as const)("awaits the async precondition at the deepest %s process boundary", async (toolName, args) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tool-process-fence-"));
    tempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const engine = new ToolPolicyEngine(createPolicy(root), asyncStorage);
    const boundaries: unknown[] = [];

    try {
      const result = await engine.invoke(
        {
          toolName,
          args: { ...args, cwd: root },
          agentId: "assistant",
          sessionId: `session-${toolName}`,
        },
        {
          beforeExecute: async (boundary) => {
            await Promise.resolve();
            boundaries.push(boundary);
            throw new ToolExecutionPreconditionError("workspace path identity drifted", {
              workspacePathBridge: { status: "blocked", reasonCode: "git_identity_mismatch" },
            });
          },
        },
      );

      expect(result).toMatchObject({
        outcome: "blocked",
        policyReason: "blocked: workspace path identity drifted",
        result: { workspacePathBridge: { status: "blocked", reasonCode: "git_identity_mismatch" } },
      });
      expect(boundaries).toEqual([{ toolName, cwd: root }]);
    } finally {
      await asyncStorage.close();
    }
  });

  it("still propagates a durable fence failure from the deepest process boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tool-process-lease-"));
    tempRoots.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const engine = new ToolPolicyEngine(createPolicy(root), asyncStorage);
    const leaseError = new Error("durable worker lease was taken over");
    leaseError.name = "DurableWorkerInterruptionError";

    try {
      await expect(
        engine.invoke(
          {
            toolName: "shell.exec",
            args: { command: "node --version", cwd: root },
            agentId: "assistant",
            sessionId: "session-shell-lease",
          },
          { beforeExecute: async () => Promise.reject(leaseError) },
        ),
      ).rejects.toBe(leaseError);
    } finally {
      await asyncStorage.close();
    }
  });
});

function createPolicy(root: string): ToolPolicyConfig {
  return {
    tools: { approvalMode: "bypass", profile: "danger", allow: ["*"], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      readAccessMode: "full_disk",
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}
