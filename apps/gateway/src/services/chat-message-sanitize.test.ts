import { describe, expect, it } from "vitest";
import type { ChatCompletionMessage } from "@goatcitadel/contracts";
import { sanitizeMessages } from "./chat-message-sanitize.js";

type AssistantWithToolCalls = ChatCompletionMessage & {
  tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

function assistantToolCall(id: string, name = "lookup", args = "{}"): AssistantWithToolCalls {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id: string, content = "result"): ChatCompletionMessage {
  return { role: "tool", tool_call_id: id, content };
}

describe("sanitizeMessages", () => {
  it("returns an empty list unchanged", () => {
    expect(sanitizeMessages([])).toEqual([]);
  });

  it("leaves a well-formed call/result history unchanged (by reference)", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "user", content: "hello" },
      assistantToolCall("call_1"),
      toolResult("call_1"),
      { role: "assistant", content: "done" },
    ];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toEqual(messages);
    // Unchanged messages are passed through by reference (no needless copies).
    sanitized.forEach((message, index) => {
      expect(message).toBe(messages[index]);
    });
  });

  it("drops an orphan tool result whose id has no preceding assistant tool call", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "user", content: "hello" },
      toolResult("ghost"),
      { role: "assistant", content: "still answered" },
    ];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "still answered" },
    ]);
    expect(sanitized.some((message) => message.role === "tool")).toBe(false);
  });

  it("drops a tool result that appears before its call (order-sensitive pairing)", () => {
    const messages: ChatCompletionMessage[] = [
      toolResult("call_1"),
      assistantToolCall("call_1"),
      toolResult("call_1"),
    ];

    const sanitized = sanitizeMessages(messages);

    // The leading orphan result is dropped; the trailing valid one is kept.
    expect(sanitized).toEqual([assistantToolCall("call_1"), toolResult("call_1")]);
  });

  it("fills a dangling assistant tool call with a synthetic skipped result", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "user", content: "hello" },
      assistantToolCall("call_1"),
      { role: "assistant", content: "answer without a tool result" },
    ];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toHaveLength(4);
    const synthetic = sanitized[2];
    expect(synthetic.role).toBe("tool");
    expect(synthetic.tool_call_id).toBe("call_1");
    expect(JSON.parse(String(synthetic.content))).toMatchObject({ skipped: true });
    // Inserted immediately after the call that owns it — never reordered past
    // the following assistant message.
    expect(sanitized[1]).toBe(messages[1]);
    expect(sanitized[3]).toBe(messages[2]);
  });

  it("fills every dangling id of a parallel multi-call assistant turn", () => {
    const parallel: ChatCompletionMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "lookup", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "translate", arguments: "{}" } },
      ],
    } as AssistantWithToolCalls;
    const messages: ChatCompletionMessage[] = [parallel, toolResult("call_a")];

    const sanitized = sanitizeMessages(messages);

    // call_a already answered; call_b gets a synthetic fill right after the turn.
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0]).toBe(parallel);
    const filledIds = sanitized.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(filledIds).toContain("call_a");
    expect(filledIds).toContain("call_b");
  });

  it("never splits an assistant-with-tool_calls from its real results", () => {
    const messages: ChatCompletionMessage[] = [
      assistantToolCall("call_1"),
      toolResult("call_1"),
      { role: "user", content: "next" },
    ];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toEqual(messages);
    expect(sanitized[0].role).toBe("assistant");
    expect(sanitized[1].role).toBe("tool");
    expect(sanitized[1].tool_call_id).toBe("call_1");
  });

  it("handles Anthropic-style tool_use / tool_result content blocks", () => {
    const assistantBlocks: ChatCompletionMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "x" } },
      ],
    };
    const userResultBlocks: ChatCompletionMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
        { type: "tool_result", tool_use_id: "ghost", content: "orphan" },
      ],
    };
    const messages: ChatCompletionMessage[] = [assistantBlocks, userResultBlocks];

    const sanitized = sanitizeMessages(messages);

    // Orphan tool_result block stripped; valid one retained; assistant untouched.
    expect(sanitized[0]).toBe(assistantBlocks);
    expect(sanitized[1].content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]);
    // The original message is not mutated.
    expect(Array.isArray(userResultBlocks.content) ? userResultBlocks.content.length : 0).toBe(2);
  });

  it("drops a user message that carried only orphan tool_result blocks", () => {
    const messages: ChatCompletionMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "orphan" }] },
      { role: "assistant", content: "answer" },
    ];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("fills a dangling Anthropic tool_use block right after its assistant turn", () => {
    const assistantBlocks: ChatCompletionMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "lookup", input: {} }],
    };
    const messages: ChatCompletionMessage[] = [assistantBlocks, { role: "user", content: "next" }];

    const sanitized = sanitizeMessages(messages);

    expect(sanitized).toHaveLength(3);
    expect(sanitized[0]).toBe(assistantBlocks);
    expect(sanitized[1].role).toBe("tool");
    expect(sanitized[1].tool_call_id).toBe("tu_1");
    expect(sanitized[2]).toBe(messages[1]);
  });

  it("does not mutate the caller's message array or messages", () => {
    const messages: ChatCompletionMessage[] = [assistantToolCall("call_1")];
    const snapshot = JSON.stringify(messages);

    sanitizeMessages(messages);

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(messages).toHaveLength(1);
  });
});
