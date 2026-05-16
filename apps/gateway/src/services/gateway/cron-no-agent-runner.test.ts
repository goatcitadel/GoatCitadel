import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runNoAgentCommand } from "./cron-no-agent-runner.js";

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
});
