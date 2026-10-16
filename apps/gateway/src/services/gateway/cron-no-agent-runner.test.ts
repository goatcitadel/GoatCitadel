import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NO_AGENT_MAX_OUTPUT_CHARS, NO_AGENT_SETTLE_GRACE_MS, runNoAgentCommand } from "./cron-no-agent-runner.js";

/**
 * Grandchild spawn mode that survives a plain kill of its parent on each platform. On Windows a
 * Node child's ordinary children sit in libuv's kill-on-close job and die with it anyway, so the
 * grandchild is detached (outside that job, still in the parent-pid tree that `taskkill /T` walks).
 * Elsewhere it stays in the parent's process group: it outlives a SIGKILL of its parent alone, but
 * not the process-group kill.
 */
const DETACH_GRANDCHILD = process.platform === "win32";

describe("runNoAgentCommand", () => {
  it("returns empty stdout for a command that prints nothing", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "rem"] : ["-c", "true"],
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures stdout verbatim from a non-empty echo", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "echo alert"] : ["-c", "printf 'alert'"],
    });
    expect(result.stdout.trim()).toBe("alert");
    expect(result.exitCode).toBe(0);
  });

  it("runs in the configured workdir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-agent-cwd-"));
    try {
      const result = await runNoAgentCommand({
        command: process.platform === "win32" ? "cmd" : "sh",
        args: process.platform === "win32" ? ["/c", "cd"] : ["-c", "pwd"],
        workdir: dir,
      });
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the process after timeoutMs and reports timedOut=true", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "ping -n 5 127.0.0.1 > NUL"] : ["-c", "sleep 5"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });

  it("settles after the grace window even when a surviving grandchild keeps stdio open", async () => {
    const timeoutMs = 500;
    const startedAt = Date.now();
    const result = await runNoAgentCommand({
      command: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: ${DETACH_GRANDCHILD} });`,
          "process.stdout.write(String(g.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      timeoutMs,
      // Kill only the direct child, so the grandchild survives holding the inherited pipes.
      killProcessTree: (child) => {
        child.kill("SIGKILL");
      },
    });
    const elapsedMs = Date.now() - startedAt;
    const grandchildPid = Number(result.stdout);
    try {
      expect(result.timedOut).toBe(true);
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      expect(elapsedMs).toBeLessThan(timeoutMs + NO_AGENT_SETTLE_GRACE_MS + 1500);
      // The grandchild really survived, so the forced settle (not a "close" event) ended the run.
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 15_000);

  it("keeps exactly the output tail across many chunks", async () => {
    const result = await runNoAgentCommand({
      command: process.execPath,
      args: [
        "-e",
        "for (let i = 0; i < 300; i += 1) process.stdout.write('b'.repeat(5000)); process.stdout.write('TAIL-END')",
      ],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(NO_AGENT_MAX_OUTPUT_CHARS);
    expect(result.stdout.endsWith("TAIL-END")).toBe(true);
  });

  it("does not mark short output as truncated", async () => {
    const result = await runNoAgentCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('short')"],
    });
    expect(result.stdout).toBe("short");
    expect(result.stdoutTruncated).toBeUndefined();
  });
});
