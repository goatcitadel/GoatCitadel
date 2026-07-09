import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";

export type ChatCompletionMessage = ChatCompletionRequest["messages"][number];

export function extractProviderToolName(tool: Record<string, unknown>): string | undefined {
  if (typeof tool.name === "string") {
    return tool.name;
  }
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const name = (fn as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

export function createAssistantToolCallMessage(input: {
  toolCallId?: string;
  toolName?: string;
  argumentsJson?: string;
  content?: string;
  providerNativeContent?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
}): ChatCompletionMessage {
  const toolCalls = input.toolCalls ?? [
    {
      id: input.toolCallId ?? randomUUID(),
      type: "function",
      function: {
        name: input.toolName ?? "tool_fn",
        arguments: input.argumentsJson ?? "{}",
      },
    },
  ];
  return {
    role: "assistant",
    content: input.content ?? "",
    ...(input.providerNativeContent && input.providerNativeContent.length > 0
      ? { provider_native_content: input.providerNativeContent }
      : {}),
    tool_calls: toolCalls,
  } as ChatCompletionMessage;
}

export function extractProviderNativeContent(
  message: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  return Array.isArray(message?.provider_native_content)
    ? message.provider_native_content.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

/**
 * P0-B: detect whether a terminal assistant message carried reasoning/thinking
 * content even though it produced no user-visible answer. Covers both the
 * structured `provider_native_content` thinking blocks and the flat
 * `reasoning` / `reasoning_content` fields some providers emit.
 */
export function messageHasReasoningContent(message: Record<string, unknown> | undefined): boolean {
  if (!message) {
    return false;
  }
  const flatReasoning = message.reasoning ?? message.reasoning_content;
  if (typeof flatReasoning === "string" && flatReasoning.trim().length > 0) {
    return true;
  }
  for (const item of extractProviderNativeContent(message)) {
    const type = typeof item.type === "string" ? item.type : "";
    const reasoningLike = type === "thinking" || type === "redacted_thinking" || type === "reasoning";
    if (!reasoningLike) {
      continue;
    }
    const text = item.thinking ?? item.text ?? item.content ?? item.data;
    if (typeof text === "string" && text.trim().length > 0) {
      return true;
    }
    // Redacted thinking carries no readable text but still proves the model reasoned.
    if (type === "redacted_thinking") {
      return true;
    }
  }
  return false;
}

/**
 * Thinking-display skeleton: concatenates the same readable reasoning text
 * {@link messageHasReasoningContent} detects, for emission as a `thinking_delta`
 * chunk. Mirrors that function's traversal (flat field first, then structured
 * `provider_native_content` blocks) so "has reasoning" and "the reasoning text"
 * never disagree. Redacted-thinking blocks carry no readable text (by design -
 * they only prove the model reasoned) and are skipped here, unlike the boolean
 * detector which still counts them as "has reasoning".
 */
export function extractReasoningText(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return "";
  }
  const flatReasoning = message.reasoning ?? message.reasoning_content;
  if (typeof flatReasoning === "string" && flatReasoning.trim().length > 0) {
    return flatReasoning;
  }
  const parts: string[] = [];
  for (const item of extractProviderNativeContent(message)) {
    const type = typeof item.type === "string" ? item.type : "";
    // redacted_thinking blocks carry only an encrypted `data` blob - never treat
    // that as readable text. Skip them entirely rather than falling through the
    // `?? item.data` chain below, which would otherwise leak the ciphertext into
    // visible reasoning output.
    if (type === "redacted_thinking") {
      continue;
    }
    const reasoningLike = type === "thinking" || type === "reasoning";
    if (!reasoningLike) {
      continue;
    }
    const text = item.thinking ?? item.text ?? item.content ?? item.data;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}
