import { randomUUID } from "node:crypto";
import type { ChatMessageRecord, ChatSessionRecord, ChatSessionCreateInput } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { loadChatTurnSessionState } from "./chat-turn-trace-hydration.js";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";

const DEFAULT_WORKSPACE_ID = "default";
export const REPLAY_SCRATCH_SESSION_TITLE_PREFIX = "[Replay scratch]";
export interface ChatReplaySessionHost {
  requireChatSession(sessionId: string): Promise<ChatSessionRecord>;
  loadChatTurnSessionState(sessionId: string): ReturnType<typeof loadChatTurnSessionState>;
  createChatSession(input: ChatSessionCreateInput & { stableKey?: string }): Promise<ChatSessionRecord>;
  inheritDelegatedSessionToolGrants(sourceSessionId: string, targetSessionId: string): Promise<void>;
  storage: Pick<
    Storage,
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "sessionAutonomyPrefs"
    | "chatSessionProjects"
    | "chatSessionBranchState"
    | "chatMessages"
    | "chatTurnTraces"
  >;
  normalizeWorkspaceId(workspaceId: string | undefined): string;
}

/** Replay scratch copies preserve the existing repositories and grant inheritance. */
export async function createReplayScratchSession(
  host: ChatReplaySessionHost,
  sourceSessionId: string,
  sourceTurnId: string,
): Promise<{ sessionId: string; sourceTurnId: string }> {
  const sourceSession = await host.requireChatSession(sourceSessionId);
  const sourceMeta = await host.storage.chatSessionMeta.ensure(
    sourceSessionId,
    undefined,
    sourceSession.workspaceId ?? DEFAULT_WORKSPACE_ID,
  );
  const sourcePrefs = await host.storage.chatSessionPrefs.ensure(sourceSessionId);
  const sourceAutonomy = await host.storage.sessionAutonomyPrefs.ensure(sourceSessionId);
  const sourceProjectId = (await host.storage.chatSessionProjects.get(sourceSessionId))?.projectId;
  const sourceState = await host.loadChatTurnSessionState(sourceSessionId);
  const scratchSession = await host.createChatSession({
    workspaceId: host.normalizeWorkspaceId(sourceMeta.workspaceId),
    projectId: sourceProjectId,
    mode: sourcePrefs.mode,
    title: `${REPLAY_SCRATCH_SESSION_TITLE_PREFIX} ${sourceSession.title?.trim() || sourceTurnId.slice(0, 8)}`,
  });

  await host.storage.chatSessionPrefs.patch(scratchSession.sessionId, {
    mode: sourcePrefs.mode,
    planningMode: sourcePrefs.planningMode,
    providerId: sourcePrefs.providerId,
    model: sourcePrefs.model,
    imageProviderId: sourcePrefs.imageProviderId,
    imageModel: sourcePrefs.imageModel,
    webMode: sourcePrefs.webMode,
    memoryMode: sourcePrefs.memoryMode,
    thinkingLevel: sourcePrefs.thinkingLevel,
    toolAutonomy: sourcePrefs.toolAutonomy,
    visionFallbackModel: sourcePrefs.visionFallbackModel,
    orchestrationEnabled: sourcePrefs.orchestrationEnabled,
    orchestrationIntensity: sourcePrefs.orchestrationIntensity,
    orchestrationVisibility: sourcePrefs.orchestrationVisibility,
    orchestrationProviderPreference: sourcePrefs.orchestrationProviderPreference,
    orchestrationReviewDepth: sourcePrefs.orchestrationReviewDepth,
    orchestrationParallelism: sourcePrefs.orchestrationParallelism,
    codeAutoApply: sourcePrefs.codeAutoApply,
  });
  await host.storage.sessionAutonomyPrefs.patch(scratchSession.sessionId, {
    proactiveMode: sourceAutonomy.proactiveMode,
    maxActionsPerHour: sourceAutonomy.maxActionsPerHour,
    maxActionsPerTurn: sourceAutonomy.maxActionsPerTurn,
    cooldownSeconds: sourceAutonomy.cooldownSeconds,
    retrievalMode: sourceAutonomy.retrievalMode,
    reflectionMode: sourceAutonomy.reflectionMode,
  });
  await host.inheritDelegatedSessionToolGrants(sourceSessionId, scratchSession.sessionId);

  const cloned = await cloneChatTurnPathIntoSession(host, {
    sourceSessionId,
    sourceTurnId,
    targetSessionId: scratchSession.sessionId,
    sourceState,
  });
  await host.storage.chatSessionBranchState.setActiveLeaf(scratchSession.sessionId, cloned.sourceTurnId);
  return {
    sessionId: scratchSession.sessionId,
    sourceTurnId: cloned.sourceTurnId,
  };
}

async function cloneChatTurnPathIntoSession(
  host: ChatReplaySessionHost,
  input: {
    sourceSessionId: string;
    sourceTurnId: string;
    targetSessionId: string;
    sourceState: Awaited<ReturnType<typeof loadChatTurnSessionState>>;
  },
): Promise<{ sourceTurnId: string }> {
  const pathTurnIds = buildSelectedPathTurnIds(input.sourceState.turnLineageById, input.sourceTurnId);
  if (pathTurnIds.length === 0) {
    throw new Error(`Chat turn ${input.sourceTurnId} not found in session ${input.sourceSessionId}`);
  }

  const turnIdMap = new Map<string, string>();
  const messageCopies: ChatMessageRecord[] = [];
  const traceCopies: Array<Parameters<Storage["chatTurnTraces"]["create"]>[0]> = [];

  for (const pathTurnId of pathTurnIds) {
    const trace = input.sourceState.tracesById.get(pathTurnId);
    if (!trace) {
      throw new Error(`Chat turn ${pathTurnId} not found in source session ${input.sourceSessionId}`);
    }
    const userMessage = input.sourceState.messagesById.get(trace.userMessageId);
    if (!userMessage) {
      throw new Error(`User message ${trace.userMessageId} not found for turn ${pathTurnId}`);
    }

    const clonedTurnId = randomUUID();
    const clonedUserMessageId = randomUUID();
    let clonedAssistantMessageId: string | undefined;
    turnIdMap.set(pathTurnId, clonedTurnId);
    messageCopies.push({
      ...userMessage,
      messageId: clonedUserMessageId,
      sessionId: input.targetSessionId,
    });

    if (trace.assistantMessageId) {
      const assistantMessage = input.sourceState.messagesById.get(trace.assistantMessageId);
      if (assistantMessage) {
        clonedAssistantMessageId = `assistant-${randomUUID()}`;
        messageCopies.push({
          ...assistantMessage,
          messageId: clonedAssistantMessageId,
          sessionId: input.targetSessionId,
        });
      }
    }

    traceCopies.push({
      turnId: clonedTurnId,
      sessionId: input.targetSessionId,
      userMessageId: clonedUserMessageId,
      parentTurnId: trace.parentTurnId ? turnIdMap.get(trace.parentTurnId) : undefined,
      branchKind: trace.branchKind,
      sourceTurnId: trace.sourceTurnId ? turnIdMap.get(trace.sourceTurnId) : undefined,
      assistantMessageId: clonedAssistantMessageId,
      status: trace.status,
      mode: trace.mode,
      model: trace.model,
      webMode: trace.webMode,
      memoryMode: trace.memoryMode,
      thinkingLevel: trace.thinkingLevel,
      effectiveToolAutonomy: trace.effectiveToolAutonomy,
      routing: trace.routing,
      retrieval: trace.retrieval,
      reflection: trace.reflection,
      proactive: trace.proactive,
      completion: trace.completion,
      durable: trace.durable,
      orchestration: trace.orchestration,
      guidance: trace.guidance,
      citations: trace.citations,
      capabilityUpgradeSuggestions: trace.capabilityUpgradeSuggestions,
      specialistCandidateSuggestions: trace.specialistCandidateSuggestions,
      failure: trace.failure,
      startedAt: trace.startedAt,
      finishedAt: trace.finishedAt,
    });
  }

  await host.storage.chatMessages.upsertMany(messageCopies);
  for (const traceCopy of traceCopies) {
    await host.storage.chatTurnTraces.create(traceCopy);
  }

  const clonedSourceTurnId = turnIdMap.get(input.sourceTurnId);
  if (!clonedSourceTurnId) {
    throw new Error(`Failed to clone replay source turn ${input.sourceTurnId}`);
  }
  return { sourceTurnId: clonedSourceTurnId };
}
