import type {
  ChatMode,
  ChatProjectRecord,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatCompletionRequest,
  ChatSessionLifecycleStatus,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  SessionMeta,
} from "@goatcitadel/contracts";

export function assertChatSessionActive(sessionId: string, lifecycleStatus: ChatSessionLifecycleStatus): void {
  if (lifecycleStatus === "archived") {
    throw new Error(`Session ${sessionId} is archived`);
  }
}

export function deriveChatSessionTitleFromContent(content: string): string | undefined {
  const firstLine = content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  const sanitized = firstLine
    .replace(/^[-*#>\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, 72).trim();
}

export function shouldAllowCrossProviderFallback(
  request: Pick<ChatCompletionRequest, "providerId" | "model">,
): boolean {
  return request.providerId == null;
}

export function buildChatSessionUpdatedPayload(
  type:
    | "chat_session_pinned"
    | "chat_session_unpinned"
    | "chat_session_archived"
    | "chat_session_restored"
    | "chat_session_project_assigned"
    | "chat_session_project_unassigned",
  session: Pick<ChatSessionRecord, "sessionId" | "pinned" | "lifecycleStatus" | "archivedAt" | "projectId">,
): Record<string, unknown> {
  switch (type) {
    case "chat_session_pinned":
    case "chat_session_unpinned":
      return {
        type,
        sessionId: session.sessionId,
        pinned: session.pinned,
      };
    case "chat_session_archived":
    case "chat_session_restored":
      return {
        type,
        sessionId: session.sessionId,
        lifecycleStatus: session.lifecycleStatus,
        archivedAt: session.archivedAt,
      };
    case "chat_session_project_assigned":
    case "chat_session_project_unassigned":
      return {
        type,
        sessionId: session.sessionId,
        projectId: session.projectId,
      };
  }
}

export function toChatSessionRecord(
  session: SessionMeta,
  meta: {
    revision: number;
    workspaceId?: string;
    mode?: ChatMode;
    title?: string;
    origin?: "operator" | "prompt_pack" | "system";
    includeInHistory: boolean;
    pinned: boolean;
    lifecycleStatus: "active" | "archived";
    archivedAt?: string;
    folderId?: string;
    folderName?: string;
    tags?: string[];
    pinnedGoal?: string;
    goalTurnBudget?: number;
    goalTurnsUsed?: number;
    goalSetAt?: string;
  },
  project?: ChatProjectRecord,
  extras?: Partial<
    Pick<
      ChatSessionRecord,
      "searchHits" | "lastHandoff" | "delegationParent" | "generatedArtifacts" | "forkRelationships"
    >
  >,
): ChatSessionRecord {
  return {
    sessionId: session.sessionId,
    revision: meta.revision,
    sessionKey: session.sessionKey,
    workspaceId: meta.workspaceId ?? project?.workspaceId,
    scope: session.channel === "mission" ? "mission" : "external",
    mode: meta.mode,
    origin: meta.origin,
    includeInHistory: meta.includeInHistory,
    title: meta.title ?? session.displayName,
    pinned: meta.pinned,
    lifecycleStatus: meta.lifecycleStatus,
    archivedAt: meta.archivedAt,
    folderId: meta.folderId,
    folderName: meta.folderName,
    tags: meta.tags ?? [],
    projectId: project?.projectId,
    projectName: project?.name,
    searchHits: extras?.searchHits,
    lastHandoff: extras?.lastHandoff,
    delegationParent: extras?.delegationParent,
    generatedArtifacts: extras?.generatedArtifacts,
    forkRelationships: extras?.forkRelationships,
    channel: session.channel,
    account: session.account,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    tokenTotal: session.tokenTotal,
    costUsdTotal: session.costUsdTotal,
    pinnedGoal: meta.pinnedGoal,
    goalTurnBudget: meta.goalTurnBudget,
    goalTurnsUsed: meta.goalTurnsUsed,
    goalSetAt: meta.goalSetAt,
  };
}

export function splitChatPrefsPatch(input: ChatSessionPrefsPatch): {
  basePatch: Pick<
    ChatSessionPrefsPatch,
    | "mode"
    | "planningMode"
    | "providerId"
    | "model"
    | "imageProviderId"
    | "imageModel"
    | "webMode"
    | "memoryMode"
    | "thinkingLevel"
    | "speedMode"
    | "subagentPolicy"
    | "toolAutonomy"
    | "visionFallbackModel"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
  >;
  autonomyPatch: Partial<{
    proactiveMode: ChatProactiveMode;
    maxActionsPerHour: number;
    maxActionsPerTurn: number;
    cooldownSeconds: number;
    retrievalMode: ChatRetrievalMode;
    reflectionMode: ChatReflectionMode;
  }>;
} {
  const basePatch: Pick<
    ChatSessionPrefsPatch,
    | "mode"
    | "planningMode"
    | "providerId"
    | "model"
    | "imageProviderId"
    | "imageModel"
    | "webMode"
    | "memoryMode"
    | "thinkingLevel"
    | "speedMode"
    | "subagentPolicy"
    | "toolAutonomy"
    | "visionFallbackModel"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
  > = {
    mode: input.mode,
    planningMode: input.planningMode,
    providerId: input.providerId,
    model: input.model,
    imageProviderId: input.imageProviderId,
    imageModel: input.imageModel,
    webMode: input.webMode,
    memoryMode: input.memoryMode,
    thinkingLevel: input.thinkingLevel,
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy,
    toolAutonomy: input.toolAutonomy,
    visionFallbackModel: input.visionFallbackModel,
    orchestrationEnabled: input.orchestrationEnabled,
    orchestrationIntensity: input.orchestrationIntensity,
    orchestrationVisibility: input.orchestrationVisibility,
    orchestrationProviderPreference: input.orchestrationProviderPreference,
    orchestrationReviewDepth: input.orchestrationReviewDepth,
    orchestrationParallelism: input.orchestrationParallelism,
    codeAutoApply: input.codeAutoApply,
  };

  return {
    basePatch,
    autonomyPatch: {
      proactiveMode: input.proactiveMode,
      maxActionsPerHour: input.autonomyBudget?.maxActionsPerHour,
      maxActionsPerTurn: input.autonomyBudget?.maxActionsPerTurn,
      cooldownSeconds: input.autonomyBudget?.cooldownSeconds,
      retrievalMode: input.retrievalMode,
      reflectionMode: input.reflectionMode,
    },
  };
}
