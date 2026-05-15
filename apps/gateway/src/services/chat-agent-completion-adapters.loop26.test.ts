import { describe, expect, it } from "vitest";
import {
  absorbCompletionStreamChunk,
  buildCompletionFromAggregate,
  createCompletionStreamAggregate,
  extractStructuredTextContent,
  parseSerializedToolCalls,
  readToolCalls,
  resolveAllowedModelToolCallName,
  toProviderToolFunctionName,
} from "./chat-agent-completion-adapters.js";

describe("chat-agent-completion-adapters edge cases", () => {
  it("parses provider tool calls, serialized parameters, and invalid arguments defensively", () => {
    const canonical = new Map([
      ["search_web", "browser.search"],
      ["browser.search", "browser.search"],
    ]);

    expect(
      readToolCalls(
        {
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "search_web",
                arguments: '{"query":"gateway coverage"}',
              },
            },
            {
              function: {
                name: "unknown_tool",
                arguments: '{"ignored":true}',
              },
            },
            {
              id: "call-2",
              function: {
                name: "browser.search",
                arguments: "{not-json",
              },
            },
          ],
        },
        canonical,
      ),
    ).toEqual([
      {
        id: "call-1",
        toolName: "browser.search",
        args: { query: "gateway coverage" },
        rawArguments: '{"query":"gateway coverage"}',
      },
      {
        id: "call-2",
        toolName: "browser.search",
        args: {},
        rawArguments: "{not-json",
      },
    ]);

    expect(
      parseSerializedToolCalls(
        [
          "<function=search_web>",
          "<parameter=query>gateway routes</parameter>",
          "<parameter=limit>3</parameter>",
          "</function>",
          '<function=unknown>{"ignored":true}</function>',
          '<function=browser.search>{"query":"fallback"}</tool_call>',
          "<function=>bad</function>",
        ].join(""),
        canonical,
      ),
    ).toEqual([
      expect.objectContaining({
        toolName: "browser.search",
        args: { query: "gateway routes", limit: "3" },
        rawArguments: JSON.stringify({ query: "gateway routes", limit: "3" }),
      }),
      expect.objectContaining({
        toolName: "browser.search",
        args: { query: "fallback" },
        rawArguments: JSON.stringify({ query: "fallback" }),
      }),
    ]);
  });

  it("normalizes provider tool names without colliding with existing names", () => {
    expect(resolveAllowedModelToolCallName("browser.search", new Map())).toBe("browser.search");
    expect(resolveAllowedModelToolCallName("blocked", new Map([["model_search", "browser.search"]]))).toBeUndefined();
    expect(resolveAllowedModelToolCallName("browser.search", new Map([["model_search", "browser.search"]]))).toBe(
      "browser.search",
    );

    const existing = new Map([
      ["browser_search", "browser.search"],
      ["browser_search_2", "browser.search.safe"],
    ]);
    expect(toProviderToolFunctionName("browser.search", existing)).toBe("browser_search");
    expect(toProviderToolFunctionName("browser/search", existing)).toBe("browser_search_3");
    expect(toProviderToolFunctionName("123", existing)).toBe("tool_123");
    expect(toProviderToolFunctionName("!!!", existing)).toBe("tool_fn");
  });

  it("extracts structured text variants and aggregates streaming deltas with tool calls", () => {
    expect(
      extractStructuredTextContent([
        "A",
        { text: "B" },
        { content: "C" },
        { value: "D" },
        { text: { value: "E" } },
        { text: { text: "F" } },
        { text: { content: "G" } },
        null,
      ]),
    ).toBe("ABCDEFG");

    const aggregate = createCompletionStreamAggregate();
    const first = absorbCompletionStreamChunk(aggregate, {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test-model",
      usage: { prompt_tokens: 1 },
      choices: [
        {
          delta: {
            content: [{ text: "Hello " }],
            tool_calls: [
              {
                index: 1,
                id: "call-b",
                type: "function",
                function: { name: "browser_search", arguments: '{"query":"' },
              },
            ],
          },
        },
      ],
    });
    const second = absorbCompletionStreamChunk(aggregate, {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: [{ text: "from message " }],
            tool_calls: [{ function: { name: "browser.search", arguments: "{}" } }],
          },
          delta: {
            content: { text: "world" },
            tool_calls: [
              {
                index: 1,
                function: { arguments: 'coverage"}' },
              },
              {
                index: 2,
                function: { name: "tool_without_index", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });

    expect(first).toEqual({ delta: "Hello ", sawToolCall: true });
    expect(second).toEqual({ delta: "from messageworld", sawToolCall: true });
    expect(buildCompletionFromAggregate(aggregate)).toMatchObject({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 123,
      model: "test-model",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello from messageworld",
            tool_calls: [
              {
                id: "call-b",
                type: "function",
                function: {
                  name: "browser_search",
                  arguments: '{"query":"coverage"}',
                },
              },
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "tool_without_index",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1 },
    });
  });
});
