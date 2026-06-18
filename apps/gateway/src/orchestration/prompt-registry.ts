import { createHash } from "node:crypto";
import type { ChatCompletionRequest, OrchestrationPromptReference } from "@goatcitadel/contracts";

export interface VersionedTextPrompt {
  content: string;
  reference: OrchestrationPromptReference;
}

export interface VersionedChatMessagesPrompt {
  messages: ChatCompletionRequest["messages"];
  reference: OrchestrationPromptReference;
}

export function renderVersionedTextPrompt(input: {
  promptId: string;
  promptVersion: string;
  content: string;
}): VersionedTextPrompt {
  return {
    content: input.content,
    reference: buildPromptReference(input.promptId, input.promptVersion, input.content),
  };
}

export function renderVersionedChatMessagesPrompt(input: {
  promptId: string;
  promptVersion: string;
  messages: ChatCompletionRequest["messages"];
}): VersionedChatMessagesPrompt {
  return {
    messages: input.messages,
    // Hash over a canonical (sorted-key) serialization so the prompt hash is stable
    // regardless of message-object key insertion order across call sites.
    reference: buildPromptReference(input.promptId, input.promptVersion, stableStringify(input.messages)),
  };
}

function buildPromptReference(
  promptId: string,
  promptVersion: string,
  renderedPrompt: string,
): OrchestrationPromptReference {
  return {
    promptId,
    promptVersion,
    promptHash: `sha256:${createHash("sha256").update(renderedPrompt).digest("hex")}`,
  };
}

// Deterministic JSON serialization with recursively sorted object keys, so structurally
// equal messages hash identically even if their keys were inserted in a different order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}
