import { describe, expect, it, vi } from "vitest";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

type Preflight = (input: {
  toolName: string;
  rawArgs: Record<string, unknown>;
  userContent: string;
  historyMessages: Array<{ role: "user"; content: string }>;
  webMode: "auto";
  mode: "chat";
}) => { toolName: string; args: Record<string, unknown>; failureReason?: string; blockedReason?: string };

function preflightFor(toolName: string): Preflight {
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([toolName]),
    createChatCompletion: vi.fn(),
    invokeTool: vi.fn(),
  });
  const preflight = (runner as unknown as { preflightToolInvocation: Preflight }).preflightToolInvocation;
  return preflight.bind(runner);
}

const base = {
  userContent: "convert the report to a pdf",
  historyMessages: [{ role: "user" as const, content: "convert the report to a pdf" }],
  webMode: "auto" as const,
  mode: "chat" as const,
};

describe("shell script preflight", () => {
  it("fails a PowerShell script sent to shell.exec_background before approval is requested", () => {
    const command = "$dir='C:\\workspace\\artifacts'\n$pdf=Join-Path $dir 'report.pdf'\n& msedge --headless";
    const result = preflightFor("shell.exec_background")({
      ...base,
      toolName: "shell.exec_background",
      rawArgs: { command },
    });

    expect(result.failureReason).toMatch(
      /^execution error: shell\.exec_background runs one program with its arguments and does not start a shell/u,
    );
    expect(result.failureReason).toContain("pwsh -NoProfile -Command");
    expect(result.blockedReason).toBeUndefined();
  });

  it("fails a piped shell.exec command", () => {
    const result = preflightFor("shell.exec")({
      ...base,
      toolName: "shell.exec",
      rawArgs: { command: "rg foo | head" },
    });

    expect(result.failureReason).toContain("a pipe (|) cannot work");
  });

  it("passes a single program with arguments through unchanged", () => {
    const command = "msedge --headless --print-to-pdf=C:\\out\\report.pdf C:\\out\\report.html";
    const result = preflightFor("shell.exec")({ ...base, toolName: "shell.exec", rawArgs: { command } });

    expect(result).toEqual({ toolName: "shell.exec", args: { command } });
  });
});
