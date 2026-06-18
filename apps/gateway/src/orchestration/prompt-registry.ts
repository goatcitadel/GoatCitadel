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
    reference: buildPromptReference(input.promptId, input.promptVersion, JSON.stringify(input.messages)),
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
