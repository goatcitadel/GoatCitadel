import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: fixture.spawn,
}));
import { executeTool } from "./tool-executor.js";

describe("OpenCode process result integration", () => {
  it("projects only redacted CLI output after the existing process precondition", async () => {
    const beforeProcessSpawn = vi.fn();
    fixture.spawn.mockImplementation(() => {
      expect(beforeProcessSpawn).toHaveBeenCalledWith({ toolName: "shell.exec", cwd: undefined });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "text",
            sessionID: "ses_fixture",
            part: { type: "text", text: `Do not expose Bearer ${"a".repeat(24)}` },
          }) + "\n",
        );
        child.emit("close", 0, null);
      });
      return child;
    });
    const config = {
      sandbox: { riskyShellPatterns: [], requireApprovalForRiskyShell: true },
    } as unknown as ToolPolicyConfig;
    const result = await executeTool(
      {
        toolName: "shell.exec",
        agentId: "assistant",
        sessionId: "session-fixture",
        args: { command: "opencode run --format json --agent plan -- review", timeoutMs: 300000 },
      },
      config,
      {} as AsyncStorage,
      { beforeProcessSpawn },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      timeoutMs: 300000,
      externalAgent: { engine: "opencode", sessionId: "ses_fixture", text: "Do not expose [REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toContain("a".repeat(24));
    expect(fixture.spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  });
});
