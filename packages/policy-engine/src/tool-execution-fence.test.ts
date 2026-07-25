import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { ToolExecutionPreconditionError, ToolPolicyEngine } from "./engine.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ToolPolicyEngine execution fence", () => {
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
    const engine = new ToolPolicyEngine(policy, storage);
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
      storage.close();
    }
  });

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
    const engine = new ToolPolicyEngine(createPolicy(root), storage);
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
      storage.close();
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
    const engine = new ToolPolicyEngine(createPolicy(root), storage);
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
      storage.close();
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
