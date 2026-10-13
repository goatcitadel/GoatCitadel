import { afterEach, describe, expect, it, vi } from "vitest";
import { recordPreparedPromptDiagnostics } from "./llm-prompt-diagnostics.js";
import { createLlmStreamAttemptObserver } from "./llm-stream-attempt-observer.js";

afterEach(() => vi.restoreAllMocks());
describe("secret-free normalized prompt diagnostics", () => {
  it("retains stable hashes and size estimates without prompt, tool content, or metadata", () => {
    const host = { recordDevDiagnostic: vi.fn() };
    const request = {
      messages: [
        { role: "system" as const, content: "private instruction" },
        { role: "user" as const, content: "private user content" },
      ],
      metadata: { private: "private metadata" },
      tools: [
        {
          type: "function",
          function: { name: "tool", description: "private description", parameters: { type: "object" } },
        },
      ],
    };
    recordPreparedPromptDiagnostics(host, request, Date.now());
    recordPreparedPromptDiagnostics(host, structuredClone(request), Date.now());
    const [first, second] = host.recordDevDiagnostic.mock.calls.map(([event]) => event.context);
    expect(first.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    expect(first.estimatedSchemaTokens).toBeGreaterThan(0);
    expect(JSON.stringify(host.recordDevDiagnostic.mock.calls)).not.toContain("private");
    recordPreparedPromptDiagnostics(
      host,
      { ...request, messages: [...request.messages, { role: "user", content: "next turn" }] },
      Date.now(),
    );
    const changed = host.recordDevDiagnostic.mock.lastCall![0].context;
    expect(changed.promptSha256).not.toBe(first.promptSha256);
    expect(changed.systemBlockHashes).toEqual(first.systemBlockHashes);
    expect(changed.schemasSha256).toBe(first.schemasSha256);
  });
  it("bounds system-block evidence and marks truncation explicitly", () => {
    const host = { recordDevDiagnostic: vi.fn() };
    recordPreparedPromptDiagnostics(
      host,
      { messages: Array.from({ length: 130 }, () => ({ role: "system", content: "value" })) },
      Date.now(),
    );
    expect(host.recordDevDiagnostic.mock.lastCall![0].context).toMatchObject({
      systemBlockCount: 130,
      systemBlockHashesTruncated: true,
    });
    expect(host.recordDevDiagnostic.mock.lastCall![0].context.systemBlockHashes).toHaveLength(128);
  });
});
describe("first useful model output timing", () => {
  it("separates role, reasoning, whitespace and usage chunks from text, once per attempt", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const host = { recordDevDiagnostic: vi.fn() };
    const observe = createLlmStreamAttemptObserver(host, { completionStartedAt: 500 })("provider", "model", false);
    clock.mockReturnValue(1100);
    observe({ choices: [{ delta: { role: "assistant" } }] });
    observe({ choices: [{ delta: { reasoning_content: "hidden", content: " " } }], usage: { prompt_tokens: 1 } });
    expect(host.recordDevDiagnostic.mock.calls.map(([event]) => event.event)).not.toContain(
      "chat.completion_stream.provider_attempt.first_useful_output",
    );
    clock.mockReturnValue(1300);
    observe({ choices: [{ delta: { content: "answer" } }] });
    observe({ choices: [{ delta: { content: "more" } }] });
    const events = host.recordDevDiagnostic.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.event.endsWith(".first_chunk"))).toHaveLength(1);
    expect(events.filter((event) => event.event.endsWith(".first_useful_output"))).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          outputKind: "text",
          elapsedSinceAttemptStartMs: 300,
          elapsedSinceCompletionStartMs: 800,
        }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("hidden");
  });
  it("records a named tool call without storing its arguments", () => {
    const host = { recordDevDiagnostic: vi.fn() };
    const observe = createLlmStreamAttemptObserver(host, { completionStartedAt: Date.now() })(
      "provider",
      "model",
      false,
    );
    observe({ choices: [{ delta: { tool_calls: [{ function: { name: "fs_read", arguments: "private path" } }] } }] });
    expect(host.recordDevDiagnostic.mock.lastCall![0].context.outputKind).toBe("tool_call");
    expect(JSON.stringify(host.recordDevDiagnostic.mock.calls)).not.toContain("private path");
  });
});
