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
 *   2. Resolve dangling tool calls from internal effect potential: remove only
 *      calls proven `none`; preserve `unknown` calls and insert an operator-safe
 *      interruption result that suppresses automatic replay.
 *
 * The pass NEVER reorders messages and NEVER splits an assistant-with-tool_calls
 * from its results: synthetic fills are inserted immediately after the assistant
 * turn that owns the dangling id (before the next message), preserving the strict
 * call -> result adjacency that providers require. Internal effect metadata is
 * stripped recursively before any message or tool definition reaches a provider.
 *
 * The function is pure: callers' messages are never mutated. Messages that need
 * no change are passed through by reference; only rewritten messages are copied.
 */

const SYNTHETIC_SKIPPED_REASON =
  "Tool result was missing from the conversation history and was backfilled to keep the request valid.";
const SYNTHETIC_UNKNOWN_EFFECT_REASON =
  "Tool settlement was interrupted after dispatch may have occurred. Inspect external/runtime state before retry; automatic replay was suppressed.";

/** Internal-only marker consumed and removed at the provider-send chokepoint. */
export const INTERNAL_TOOL_EFFECT_POTENTIAL_KEY = "gc_internal_effect_potential" as const;
const INTERNAL_TOOL_EFFECT_PREFIX = "gc_internal_";

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
    const wireSafeMessage = stripInternalToolEffectMetadata(message);
    const sanitizedResultMessage = sanitizeResultBearingMessage(wireSafeMessage, seenCallIds);
    if (sanitizedResultMessage !== "not-a-result") {
      // Tool-result-bearing message: either kept (possibly rewritten) or dropped
      // entirely when every result it carried was an orphan.
      if (sanitizedResultMessage !== undefined) {
        result.push(sanitizedResultMessage);
      }
      continue;
    }

    const calls = extractToolCalls(message);
    if (calls.length === 0) {
      result.push(wireSafeMessage);
      continue;
    }
    const removableNoEffectIds = new Set(
      calls.filter((call) => !answeredCallIds.has(call.id) && call.potential === "none").map((call) => call.id),
    );
    const projectedMessage = removeDanglingNoEffectCalls(wireSafeMessage, removableNoEffectIds);
    if (hasProviderMessagePayload(projectedMessage)) {
      result.push(projectedMessage);
    }
    for (const call of calls) {
      if (!removableNoEffectIds.has(call.id)) {
        seenCallIds.add(call.id);
      }
    }
    // Backfill any of this assistant turn's calls that are never answered later,
    // inserting the synthetic results immediately after the call so the
    // call -> result adjacency stays intact.
    for (const call of calls) {
      if (!answeredCallIds.has(call.id) && call.potential !== "none") {
        result.push(buildSyntheticToolResult(call.id, "unknown"));
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
  return extractToolCalls(message).map((call) => call.id);
}

function extractToolCalls(message: ChatCompletionMessage): Array<{ id: string; potential: "none" | "unknown" }> {
  if (message.role !== "assistant") {
    return [];
  }
  const byId = new Map<string, { id: string; potential: "none" | "unknown"; explicit: boolean }>();
  const remember = (id: string | undefined, value: unknown): void => {
    if (!id) return;
    const explicit = value === "none" || value === "unknown";
    const potential = value === "none" ? "none" : "unknown";
    const current = byId.get(id);
    if (!current || (explicit && !current.explicit) || (explicit && potential === "unknown")) {
      byId.set(id, { id, potential, explicit });
    }
  };
  const record = message as MutableMessage;
  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      remember(toolCallId(toolCall), isRecord(toolCall) ? toolCall[INTERNAL_TOOL_EFFECT_POTENTIAL_KEY] : undefined);
    }
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isToolUseBlock(block)) {
        remember(toolUseBlockId(block), block[INTERNAL_TOOL_EFFECT_POTENTIAL_KEY]);
      }
    }
  }
  if (Array.isArray(record.provider_native_content)) {
    for (const block of record.provider_native_content) {
      if (isToolUseBlock(block)) {
        remember(toolUseBlockId(block), block[INTERNAL_TOOL_EFFECT_POTENTIAL_KEY]);
      }
    }
  }
  return [...byId.values()].map(({ id, potential }) => ({ id, potential }));
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

function buildSyntheticToolResult(
  toolCallId: string,
  effectPotential: "none" | "unknown" = "none",
): ChatCompletionMessage {
  // Mirrors the orchestrator's own skipped-result stub shape so downstream
  // adapters (Anthropic tool_result / OpenAI tool message) translate it
  // identically to a real abandoned-call result.
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(
      effectPotential === "unknown"
        ? {
            interrupted: true,
            recovery: "inspect_state_before_retry",
            automaticReplaySuppressed: true,
            reason: SYNTHETIC_UNKNOWN_EFFECT_REASON,
          }
        : { skipped: true, reason: SYNTHETIC_SKIPPED_REASON },
    ),
  };
}

function removeDanglingNoEffectCalls(
  message: ChatCompletionMessage,
  removableIds: ReadonlySet<string>,
): ChatCompletionMessage {
  if (removableIds.size === 0 || message.role !== "assistant") return message;
  const record = message as MutableMessage;
  let changed = false;
  const next: MutableMessage = { ...record };
  if (Array.isArray(record.tool_calls)) {
    const retained = record.tool_calls.filter((call) => {
      const id = toolCallId(call);
      return !id || !removableIds.has(id);
    });
    if (retained.length !== record.tool_calls.length) {
      changed = true;
      if (retained.length > 0) next.tool_calls = retained;
      else delete next.tool_calls;
    }
  }
  if (Array.isArray(message.content)) {
    const retained = message.content.filter(
      (block) => !isToolUseBlock(block) || !removableIds.has(toolUseBlockId(block) ?? ""),
    );
    if (retained.length !== message.content.length) {
      changed = true;
      next.content = retained;
    }
  }
  if (Array.isArray(record.provider_native_content)) {
    const retained = record.provider_native_content.filter(
      (block) => !isToolUseBlock(block) || !removableIds.has(toolUseBlockId(block) ?? ""),
    );
    if (retained.length !== record.provider_native_content.length) {
      changed = true;
      if (retained.length > 0) next.provider_native_content = retained;
      else delete next.provider_native_content;
    }
  }
  return changed ? (next as ChatCompletionMessage) : message;
}

function hasProviderMessagePayload(message: ChatCompletionMessage): boolean {
  if (message.role !== "assistant") return true;
  const record = message as MutableMessage;
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
  if (Array.isArray(record.provider_native_content) && record.provider_native_content.length > 0) return true;
  if (typeof message.content === "string") return message.content.length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

function stripInternalToolEffectMetadata(message: ChatCompletionMessage): ChatCompletionMessage {
  const stripped = stripInternalToolEffectValue(message);
  return stripped.changed ? (stripped.value as ChatCompletionMessage) : message;
}

/** Remove internal effect-truth keys from any provider-bound structured value. */
export function stripInternalToolEffectMetadataForProvider<T>(value: T): T {
  const stripped = stripInternalToolEffectValue(value);
  return (stripped.changed ? stripped.value : value) as T;
}

function stripInternalToolEffectValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripInternalToolEffectValue(item);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith(INTERNAL_TOOL_EFFECT_PREFIX)) {
      changed = true;
      continue;
    }
    const stripped = stripInternalToolEffectValue(nested);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return { value: changed ? next : value, changed };
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
