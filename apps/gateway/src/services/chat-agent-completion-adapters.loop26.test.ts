import { describe, expect, it } from "vitest";
import {
  absorbCompletionStreamChunk,
  buildCompletionFromAggregate,
  createCompletionStreamAggregate,
  extractStructuredTextContent,
  inspectToolCallProtocolIssues,
  parseSerializedToolCalls,
  readToolCalls,
  resolveAllowedModelToolCallName,
  sanitizeProviderNativeReplayContent,
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

  it("parses JSON tool_call tags only through the selected schema map", () => {
    const canonical = new Map([
      ["search_web", "browser.search"],
      ["browser.search", "browser.search"],
    ]);

    expect(
      parseSerializedToolCalls(
        [
          '<tool_call>{"id":"call-json-1","name":"search_web","arguments":{"query":"gateway"}}</tool_call>',
          '<tool_call>{"name":"fs.write","arguments":{"path":"secret"}}</tool_call>',
          '<tool_call>{"function":{"name":"browser.search","arguments":"{\\"query\\":\\"fallback\\"}"}}</tool_call>',
        ].join(""),
        canonical,
      ),
    ).toEqual([
      {
        id: "call-json-1",
        toolName: "browser.search",
        args: { query: "gateway" },
        rawArguments: JSON.stringify({ query: "gateway" }),
      },
      expect.objectContaining({
        toolName: "browser.search",
        args: { query: "fallback" },
        rawArguments: JSON.stringify({ query: "fallback" }),
      }),
    ]);

    expect(
      parseSerializedToolCalls(
        '<tool_call>{"name":"browser.search","arguments":{"query":"blocked without map"}}</tool_call>',
        new Map(),
      ),
    ).toEqual([]);
  });

  it("normalizes provider tool names without colliding with existing names", () => {
    expect(resolveAllowedModelToolCallName("browser.search", new Map())).toBeUndefined();
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

  it("reports invalid provider tool-call protocol without treating phantom tools as callable", () => {
    const canonical = new Map([
      ["browser_search", "browser.search"],
      ["browser.search", "browser.search"],
    ]);

    const issues = inspectToolCallProtocolIssues(
      {
        tool_calls: [
          { id: "missing-function" },
          { id: "empty-name", function: { name: "   ", arguments: "{}" } },
          { id: "unsupported", function: { name: "shell_exec", arguments: "{}" } },
          { id: "bad-json", function: { name: "browser_search", arguments: "{bad-json" } },
          { id: "array-args", function: { name: "browser_search", arguments: "[]" } },
        ],
      },
      canonical,
    );

    expect(issues.map((issue) => issue.kind)).toEqual([
      "missing_function",
      "missing_name",
      "unsupported_name",
      "malformed_arguments",
      "non_object_arguments",
    ]);
    expect(issues.find((issue) => issue.kind === "unsupported_name")).toEqual(
      expect.objectContaining({ rawName: "shell_exec" }),
    );
    expect(
      readToolCalls(
        {
          tool_calls: [{ id: "unsupported", function: { name: "shell_exec", arguments: "{}" } }],
        },
        canonical,
      ),
    ).toEqual([]);
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
            provider_native_content: [{ type: "thinking", thinking: "private", signature: "sig-1" }],
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
            provider_native_content: [{ type: "thinking", thinking: "private", signature: "sig-1" }],
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

  it("keeps replay matrix edge cases explicit for raw strings, thinking-only turns, and empty post-tool finals", () => {
    expect(extractStructuredTextContent("raw assistant replay")).toBe("raw assistant replay");

    const thinkingOnly = createCompletionStreamAggregate();
    expect(
      absorbCompletionStreamChunk(thinkingOnly, {
        choices: [
          {
            delta: {
              provider_native_content: [{ type: "thinking", thinking: "private scratch", signature: "sig-thinking" }],
            },
          },
        ],
      }),
    ).toEqual({ delta: undefined, sawToolCall: false });
    expect(buildCompletionFromAggregate(thinkingOnly).choices?.[0]?.message).toEqual({
      role: "assistant",
      content: "",
      provider_native_content: [{ type: "thinking", thinking: "private scratch", signature: "sig-thinking" }],
    });

    const emptyPostToolFinal = createCompletionStreamAggregate();
    absorbCompletionStreamChunk(emptyPostToolFinal, {
      choices: [
        {
          finish_reason: "tool_calls",
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-empty-final",
                type: "function",
                function: { name: "browser_search", arguments: '{"query":"status"}' },
              },
            ],
          },
        },
      ],
    });
    expect(
      absorbCompletionStreamChunk(emptyPostToolFinal, { choices: [{ finish_reason: "stop", delta: {} }] }),
    ).toEqual({ delta: undefined, sawToolCall: false });
    expect(buildCompletionFromAggregate(emptyPostToolFinal).choices?.[0]?.message).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-empty-final",
          type: "function",
          function: { name: "browser_search", arguments: '{"query":"status"}' },
        },
      ],
    });
  });

  it("quarantines malformed native reasoning signatures without dropping valid replay content", () => {
    expect(sanitizeProviderNativeReplayContent({ type: "thinking", thinking: "private", signature: 42 })).toEqual({
      type: "provider_native_content_quarantine",
      sourceType: "thinking",
      reason: "malformed_reasoning_signature",
    });

    const aggregate = createCompletionStreamAggregate();
    absorbCompletionStreamChunk(aggregate, {
      choices: [
        {
          delta: {
            provider_native_content: [
              { type: "thinking", thinking: "private", signature: "" },
              { type: "thinking", thinking: "private", signature: "sig-ok" },
            ],
          },
        },
      ],
    });
    expect(buildCompletionFromAggregate(aggregate).choices?.[0]?.message?.provider_native_content).toEqual([
      {
        type: "provider_native_content_quarantine",
        sourceType: "thinking",
        reason: "malformed_reasoning_signature",
      },
      { type: "thinking", thinking: "private", signature: "sig-ok" },
    ]);
  });
});
