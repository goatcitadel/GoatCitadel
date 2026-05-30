import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, MemoryContextPack } from "@goatcitadel/contracts";
import {
  buildMemoryContextSystemMessage,
  calculateSavings,
  createChatCompletionDeadline,
  delayChatCompletionRetry,
  extractPromptFromMessages,
  getRemainingChatCompletionTimeoutMs,
  classifyProviderFailure,
  normalizeChatCompletionAttemptError,
  normalizeToolProtocolRetryRequest,
  shouldAttemptCrossProviderFallback,
  shouldRetryToolProtocolError,
  shouldRetryTransientProviderError,
} from "./llm-completion-helpers.js";

describe("llm-completion-helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts the latest usable user prompt from mixed message content", () => {
    expect(
      extractPromptFromMessages([
        { role: "user", content: "older request" },
        { role: "assistant", content: "answer" },
        {
          role: "user",
          content: [
            { type: "input_text", text: "latest" },
            { type: "input_image", image_url: "data:image/png;base64,abc" },
            { type: "text", text: "request" },
          ] as never,
        },
      ]),
    ).toBe("latest\n\nrequest");

    expect(
      extractPromptFromMessages([
        { role: "system", content: "rules" },
        { role: "assistant", content: "no user message" },
      ] as ChatCompletionRequest["messages"]),
    ).toBe("");
  });

  it("formats memory context and savings without leaking invalid percentages", () => {
    const pack: MemoryContextPack = {
      contextId: "ctx-1",
      contextText: "Use the operator's local repo state.",
      citations: [{ title: "Transcript", source: "chat" }],
    } as never;

    expect(buildMemoryContextSystemMessage(pack)).toBe(
      [
        "Distilled context from GoatCitadel memory:",
        "Use the operator's local repo state.",
        "",
        "ContextId: ctx-1",
        "Citations: 1",
      ].join("\n"),
    );
    expect(calculateSavings(1000, 333)).toBe(66.7);
    expect(calculateSavings(0, 333)).toBe(0);
    expect(calculateSavings(-10, 333)).toBe(0);
  });

  it("classifies tool-protocol and transient provider failures without retrying auth denials blindly", () => {
    expect(shouldRetryToolProtocolError(new Error("invalid_request_error: function name is invalid"))).toBe(true);
    expect(shouldRetryToolProtocolError(new Error("reasoning_content is missing for tool_calls"))).toBe(true);
    expect(shouldRetryToolProtocolError(new Error("quota exhausted"))).toBe(false);

    expect(shouldRetryTransientProviderError(new Error("request failed (429 Too Many Requests)"))).toBe(true);
    expect(shouldRetryTransientProviderError(new Error("request failed (503 Service Unavailable)"))).toBe(true);
    expect(shouldRetryTransientProviderError(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(shouldRetryTransientProviderError(new Error("request failed (401 Unauthorized)"))).toBe(false);
    expect(
      shouldRetryTransientProviderError(new Error("request failed (403): upstream proxy temporarily unavailable")),
    ).toBe(true);
  });

  it("classifies provider denials and blocks cross-provider fallback for context overflow", () => {
    expect(classifyProviderFailure(new Error("request failed (401 Unauthorized)"))).toBe("auth_denial");
    expect(classifyProviderFailure(new Error("request failed (402): insufficient credits"))).toBe("business_denial");
    expect(classifyProviderFailure(new Error("request failed (429 Too Many Requests)"))).toBe("rate_limited");
    expect(classifyProviderFailure(new Error("maximum context length exceeded"))).toBe("context_overflow");
    expect(shouldAttemptCrossProviderFallback(new Error("maximum context length exceeded"))).toBe(false);
    expect(shouldAttemptCrossProviderFallback(new Error("request failed (503 Service Unavailable)"))).toBe(true);
  });

  it("normalizes invalid tool protocol payloads for bounded retry attempts", () => {
    const request: ChatCompletionRequest = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "123 lookup!",
                arguments: { query: "goat" },
              },
            },
            {
              id: "call-2",
              type: "function",
              function: {
                arguments: undefined,
              },
            },
          ],
        } as never,
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "123 lookup!",
            description: "Lookup a record.",
            parameters: { type: "object" },
          },
        },
        { type: "web_search_preview" } as never,
      ],
    };

    const normalized = normalizeToolProtocolRetryRequest(request, 2);

    expect(normalized.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: "tool_123_lookup",
        description: "Lookup a record.",
      },
    });
    expect(normalized.tools?.[1]).toEqual({ type: "web_search_preview" });
    expect((normalized.messages[0] as Record<string, unknown>).reasoning_content).toBe(
      "Using tool outputs to continue the response.",
    );
    expect((normalized.messages[0] as Record<string, unknown>).tool_calls).toEqual([
      expect.objectContaining({
        type: "function",
        function: {
          name: "tool_123_lookup",
          arguments: '{"query":"goat"}',
        },
      }),
      expect.objectContaining({
        type: "function",
        function: {
          name: "tool_fn",
          arguments: "{}",
        },
      }),
    ]);
  });

  it("enforces completion deadlines and preserves cancellation errors", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    expect(createChatCompletionDeadline(undefined)).toBeUndefined();
    expect(createChatCompletionDeadline(0)).toBeUndefined();
    expect(createChatCompletionDeadline(Number.POSITIVE_INFINITY)).toBeUndefined();
    const deadline = createChatCompletionDeadline(1500);
    expect(deadline).toBe(Date.now() + 1500);
    expect(getRemainingChatCompletionTimeoutMs(deadline, 1500)).toBe(1500);

    expect(createChatCompletionDeadline(999_999_999)).toBe(Date.now() + 30 * 60_000);

    vi.setSystemTime(new Date("2026-05-14T12:00:02.000Z"));
    expect(() => getRemainingChatCompletionTimeoutMs(deadline, 1500)).toThrow(
      "Chat completion timed out after 1500ms.",
    );

    const cancelled = new Error("Chat turn cancelled by operator");
    expect(normalizeChatCompletionAttemptError(cancelled, 1000)).toBe(cancelled);
    expect(normalizeChatCompletionAttemptError(new DOMException("operation aborted", "AbortError"), 250)).toEqual(
      new Error("Chat completion timed out after 250ms."),
    );
    expect(normalizeChatCompletionAttemptError("plain failure", undefined)).toEqual(new Error("plain failure"));
  });

  it("delays retries unless the backoff would consume the remaining deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    const firstDelay = delayChatCompletionRetry(Date.now() + 1000, 1000, 0);
    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    firstDelay.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(firstDelay).resolves.toBeUndefined();

    await expect(delayChatCompletionRetry(Date.now() + 500, 1000, 1)).rejects.toThrow(
      "Chat completion timed out after 1000ms.",
    );
  });
});
