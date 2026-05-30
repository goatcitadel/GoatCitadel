import type { ChatCompletionRequest, MemoryContextPack } from "@goatcitadel/contracts";
import type { LlmCompletionHost } from "./llm-completion-host.js";
import { extractPromptFromMessages } from "./llm-completion-helpers.js";

export async function composeChatCompletionMemoryContext(
  host: LlmCompletionHost,
  request: ChatCompletionRequest,
  memoryInput: ChatCompletionRequest["memory"],
): Promise<MemoryContextPack | undefined> {
  if (!shouldUseChatCompletionMemoryContext(host, memoryInput)) return undefined;

  const prompt = extractPromptFromMessages(request.messages);
  if (!prompt.trim()) return undefined;

  return host.memoryLifecycleService.composeContext({
    scope: "chat",
    prompt,
    sessionId: memoryInput?.sessionId,
    taskId: memoryInput?.taskId,
    workspace: host.resolveMemoryWorkspaceRelativeDir(memoryInput?.workspace, memoryInput?.sessionId),
    relationScope: memoryInput?.relationScope,
    maxContextTokens: memoryInput?.maxContextTokens,
    forceRefresh: memoryInput?.forceRefresh,
  });
}

export function shouldUseChatCompletionMemoryContext(
  host: LlmCompletionHost,
  memoryInput: ChatCompletionRequest["memory"],
): boolean {
  return (
    host.config.assistant.memory.enabled &&
    host.config.assistant.memory.qmd.enabled &&
    host.config.assistant.memory.qmd.applyToChat &&
    memoryInput?.mode !== "off" &&
    (memoryInput?.enabled ?? true)
  );
}
