import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
  captureBackgroundProcessIdentity,
  cleanupRecoveredBackgroundProcess,
  readBackgroundProcessIdentity,
} from "./background-process-identity.js";

const owner = { sessionId: "owned-test-session", turnId: "owned-test-turn" };
describe("retained background process identity", () => {
  it("refuses unknown shape, copied owner, host drift and current-process targets", async () => {
    const identity = {
      version: "background-process.identity.v1",
      platform: "win32",
      host: hostname(),
      pid: process.pid,
      creationFileTime: "134000000000000000",
      ...owner,
    };
    expect(readBackgroundProcessIdentity({ ...identity, extra: "forged" }, owner)).toBeUndefined();
    expect(readBackgroundProcessIdentity(identity, { ...owner, turnId: "foreign" })).toBeUndefined();
    expect(await cleanupRecoveredBackgroundProcess({ ...identity, host: "foreign" }, owner)).toBe("identity_mismatch");
    expect(await cleanupRecoveredBackgroundProcess(identity, owner)).toBe("identity_mismatch");
  });

  it.runIf(process.platform === "win32")(
    "checks Windows creation time and terminates only the matching process through the same handle",
    async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await once(child, "spawn");
      try {
        const identity = await captureBackgroundProcessIdentity(child, owner);
        expect(identity).toMatchObject({ ...owner, pid: child.pid, platform: "win32" });
        expect(
          await cleanupRecoveredBackgroundProcess({ ...identity, creationFileTime: "134000000000000000" }, owner),
        ).toBe("identity_mismatch");
        expect(child.exitCode).toBeNull();
        const exit = once(child, "exit");
        expect(await cleanupRecoveredBackgroundProcess(identity, owner)).toBe("terminated");
        await exit;
        expect(await captureBackgroundProcessIdentity(child, owner)).toBeUndefined();
        expect(await cleanupRecoveredBackgroundProcess(identity, owner)).toBe("missing");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    },
    45_000,
  );
});
