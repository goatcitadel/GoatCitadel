import { completionSystemText, type StandingMemoryContext } from "./chat-learning-memory-manifest.js";
import type {
  ChatCompletionRequest,
  MemoryContextPack,
  MemoryContextPlacement,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { LlmCompletionHost } from "./llm-completion-host.js";
import { buildMemoryContextSystemMessage, extractPromptFromMessages } from "./llm-completion-helpers.js";
import { readCitadelWardDispatchReason } from "./chat-route-local-ward.js";

export async function composeChatCompletionMemoryContext(
  host: LlmCompletionHost,
  request: ChatCompletionRequest,
  memoryInput: ChatCompletionRequest["memory"],
  attribution?: ModelUsageAttributionContext,
): Promise<MemoryContextPack | undefined> {
  if (!shouldUseChatCompletionMemoryContext(host, memoryInput)) return undefined;

  const prompt = extractPromptFromMessages(request.messages);
  if (!prompt.trim()) return undefined;

  const input = {
    scope: "chat" as const,
    // Scope DB memory-item collection to this turn's workspace (review Finding 1).
    // Without workspaceId the memory-item collector ran the unfiltered query and
    // could surface another workspace's items into this completion's context. Uses
    // the same resolver as the hooks path so memory + hook scoping stay consistent.
    workspaceId: await host.resolveChatCompletionHookWorkspaceId(request),
    prompt,
    sessionId: memoryInput?.sessionId,
    taskId: memoryInput?.taskId,
    runId: attribution?.durableRunId ?? memoryInput?.runId,
    signal: request.signal,
    workspace: await host.resolveMemoryWorkspaceRelativeDir(memoryInput?.workspace, memoryInput?.sessionId),
    relationScope: memoryInput?.relationScope,
    maxContextTokens: memoryInput?.maxContextTokens,
    forceRefresh: memoryInput?.forceRefresh,
  };
  const attributionArgs = attribution
    ? ([
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: attribution.turnId ?? memoryInput?.turnId,
          durableRunId: input.runId,
          taskId: input.taskId,
          workerId: attribution.workerId,
          parentOperationId: attribution.operationId,
          contextIntentHash: attribution.contextIntentHash,
          contextEntryRefId: attribution.contextEntryRefId,
          routeDecisionId: attribution.routeDecisionId,
        },
      ] as const)
    : ([] as const);
  try {
    return await host.memoryLifecycleService.composeContext(input, ...attributionArgs);
  } catch (error) {
    // A Citadel Ward refusal of the memory distiller dispatch drops memory
    // context for this turn instead of failing it; other refusals stay authoritative.
    if (readCitadelWardDispatchReason(error)) return undefined;
    throw error;
  }
}

interface CompletionContextManifestInput {
  request: ChatCompletionRequest;
  memoryContext?: MemoryContextPack;
  memoryContextPlacement?: MemoryContextPlacement;
  usageBinding?: { operationId: string; dispatchGeneration: string };
}

interface AdmittedSkillContext {
  instruction: string;
  sources: { skillId: string; instructionSha256: string; treeSha256: string; sourceRef?: string }[];
}

type ContextManifestWriter = Pick<Storage["contextManifests"], "ensure" | "appendEntry">;

/** Persist admitted system messages in order, then the structured retrieval context. */
export async function persistContextManifestForCompletionRequest(
  contextManifests: ContextManifestWriter,
  admissionDeps: {
    resolveStandingMemoryContext?: (request: ChatCompletionRequest) => Promise<StandingMemoryContext | undefined>;
    resolveSkillContext?: (request: ChatCompletionRequest) => Promise<AdmittedSkillContext | undefined>;
  },
  input: CompletionContextManifestInput,
): Promise<void> {
  const turnId = input.request.memory?.turnId?.trim();
  if (!turnId) {
    return;
  }

  const standingMemoryContext = await admissionDeps.resolveStandingMemoryContext?.(input.request);
  const manifest = await contextManifests.ensure({
    scope: "chat_turn",
    turnId,
    sessionId: input.request.memory?.sessionId?.trim(),
    taskId: input.request.memory?.taskId?.trim(),
  });
  const memoryContextSystemMessage = input.memoryContext
    ? buildMemoryContextSystemMessage(input.memoryContext)
    : undefined;
  const skillContext = await admissionDeps.resolveSkillContext?.(input.request);
  for (const entry of completionContextEntries(
    input,
    manifest.manifestId,
    memoryContextSystemMessage,
    standingMemoryContext,
    skillContext,
  )) {
    await contextManifests.appendEntry(entry);
  }
}

function* completionContextEntries(
  input: CompletionContextManifestInput,
  manifestId: string,
  memoryContextSystemMessage: string | undefined,
  standingMemoryContext: StandingMemoryContext | undefined,
  skillContext: AdmittedSkillContext | undefined,
): Generator<Parameters<ContextManifestWriter["appendEntry"]>[0]> {
  let entryIndex = 0;
  for (const [messageIndex, message] of input.request.messages.entries()) {
    if (message.role !== "system") {
      continue;
    }
    const contentText = completionSystemText(message.content).trim();
    if (!contentText) {
      continue;
    }
    if (memoryContextSystemMessage && contentText === memoryContextSystemMessage) {
      continue;
    }
    yield {
      manifestId,
      kind: "system_message",
      entryIndex,
      title: contentText.split(/\r?\n/u, 1)[0]?.slice(0, 120) || "System message",
      sourceRef: `system:${messageIndex}`,
      contentText,
      metadata: {
        role: message.role,
        messageIndex,
        ...(input.usageBinding ? { usageBinding: input.usageBinding } : {}),
        ...(standingMemoryContext && contentText.includes(standingMemoryContext.instruction)
          ? {
              admittedMemories: standingMemoryContext.sources.map((source) => ({
                sourceType: "memory_learning",
                sourceRef: source.learningId,
                sourceHash: source.sourceHash,
              })),
            }
          : {}),
        ...(skillContext?.instruction.trim() === contentText ? { admittedSkills: skillContext.sources } : {}),
      },
    };
    entryIndex += 1;
  }

  if (
    !input.memoryContext ||
    !input.request.messages.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.trim() === memoryContextSystemMessage,
    )
  ) {
    return;
  }

  yield {
    manifestId,
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
      sourceCitations: input.memoryContext.citations.slice(0, 40).map((citation) => ({
        sourceType: citation.sourceType,
        sourceRef: citation.sourceRef,
        ...(citation.sourceHash ? { sourceHash: citation.sourceHash } : {}),
      })),
      ...(input.usageBinding ? { usageBinding: input.usageBinding } : {}),
      originalTokenEstimate: input.memoryContext.originalTokenEstimate,
      distilledTokenEstimate: input.memoryContext.distilledTokenEstimate,
      assembly: input.memoryContext.quality.assembly,
      accessReceipt: input.memoryContext.quality.accessReceipt,
      placement: input.memoryContextPlacement,
      createdAt: input.memoryContext.createdAt,
      expiresAt: input.memoryContext.expiresAt,
    },
  };
}

export function shouldUseChatCompletionMemoryContext(
  host: LlmCompletionHost,
  memoryInput: ChatCompletionRequest["memory"],
): boolean {
  const memory = host.config.assistant.memory;
  return (
    memory.enabled &&
    memory.qmd.enabled &&
    memory.qmd.applyToChat &&
    memoryInput?.mode !== "off" &&
    (memoryInput?.enabled ?? true)
  );
}
