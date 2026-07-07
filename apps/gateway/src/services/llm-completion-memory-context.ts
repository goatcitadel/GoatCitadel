import type { ChatCompletionRequest, MemoryContextPack, MemoryContextPlacement } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { LlmCompletionHost } from "./llm-completion-host.js";
import { buildMemoryContextSystemMessage, extractPromptFromMessages } from "./llm-completion-helpers.js";

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

/**
 * Persist the context manifest for a chat-turn completion request: every
 * non-memory system message plus (when present) the memory-context entry.
 * The memory-context system message itself is skipped so it is recorded once,
 * as the structured memory_context entry, not twice.
 */
export function persistContextManifestForCompletionRequest(
  deps: { contextManifests: Storage["contextManifests"] },
  input: {
    request: ChatCompletionRequest;
    memoryContext?: MemoryContextPack;
    memoryContextPlacement?: MemoryContextPlacement;
  },
): void {
  const turnId = input.request.memory?.turnId?.trim();
  if (!turnId) {
    return;
  }

  const manifest = deps.contextManifests.ensure({
    scope: "chat_turn",
    turnId,
    sessionId: input.request.memory?.sessionId?.trim(),
    taskId: input.request.memory?.taskId?.trim(),
  });
  const memoryContextSystemMessage = input.memoryContext
    ? buildMemoryContextSystemMessage(input.memoryContext)
    : undefined;
  let entryIndex = 0;

  for (const [messageIndex, message] of input.request.messages.entries()) {
    if (message.role !== "system" || typeof message.content !== "string") {
      continue;
    }
    const contentText = message.content.trim();
    if (!contentText) {
      continue;
    }
    if (memoryContextSystemMessage && contentText === memoryContextSystemMessage) {
      continue;
    }
    deps.contextManifests.appendEntry({
      manifestId: manifest.manifestId,
      kind: "system_message",
      entryIndex,
      title: contentText.split(/\r?\n/u, 1)[0]?.slice(0, 120) || "System message",
      sourceRef: `system:${messageIndex}`,
      contentText,
      metadata: {
        role: message.role,
        messageIndex,
      },
    });
    entryIndex += 1;
  }

  if (!input.memoryContext) {
    return;
  }

  deps.contextManifests.appendEntry({
    manifestId: manifest.manifestId,
    kind: "memory_context",
    entryIndex,
    title: "Memory context",
    sourceRef: input.memoryContext.contextId,
    contentText: input.memoryContext.contextText,
    metadata: {
      scope: input.memoryContext.scope,
      status: input.memoryContext.quality.status,
      reason: input.memoryContext.quality.reason,
      citationsCount: input.memoryContext.citations.length,
      originalTokenEstimate: input.memoryContext.originalTokenEstimate,
      distilledTokenEstimate: input.memoryContext.distilledTokenEstimate,
      assembly: input.memoryContext.quality.assembly,
      placement: input.memoryContextPlacement,
      createdAt: input.memoryContext.createdAt,
      expiresAt: input.memoryContext.expiresAt,
    },
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
