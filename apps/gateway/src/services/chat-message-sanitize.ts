import type { ChatCompletionMessage } from "@goatcitadel/contracts";

/**
 * Provider-agnostic message-pairing sanitizer.
 *
 * Anthropic Messages and the OpenAI Responses API both 400 a request whose
 * conversation history has either (a) a tool result with no preceding tool call
 * of the same id, or (b) an assistant tool call with no following tool result.
 * The agentic loop assembles history across many branch points (P0-B honest
 * degradation, P0-C approval parking, repair-feedback flushes, resume), and any
 * one of them can drift the pairing. This pass runs at the provider send
 * chokepoint and guarantees the list is always API-valid after any mutation:
 *
 *   1. Drop orphan tool results (a `role:"tool"` message, or a `tool_result`
 *      content block, whose `tool_call_id` has no preceding assistant tool call
 *      with that id).
 *   2. Fill dangling tool calls: for any assistant tool-call id that never
 *      receives a following result, insert a synthetic skipped result mirroring
 *      the orchestrator's own stub (`{ skipped: true, reason }`).
 *
 * The pass NEVER reorders messages and NEVER splits an assistant-with-tool_calls
 * from its results: synthetic fills are inserted immediately after the assistant
 * turn that owns the dangling id (before the next message), preserving the strict
 * call -> result adjacency that providers require.
 *
 * The function is pure: callers' messages are never mutated. Messages that need
 * no change are passed through by reference; only rewritten messages are copied.
 */

const SYNTHETIC_SKIPPED_REASON =
  "Tool result was missing from the conversation history and was backfilled to keep the request valid.";

type MutableMessage = ChatCompletionMessage & Record<string, unknown>;

export function sanitizeMessages(messages: readonly ChatCompletionMessage[]): ChatCompletionMessage[] {
  if (messages.length === 0) {
    return [];
  }

  // Pairing is order-sensitive: a result only counts as answering a call that
  // precedes it. Walk once, positionally, to learn which call ids are answered
  // by a later result (so we never double-fill an already-answered call).
  const answeredCallIds = new Set<string>();
  const seenForAnswerScan = new Set<string>();
  for (const message of messages) {
    for (const id of extractToolResultIds(message)) {
      if (seenForAnswerScan.has(id)) {
        answeredCallIds.add(id);
      }
    }
    for (const id of extractToolCallIds(message)) {
      seenForAnswerScan.add(id);
    }
  }

  const result: ChatCompletionMessage[] = [];
  const seenCallIds = new Set<string>();

  for (const message of messages) {
    const sanitizedResultMessage = sanitizeResultBearingMessage(message, seenCallIds);
    if (sanitizedResultMessage !== "not-a-result") {
      // Tool-result-bearing message: either kept (possibly rewritten) or dropped
      // entirely when every result it carried was an orphan.
      if (sanitizedResultMessage !== undefined) {
        result.push(sanitizedResultMessage);
      }
      continue;
    }

    result.push(message);

    const callIds = extractToolCallIds(message);
    if (callIds.length === 0) {
      continue;
    }
    for (const id of callIds) {
      seenCallIds.add(id);
    }
    // Backfill any of this assistant turn's calls that are never answered later,
    // inserting the synthetic results immediately after the call so the
    // call -> result adjacency stays intact.
    for (const id of callIds) {
      if (!answeredCallIds.has(id)) {
        result.push(buildSyntheticToolResult(id));
      }
    }
  }

  return result;
}

/**
 * Inspects a message that may carry tool results.
 *
 * - Returns `"not-a-result"` when the message carries no tool results (caller
 *   handles it as a potential tool-call owner).
 * - Returns a (possibly rewritten) message when it carries at least one valid
 *   result; orphan result blocks are stripped from content-block messages.
 * - Returns `undefined` when the message was *entirely* an orphan result and
 *   should be dropped.
 */
function sanitizeResultBearingMessage(
  message: ChatCompletionMessage,
  seenCallIds: ReadonlySet<string>,
): ChatCompletionMessage | undefined | "not-a-result" {
  if (message.role === "tool") {
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
    if (id !== undefined && seenCallIds.has(id)) {
      return message;
    }
    return undefined;
  }

  // Content-block tool_result carriers (Anthropic-style user messages). Drop
  // orphan blocks and keep the rest.
  if (!Array.isArray(message.content)) {
    return "not-a-result";
  }
  const blocks = message.content;
  const hasToolResult = blocks.some((block) => isToolResultBlock(block));
  if (!hasToolResult) {
    return "not-a-result";
  }

  const keptBlocks = blocks.filter((block) => {
    if (!isToolResultBlock(block)) {
      return true;
    }
    const id = toolResultBlockId(block);
    return id !== undefined && seenCallIds.has(id);
  });

  if (keptBlocks.length === blocks.length) {
    return message;
  }
  if (keptBlocks.length === 0) {
    return undefined;
  }
  return { ...message, content: keptBlocks };
}

function extractToolCallIds(message: ChatCompletionMessage): string[] {
  if (message.role !== "assistant") {
    return [];
  }
  const ids: string[] = [];
  const record = message as MutableMessage;
  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      const id = toolCallId(toolCall);
      if (id !== undefined) {
        ids.push(id);
      }
    }
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isToolUseBlock(block)) {
        const id = toolUseBlockId(block);
        if (id !== undefined) {
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

function extractToolResultIds(message: ChatCompletionMessage): string[] {
  if (message.role === "tool") {
    return typeof message.tool_call_id === "string" ? [message.tool_call_id] : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of message.content) {
    if (isToolResultBlock(block)) {
      const id = toolResultBlockId(block);
      if (id !== undefined) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function buildSyntheticToolResult(toolCallId: string): ChatCompletionMessage {
  // Mirrors the orchestrator's own skipped-result stub shape so downstream
  // adapters (Anthropic tool_result / OpenAI tool message) translate it
  // identically to a real abandoned-call result.
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ skipped: true, reason: SYNTHETIC_SKIPPED_REASON }),
  };
}

function toolCallId(toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) {
    return undefined;
  }
  return typeof toolCall.id === "string" && toolCall.id ? toolCall.id : undefined;
}

function isToolUseBlock(block: unknown): block is Record<string, unknown> {
  return isRecord(block) && block.type === "tool_use";
}

function toolUseBlockId(block: Record<string, unknown>): string | undefined {
  return typeof block.id === "string" && block.id ? block.id : undefined;
}

function isToolResultBlock(block: unknown): block is Record<string, unknown> {
  return isRecord(block) && block.type === "tool_result";
}

function toolResultBlockId(block: Record<string, unknown>): string | undefined {
  return typeof block.tool_use_id === "string" && block.tool_use_id ? block.tool_use_id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
