import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";

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
});
