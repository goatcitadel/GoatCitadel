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
    // Scope DB memory-item collection to this turn's workspace (review Finding 1).
    // Without workspaceId the memory-item collector ran the unfiltered query and
    // could surface another workspace's items into this completion's context. Uses
    // the same resolver as the hooks path so memory + hook scoping stay consistent.
    workspaceId: host.resolveChatCompletionHookWorkspaceId(request),
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
