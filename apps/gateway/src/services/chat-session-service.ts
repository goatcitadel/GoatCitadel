/* eslint-disable max-lines -- Chat-session aggregate operations stay together so revision and deletion invariants remain visible. */
/**
 * Chat session service.
 *
 * Owns chat session CRUD / archive / prefs / binding behavior behind a
 * narrow deps contract so GatewayService can act as composition root
 * instead of the only usable session owner.
 *
 * Pattern reference: comms-service.ts, settings-auth-service.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import {
  applyChatModePresetToPatch,
  buildChatModePrefsPatch,
  ConflictError,
  CHAT_SESSION_FORK_MANIFEST_VERSION,
  isChatTurnTerminalStatus,
  type ChatSessionBindingRecord,
  type ChatSessionBulkArchiveInput,
  type ChatSessionBulkArchiveResult,
  type ChatSessionCreateInput,
  type ChatSessionListQuery,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatSessionRecord,
  type ChatSessionForkManifest,
  type ChatSessionForkRequest,
  type ChatSessionForkResponse,
  type ChatSessionSearchHitRecord,
  type ChatSessionSearchQuery,
  type ChatSessionSearchResponse,
  type ChatSessionSearchResult,
  type ChatSideChatRecord,
  type RecentCrossProjectSession,
  type SessionMeta,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  buildChatSessionUpdatedPayload,
  deriveChatSessionTitleFromContent,
  splitChatPrefsPatch,
  toChatSessionRecord,
} from "./chat-session-utils.js";
import { buildGeneratedArtifactReference } from "./chat-generated-artifact-service.js";
import { preserveChatSessionSecretsForPublicUpdate } from "./chat-secret-projection.js";

const log = logger.child("chat-session-service");
const MISSING_CHAT_SESSION_META_WORKSPACE_ID = "__legacy_unknown__";

export interface ChatSessionDependencies {
  readonly storage: Storage;
  readonly operatorSummaryCache: {
    invalidate(): void;
  };
  normalizeWorkspaceId(workspaceId?: string): string;
  ensureChatSessionRuntimeGrants(sessionId: string): void;
  requireChatSession(sessionId: string): ChatSessionRecord;
  getSession(sessionId: string): SessionMeta;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
  clearChatTurnWriteLease(sessionId: string): void;
  removeChatSessionStoredFile(storageRelPath: string): Promise<void>;
  copyChatSessionStoredFile(storageRelPath: string, copyId: string): Promise<string>;
  ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  hydrateChatPrefsWithAutonomy(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  patchSessionAutonomyPrefs(sessionId: string, patch: ReturnType<typeof splitChatPrefsPatch>["autonomyPatch"]): void;
}

export function listChatSessions(deps: ChatSessionDependencies, query: ChatSessionListQuery = {}): ChatSessionRecord[] {
  const workspaceId = deps.normalizeWorkspaceId(query.workspaceId);
  const scope = query.scope ?? "all";
  const view = query.view ?? "active";
  const includeHidden = query.includeHidden ?? false;
  const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 200)));
  const candidates = deps.storage.chatSessionLists.listCandidates({
    workspaceId,
    scope,
    view,
    includeHidden,
    projectId: query.projectId,
    folderId: query.folderId,
    tag: query.tag,
    mode: query.mode,
    q: query.q,
    cursor: query.cursor,
    limit: limit + 1,
  });
  const sessionIds = candidates.slice(0, limit).map((candidate) => candidate.sessionId);
  const candidateOrderBySessionId = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
  const sessionsById = deps.storage.sessions.listBySessionIds(sessionIds);
  const projects = deps.storage.chatProjects.list("all", 2000, workspaceId);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const metaBySessionId = deps.storage.chatSessionMeta.listBySessionIds(sessionIds);
  const prefsBySessionId = deps.storage.chatSessionPrefs.listBySessionIds(sessionIds);
  const projectLinkBySessionId = deps.storage.chatSessionProjects.listBySessionIds(sessionIds);
  const generatedArtifactsBySessionId = deps.storage.chatGeneratedArtifacts.listBySessionIds(sessionIds);
  const forkRelationshipsBySessionId = new Map(
    sessionIds.map((sessionId) => [sessionId, deps.storage.chatSessionForks.listRelationships(sessionId, workspaceId)]),
  );
  const delegationParentBySessionId = deps.storage.chatDelegationSteps.listParentsByChildSessionIds(
    sessionIds,
    workspaceId,
  );

  let records = sessionIds.flatMap((sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) {
      return [];
    }
    const meta = metaBySessionId.get(session.sessionId) ?? {
      revision: 1,
      workspaceId: MISSING_CHAT_SESSION_META_WORKSPACE_ID,
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active" as const,
      tags: [],
    };
    const link = projectLinkBySessionId.get(session.sessionId);
    const project = link ? projectById.get(link.projectId) : undefined;
    return toChatSessionRecord(
      session,
      { ...meta, mode: prefsBySessionId.get(session.sessionId)?.mode ?? "chat" },
      project,
      {
        delegationParent: delegationParentBySessionId.get(session.sessionId),
        generatedArtifacts: (generatedArtifactsBySessionId.get(session.sessionId) ?? [])
          .slice(0, 6)
          .map(buildGeneratedArtifactReference),
        forkRelationships: forkRelationshipsBySessionId.get(session.sessionId),
      },
    );
  });

  records = records.filter((record) => deps.normalizeWorkspaceId(record.workspaceId) === workspaceId);
  if (!includeHidden) {
    records = records.filter((record) => record.includeInHistory);
  }

  if (scope !== "all") {
    records = records.filter((record) => record.scope === scope);
  }
  if (view !== "all") {
    records = records.filter((record) => record.lifecycleStatus === view);
  }
  if (query.projectId) {
    records = records.filter((record) => record.projectId === query.projectId);
  }
  if (query.folderId?.trim()) {
    records = records.filter((record) => record.folderId === query.folderId?.trim());
  }
  if (query.tag?.trim()) {
    const tag = query.tag.trim().toLowerCase();
    records = records.filter((record) => (record.tags ?? []).some((item) => item.toLowerCase() === tag));
  }
  if (query.mode) {
    records = records.filter(
      (record) => normalizeConversationMode(record.mode) === normalizeConversationMode(query.mode),
    );
  }

  const searchHitsBySessionId = query.q?.trim()
    ? buildSessionSearchHits(
        deps,
        workspaceId,
        records.map((record) => record.sessionId),
        query.q.trim(),
        Math.min(50, Math.max(limit * 4, 20)),
        includeHidden,
      )
    : new Map<string, ChatSessionSearchHitRecord[]>();
  const searchScoreBySessionId = new Map<string, number>();
  if (query.q?.trim()) {
    const searchQuery = query.q.trim().toLowerCase();
    records = records.filter((record) => {
      const metadataHaystack = [
        record.title ?? "",
        record.sessionKey,
        record.channel,
        record.account,
        record.projectName ?? "",
        record.folderName ?? "",
        ...(record.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      const metadataMatched = metadataHaystack.includes(searchQuery);
      const hits = searchHitsBySessionId.get(record.sessionId) ?? [];
      if (!metadataMatched && hits.length === 0) {
        return false;
      }
      searchScoreBySessionId.set(
        record.sessionId,
        (metadataMatched ? 10 : 0) + hits.reduce((sum, hit) => sum + hit.score, 0),
      );
      record.searchHits = hits;
      return true;
    });
  }

  records.sort((left, right) => {
    if (query.q?.trim()) {
      return (
        (candidateOrderBySessionId.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) -
        (candidateOrderBySessionId.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const searchDelta =
      (searchScoreBySessionId.get(right.sessionId) ?? 0) - (searchScoreBySessionId.get(left.sessionId) ?? 0);
    if (searchDelta !== 0) {
      return searchDelta;
    }
    const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (byUpdated !== 0) {
      return byUpdated;
    }
    return right.sessionId.localeCompare(left.sessionId);
  });

  return records.slice(0, limit);
}

export async function forkChatSessionFromTurn(
  deps: ChatSessionDependencies,
  sessionId: string,
  turnId: string,
  input: ChatSessionForkRequest,
  actorId: string,
): Promise<ChatSessionForkResponse> {
  const source = deps.requireChatSession(sessionId);
  const workspaceId = deps.normalizeWorkspaceId(source.workspaceId);
  if (input.expectedRevision !== undefined && source.revision !== input.expectedRevision) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Chat session revision changed from ${input.expectedRevision} to ${source.revision}.`,
    });
  }
  const traces = deps.storage.chatTurnTraces.listBySession(sessionId, 10_000);
  const traceById = new Map(traces.map((trace) => [trace.turnId, trace]));
  const selected = traceById.get(turnId);
  if (!selected || selected.sessionId !== sessionId) {
    throw new Error(`Turn ${turnId} is not part of chat session ${sessionId}.`);
  }
  const path = buildForkPath(traceById, turnId);
  for (const trace of path) {
    const unsettledTool = trace.toolRuns.some((run) => run.status === "started" || run.status === "approval_required");
    if (
      !isChatTurnTerminalStatus(trace.status) ||
      trace.pendingApprovalSummary ||
      trace.pendingUserInput ||
      unsettledTool
    ) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Turn ${trace.turnId} still has unsettled work.` });
    }
  }

  const sourceMessages = deps.storage.chatMessages.listByMessageIds(
    path.flatMap((trace) => [trace.userMessageId, trace.assistantMessageId].filter((id): id is string => Boolean(id))),
  );
  const sourceAttachments = deps.storage.chatAttachments.listByIds(
    [
      ...new Set(
        [...sourceMessages.values()].flatMap((message) => message.attachments?.map((item) => item.attachmentId) ?? []),
      ),
    ],
    workspaceId,
  );
  const copiedAttachmentStorage = await Promise.all(
    sourceAttachments.map(async (attachment) => ({
      attachment,
      storageRelPath: await deps.copyChatSessionStoredFile(attachment.storageRelPath, randomUUID()),
    })),
  );

  const createdAt = new Date().toISOString();
  const title = input.title?.trim() || `Fork of ${source.title?.trim() || "Chat"}`;
  const created = createChatSession(deps, { workspaceId, title, mode: "chat", origin: "operator" });
  const forkId = `fork_${randomUUID()}`;
  const turnIdMap = new Map(path.map((trace) => [trace.turnId, `turn_${randomUUID()}`]));
  const messageIdMap = new Map<string, string>();
  const attachmentIdMap = new Map(
    copiedAttachmentStorage.map(({ attachment }) => [attachment.attachmentId, `att_${randomUUID()}`]),
  );
  const traceHashes = new Map(path.map((trace) => [trace.turnId, sha256(stableJson(trace))]));
  const messageMappings: ChatSessionForkManifest["messageMappings"] = [];
  const turnMappings: ChatSessionForkManifest["turnMappings"] = [];
  const artifactCopies: ChatSessionForkManifest["artifactCopies"] = [];

  deps.storage.runImmediateTransaction(() => {
    const sourcePrefs = deps.storage.chatSessionPrefs.get(sessionId);
    if (sourcePrefs) {
      const {
        sessionId: _sessionId,
        revision: _revision,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...prefs
      } = sourcePrefs;
      deps.storage.chatSessionPrefs.patch(created.sessionId, prefs, createdAt);
    }
    const sourceProject = deps.storage.chatSessionProjects.get(sessionId);
    if (sourceProject) {
      deps.storage.chatSessionProjects.assign(created.sessionId, sourceProject.projectId, createdAt);
    }
    for (const { attachment, storageRelPath } of copiedAttachmentStorage) {
      const copiedAttachmentId = attachmentIdMap.get(attachment.attachmentId)!;
      deps.storage.chatAttachments.create(
        { ...attachment, attachmentId: copiedAttachmentId, sessionId: created.sessionId, storageRelPath },
        attachment.createdAt,
      );
    }
    for (const trace of path) {
      const copiedTurnId = turnIdMap.get(trace.turnId)!;
      const copyMessage = (sourceMessageId: string | undefined): string | undefined => {
        if (!sourceMessageId) return undefined;
        const message = sourceMessages.get(sourceMessageId);
        if (!message) return undefined;
        const copiedMessageId = `msg_${randomUUID()}`;
        messageIdMap.set(sourceMessageId, copiedMessageId);
        deps.storage.chatMessages.upsert({
          ...message,
          messageId: copiedMessageId,
          sessionId: created.sessionId,
          attachments: message.attachments?.map((attachment) => ({
            ...attachment,
            attachmentId: attachmentIdMap.get(attachment.attachmentId) ?? attachment.attachmentId,
          })),
        });
        messageMappings.push({
          sourceMessageId,
          copiedMessageId,
          sourceTurnId: trace.turnId,
          copiedTurnId,
          role: message.role,
          contentHash: sha256(message.content),
        });
        return copiedMessageId;
      };
      const copiedUserMessageId = copyMessage(trace.userMessageId);
      if (!copiedUserMessageId) throw new Error(`Fork source user message ${trace.userMessageId} is missing.`);
      const copiedAssistantMessageId = copyMessage(trace.assistantMessageId);
      const sourceTraceHash = traceHashes.get(trace.turnId)!;
      const importedRouting = {
        ...trace.routing,
        forkImport: {
          sourceSessionId: sessionId,
          sourceTurnId: trace.turnId,
          sourceTraceHash,
          importedAt: createdAt,
          durableRunId: trace.durable?.runId,
          toolRunHashes: trace.toolRuns.map((run) => sha256(stableJson(run))),
          approvalHashes: deps.storage.chatInlineApprovals
            .listByTurn(trace.turnId)
            .map((approval) => sha256(stableJson(approval))),
        },
      };
      const copied = deps.storage.chatTurnTraces.create({
        turnId: copiedTurnId,
        sessionId: created.sessionId,
        userMessageId: copiedUserMessageId,
        parentTurnId: trace.parentTurnId ? turnIdMap.get(trace.parentTurnId) : undefined,
        branchKind: "append",
        assistantMessageId: copiedAssistantMessageId,
        status: trace.status,
        mode: "chat",
        model: trace.model,
        webMode: trace.webMode,
        memoryMode: trace.memoryMode,
        thinkingLevel: trace.thinkingLevel,
        speedMode: trace.speedMode,
        subagentPolicy: trace.subagentPolicy,
        effectiveToolAutonomy: trace.effectiveToolAutonomy,
        routing: importedRouting,
        retrieval: trace.retrieval,
        reflection: trace.reflection,
        completion: trace.completion,
        guidance: trace.guidance,
        citations: trace.citations,
        failure: trace.failure,
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
      });
      turnMappings.push({
        sourceTurnId: trace.turnId,
        copiedTurnId,
        sourceParentTurnId: trace.parentTurnId,
        copiedParentTurnId: copied.parentTurnId,
        sourceTraceHash,
        copiedTraceHash: sha256(stableJson(copied)),
      });
      const sourceArtifacts = deps.storage.chatGeneratedArtifacts.listByTurn(trace.turnId, 100);
      const artifactIdMap = new Map<string, string>();
      for (const artifact of sourceArtifacts.sort((a, b) => a.version - b.version)) {
        const copiedArtifactId = `artifact_${randomUUID()}`;
        artifactIdMap.set(artifact.artifactId, copiedArtifactId);
        const contentHash = artifact.contentHash ?? sha256(artifact.content);
        deps.storage.chatGeneratedArtifacts.create({
          ...artifact,
          artifactId: copiedArtifactId,
          sessionId: created.sessionId,
          workspaceId,
          turnId: copiedTurnId,
          supersedesArtifactId: artifact.supersedesArtifactId
            ? artifactIdMap.get(artifact.supersedesArtifactId)
            : undefined,
          contentHash,
        });
        artifactCopies.push({
          sourceArtifactId: artifact.artifactId,
          copiedArtifactId,
          contentHash,
          version: artifact.version,
        });
      }
    }
    deps.storage.chatSessionBranchState.setActiveLeaf(created.sessionId, turnIdMap.get(turnId)!, createdAt);
    const contextSnapshotHashes = path.flatMap((trace) => {
      const snapshot = deps.storage.routedContextSnapshots.findByTurn(trace.turnId);
      return snapshot ? [snapshot.snapshotHash] : [];
    });
    const manifest: ChatSessionForkManifest = {
      manifestVersion: CHAT_SESSION_FORK_MANIFEST_VERSION,
      forkId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      newSessionId: created.sessionId,
      workspaceId,
      transcriptPathHash: sha256(stableJson(messageMappings.map((mapping) => [mapping.role, mapping.contentHash]))),
      turnMappings,
      messageMappings,
      attachmentCopies: copiedAttachmentStorage.map(({ attachment }) => ({
        sourceAttachmentId: attachment.attachmentId,
        copiedAttachmentId: attachmentIdMap.get(attachment.attachmentId)!,
        sha256: attachment.sha256,
      })),
      artifactCopies,
      contextSnapshotHashes,
      sourceEvidenceHashes: [...new Set(turnMappings.flatMap((mapping) => [mapping.sourceTraceHash]))],
      createdByActorId: actorId,
      createdAt,
    };
    deps.storage.chatSessionForks.create(manifest);
  });
  deps.operatorSummaryCache.invalidate();
  const manifest = deps.storage.chatSessionForks.get(forkId);
  const session = {
    ...deps.requireChatSession(created.sessionId),
    forkRelationships: deps.storage.chatSessionForks.listRelationships(created.sessionId, workspaceId),
  };
  deps.publishRealtime("chat_session_forked", "gateway", {
    forkId,
    sourceSessionId: sessionId,
    newSessionId: created.sessionId,
    sourceTurnId: turnId,
  });
  return { session, manifest };
}

function buildForkPath(
  traceById: Map<string, ReturnType<Storage["chatTurnTraces"]["get"]>>,
  turnId: string,
): ReturnType<Storage["chatTurnTraces"]["get"]>[] {
  const path: ReturnType<Storage["chatTurnTraces"]["get"]>[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = turnId;
  while (cursor) {
    if (visited.has(cursor)) throw new Error("Chat turn ancestry contains a cycle.");
    visited.add(cursor);
    const trace = traceById.get(cursor);
    if (!trace) throw new Error(`Chat turn ancestry is incomplete at ${cursor}.`);
    path.push(trace);
    cursor = trace.parentTurnId;
  }
  return path.reverse();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function searchChatSessions(
  deps: ChatSessionDependencies,
  input: ChatSessionSearchQuery,
): ChatSessionSearchResponse {
  const query = input.query.trim();
  if (!query) {
    throw new Error("query is required for session search");
  }
  if (query.length > 512) {
    throw new Error("session search query must be 512 characters or fewer");
  }
  const mode = input.mode ?? "discovery";
  const limit = Math.max(
    1,
    Math.min(mode === "browse" ? 200 : mode === "scroll" ? 100 : 50, Math.floor(input.limit ?? 20)),
  );
  const candidates = listChatSessions(deps, {
    workspaceId: input.workspaceId,
    scope: "all",
    view: input.view ?? "all",
    mode: input.surface,
    q: query,
    limit: limit + 1,
    cursor: input.cursor,
    includeHidden: input.includeHidden ?? false,
  });
  const normalizedQuery = query.toLowerCase();
  const items: ChatSessionSearchResult[] = [];

  for (const session of candidates.slice(0, limit)) {
    const matchedFields = collectSessionSearchMatchedFields(session, normalizedQuery);
    const hits = session.searchHits ?? [];
    if (matchedFields.length === 0 && hits.length === 0) {
      continue;
    }
    const hitScore = hits.reduce((sum, hit) => sum + hit.score, 0);
    const metadataScore = matchedFields.length * 8;
    const recencyScore = Number.isFinite(Date.parse(session.updatedAt)) ? Date.parse(session.updatedAt) / 1e13 : 0;
    items.push({
      session: {
        ...session,
        searchHits: hits,
      },
      hits,
      matchedFields,
      score: metadataScore + hitScore + recencyScore,
    });
  }

  const last = items.at(-1)?.session;
  return {
    items,
    nextCursor: candidates.length > limit && last ? `${last.updatedAt}|${last.sessionId}` : undefined,
    query,
    mode,
    generatedAt: new Date().toISOString(),
  };
}

export function createChatSession(
  deps: ChatSessionDependencies,
  input: ChatSessionCreateInput = {},
): ChatSessionRecord {
  const peer = `chat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return upsertChatSessionForPeer(deps, peer, input);
}

/** Internal orchestration seam: the same stable key always resolves to one upserted child session. */
export function ensureChatSessionWithStableKey(
  deps: ChatSessionDependencies,
  stableKey: string,
  input: ChatSessionCreateInput = {},
): ChatSessionRecord {
  const normalizedStableKey = stableKey.trim();
  if (!normalizedStableKey) {
    throw new Error("stable chat session key is required");
  }
  const peer = `chat_${createHash("sha256").update(`stable:${normalizedStableKey}`).digest("hex").slice(0, 24)}`;
  return upsertChatSessionForPeer(deps, peer, input);
}

function upsertChatSessionForPeer(
  deps: ChatSessionDependencies,
  peer: string,
  input: ChatSessionCreateInput,
): ChatSessionRecord {
  const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
  const route = {
    channel: "mission",
    account: "operator",
    peer,
  };
  const resolution = {
    kind: "dm" as const,
    sessionKey: `${route.channel}:${route.account}:${route.peer}`,
    sessionId: `sess_${createHash("sha256").update(`${route.channel}:${route.account}:${route.peer}`).digest("hex").slice(0, 24)}`,
  };
  const now = new Date().toISOString();
  deps.storage.runImmediateTransaction(() => {
    const existingMeta = deps.storage.chatSessionMeta.get(resolution.sessionId);
    if (existingMeta && deps.normalizeWorkspaceId(existingMeta.workspaceId) !== workspaceId) {
      throw new Error("stable chat session key already belongs to another workspace");
    }
    deps.storage.sessions.upsert({
      sessionId: resolution.sessionId,
      sessionKey: resolution.sessionKey,
      kind: resolution.kind,
      channel: route.channel,
      account: route.account,
      displayName: input.title?.trim() || undefined,
      timestamp: now,
    });
    deps.storage.chatSessionMeta.ensure(resolution.sessionId, now, workspaceId);
    deps.storage.chatSessionPrefs.ensure(resolution.sessionId, now);
    deps.storage.chatSessionMeta.patch(
      resolution.sessionId,
      {
        workspaceId,
        title: input.title?.trim() ? input.title.trim() : undefined,
        origin: input.origin,
        includeInHistory: input.includeInHistory,
        folderId: input.folderId,
        folderName: input.folderName,
        tags: input.tags,
      },
      now,
    );
    deps.storage.chatSessionBindings.upsert(
      {
        sessionId: resolution.sessionId,
        workspaceId,
        transport: "llm",
        writable: true,
      },
      now,
    );
    if (input.projectId) {
      const project = deps.storage.chatProjects.get(input.projectId);
      if (deps.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
        throw new Error("project workspace does not match requested session workspace");
      }
      deps.storage.chatSessionProjects.assign(resolution.sessionId, input.projectId, now);
    }
  });
  deps.ensureChatSessionRuntimeGrants(resolution.sessionId);
  deps.operatorSummaryCache.invalidate();
  if (input.mode) {
    updateChatSessionPrefs(deps, resolution.sessionId, buildChatModePrefsPatch(input.mode));
  }
  const created = deps.requireChatSession(resolution.sessionId);
  if (!created) {
    throw new Error(`Failed to create chat session ${resolution.sessionId}`);
  }
  deps.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_created",
    sessionId: created.sessionId,
    sessionKey: created.sessionKey,
  });
  return created;
}

export function getChatSideChat(
  deps: ChatSessionDependencies,
  parentSessionId: string,
): { item: ChatSideChatRecord | null; childSession?: ChatSessionRecord } {
  const parent = deps.requireChatSession(parentSessionId);
  const parentWorkspaceId = deps.normalizeWorkspaceId(parent.workspaceId);
  const item = deps.storage.chatSideChats.getByParentSession(parent.sessionId);
  if (!item || deps.normalizeWorkspaceId(item.workspaceId) !== parentWorkspaceId) {
    return { item: null };
  }
  const childSession = deps.requireChatSession(item.childSessionId);
  if (deps.normalizeWorkspaceId(childSession.workspaceId) !== parentWorkspaceId) {
    throw new Error("Side chat child workspace does not match parent session workspace.");
  }
  return {
    item,
    childSession,
  };
}

export function createChatSideChat(
  deps: ChatSessionDependencies,
  parentSessionId: string,
  input: { createdFromSurface?: ChatSessionRecord["mode"]; sourceTurnId?: string } = {},
): { item: ChatSideChatRecord; childSession: ChatSessionRecord } {
  const parent = deps.requireChatSession(parentSessionId);
  const parentWorkspaceId = deps.normalizeWorkspaceId(parent.workspaceId);
  const existing = deps.storage.chatSideChats.getByParentSession(parent.sessionId);
  if (existing && deps.normalizeWorkspaceId(existing.workspaceId) === parentWorkspaceId) {
    const existingChildSession = deps.requireChatSession(existing.childSessionId);
    if (deps.normalizeWorkspaceId(existingChildSession.workspaceId) !== parentWorkspaceId) {
      throw new Error("Side chat child workspace does not match parent session workspace.");
    }
    return {
      item: existing,
      childSession: existingChildSession,
    };
  }

  const parentTitle = parent.title?.trim() || `Chat ${parent.sessionId.slice(-6)}`;
  const childSession = createChatSession(deps, {
    workspaceId: parentWorkspaceId,
    projectId: parent.projectId,
    title: `Side chat - ${trimTitleForSideChat(parentTitle)}`,
    mode: "chat",
    origin: "operator",
    includeInHistory: false,
  });
  const now = new Date().toISOString();
  const item = deps.storage.chatSideChats.upsert(
    {
      sideChatId: `btw_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
      parentSessionId: parent.sessionId,
      childSessionId: childSession.sessionId,
      workspaceId: parentWorkspaceId,
      createdFromSurface: input.createdFromSurface ?? parent.mode ?? "chat",
      sourceTurnId: input.sourceTurnId,
    },
    now,
  );
  deps.operatorSummaryCache.invalidate();
  deps.publishRealtime("chat_session_updated", "chat", {
    type: "chat_side_chat_created",
    sessionId: parent.sessionId,
    sideChatId: item.sideChatId,
    childSessionId: childSession.sessionId,
  });
  return { item, childSession };
}

export function updateChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  input: { title?: string; folderId?: string; folderName?: string; tags?: string[] },
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const current = deps.requireChatSession(sessionId);
  const reconciled = preserveChatSessionSecretsForPublicUpdate(current, input);
  deps.storage.chatSessionMeta.patchWithRevision(
    sessionId,
    {
      title: reconciled.title,
      folderId: reconciled.folderId,
      folderName: reconciled.folderName,
      tags: reconciled.tags,
    },
    expectedRevision ?? current.revision,
  );
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime("chat_session_title_updated", "chat", {
    type: "chat_session_title_updated",
    sessionId: updated.sessionId,
    title: updated.title,
    folderId: updated.folderId,
    folderName: updated.folderName,
    tags: updated.tags ?? [],
  });
  return updated;
}

export function maybeAutoTitleChatSession(deps: ChatSessionDependencies, sessionId: string, content: string): void {
  const meta = deps.storage.chatSessionMeta.ensure(sessionId);
  if (meta.title?.trim()) {
    return;
  }
  const derivedTitle = deriveChatSessionTitleFromContent(content);
  if (!derivedTitle) {
    return;
  }
  try {
    deps.storage.chatSessionMeta.patchWithRevision(sessionId, { title: derivedTitle }, meta.revision);
  } catch (error) {
    if (error instanceof ConflictError) {
      // A newer operator/runtime writer won after the untitled snapshot was
      // read. Auto-title must never overwrite that newer value.
      return;
    }
    throw error;
  }
  deps.publishRealtime("chat_session_title_updated", "chat", {
    type: "chat_session_title_updated",
    sessionId,
    title: derivedTitle,
  });
}

export function pinChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const current = deps.requireChatSession(sessionId);
  deps.storage.chatSessionMeta.patchWithRevision(sessionId, { pinned: true }, expectedRevision ?? current.revision);
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_pinned", updated));
  return updated;
}

export function unpinChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const current = deps.requireChatSession(sessionId);
  deps.storage.chatSessionMeta.patchWithRevision(sessionId, { pinned: false }, expectedRevision ?? current.revision);
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_unpinned", updated),
  );
  return updated;
}

export function archiveChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const current = deps.requireChatSession(sessionId);
  deps.storage.chatSessionMeta.patchWithRevision(
    sessionId,
    {
      lifecycleStatus: "archived",
      archivedAt: new Date().toISOString(),
    },
    expectedRevision ?? current.revision,
  );
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_archived", updated),
  );
  return updated;
}

export function restoreChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const current = deps.requireChatSession(sessionId);
  deps.storage.chatSessionMeta.patchWithRevision(
    sessionId,
    {
      lifecycleStatus: "active",
      archivedAt: undefined,
    },
    expectedRevision ?? current.revision,
  );
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_restored", updated),
  );
  return updated;
}

export async function deleteChatSession(
  deps: ChatSessionDependencies,
  sessionId: string,
  expectedRevision?: number,
): Promise<{ deleted: boolean; sessionId: string }> {
  let currentWithoutExpectedRevision: ChatSessionRecord | undefined;
  if (expectedRevision === undefined) {
    deps.getSession(sessionId);
    currentWithoutExpectedRevision = deps.requireChatSession(sessionId);
  }
  const rootRevision = expectedRevision ?? currentWithoutExpectedRevision!.revision;
  const idempotencyKey = `lifecycle:delete:${sessionId}:${rootRevision}`;
  const correlationId = `chat-session-delete:${sessionId}:${rootRevision}`;
  let deletionResults: ReturnType<Storage["deleteChatSessionTreeWithRevision"]>;
  if (expectedRevision !== undefined) {
    try {
      deletionResults = deps.storage.replayChatSessionTreeDeletion({
        rootSessionId: sessionId,
        expectedRootRevision: rootRevision,
        actorId: "operator",
        idempotencyKey,
        correlationId,
      });
    } catch (error) {
      const liveReplayConflict =
        error instanceof ConflictError && error.details?.sessionLifecycleCode === "CHAT_SESSION_DELETE_REPLAY_LIVE";
      if (!liveReplayConflict) throw error;
      const currentMeta = deps.storage.chatSessionMeta.get(sessionId);
      if (!currentMeta) throw error;
      deletionResults = deps.storage.deleteChatSessionTreeWithRevision({
        workspaceId: deps.normalizeWorkspaceId(currentMeta.workspaceId),
        rootSessionId: sessionId,
        expectedRootRevision: rootRevision,
        actorId: "operator",
        idempotencyKey,
        correlationId,
      });
    }
  } else {
    deletionResults = deps.storage.deleteChatSessionTreeWithRevision({
      workspaceId: deps.normalizeWorkspaceId(currentWithoutExpectedRevision!.workspaceId),
      rootSessionId: sessionId,
      expectedRootRevision: rootRevision,
      actorId: "operator",
      idempotencyKey,
      correlationId,
    });
  }
  for (const deleted of deletionResults) {
    deps.clearChatTurnWriteLease(deleted.sessionId);
  }
  deps.operatorSummaryCache.invalidate();
  const cleanupResults = await Promise.allSettled([
    ...deletionResults.map((deleted) => deps.storage.transcripts.delete(deleted.sessionId)),
    ...deletionResults.flatMap((deleted) =>
      deleted.cleanupRelPaths.map((storageRelPath) => deps.removeChatSessionStoredFile(storageRelPath)),
    ),
  ]);
  for (const cleanupResult of cleanupResults) {
    if (cleanupResult.status === "rejected") {
      log.warn("chat session delete cleanup failed", {
        sessionId,
        error: cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason),
      });
    }
  }
  deps.publishRealtime("chat_session_deleted", "chat", {
    type: "chat_session_deleted",
    sessionId,
    mode: "hard",
  });
  return {
    deleted: deletionResults.some((result) => result.sessionId === sessionId && result.deleted),
    sessionId,
  };
}

function trimTitleForSideChat(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 60) {
    return compact || "chat";
  }
  return `${compact.slice(0, 57).trimEnd()}...`;
}

export async function archiveChatSessionsBulk(
  deps: ChatSessionDependencies,
  input: ChatSessionBulkArchiveInput = {},
): Promise<ChatSessionBulkArchiveResult> {
  const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
  const scope = input.scope ?? "mission";
  const candidates = listChatSessions(deps, {
    workspaceId,
    scope,
    view: "active",
    limit: 20_000,
    includeHidden: input.includeHidden ?? false,
  });
  const archivedSessionIds: string[] = [];
  const failures: ChatSessionBulkArchiveResult["failures"] = [];

  for (const session of candidates) {
    try {
      const archived = archiveChatSession(deps, session.sessionId, session.revision);
      archivedSessionIds.push(archived.sessionId);
    } catch (error) {
      failures.push({
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    workspaceId,
    scope,
    attemptedCount: candidates.length,
    archivedCount: archivedSessionIds.length,
    skippedCount: 0,
    failedCount: failures.length,
    archivedSessionIds,
    failures,
  };
}

export function assignChatSessionProject(
  deps: ChatSessionDependencies,
  sessionId: string,
  projectId?: string,
  expectedRevision?: number,
): ChatSessionRecord {
  deps.getSession(sessionId);
  const meta = deps.storage.chatSessionMeta.ensure(sessionId);
  const workspaceId = deps.normalizeWorkspaceId(meta.workspaceId);
  if (projectId) {
    const project = deps.storage.chatProjects.get(projectId);
    if (deps.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
      throw new Error("project workspace does not match session workspace");
    }
  }
  deps.storage.runImmediateTransaction(() => {
    let changed: boolean;
    if (projectId) {
      const assignment = deps.storage.chatSessionProjects.assignWithRevision(
        sessionId,
        projectId,
        expectedRevision ?? meta.revision,
      );
      changed = assignment.revision !== (expectedRevision ?? meta.revision);
    } else {
      const unassignment = deps.storage.chatSessionProjects.unassignWithRevision(
        sessionId,
        expectedRevision ?? meta.revision,
      );
      changed = unassignment.unassigned;
    }
    if (changed) {
      deps.storage.chatGeneratedArtifacts.updateProjectForSession(sessionId, projectId);
      resetWorkbenchForProjectChange(deps, sessionId, projectId);
    }
  });
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload(
      projectId ? "chat_session_project_assigned" : "chat_session_project_unassigned",
      updated,
    ),
  );
  return updated;
}

function resetWorkbenchForProjectChange(deps: ChatSessionDependencies, sessionId: string, projectId?: string): void {
  deps.storage.chatSessionWorkbench.patch(sessionId, {
    projectId: projectId ?? "",
    baseRef: "",
    worktreePath: "",
    worktreeStatus: "uninitialized",
    activeFilePath: "",
    diffArtifactId: "",
    outputArtifactId: "",
    validationStatus: "idle",
    packageManager: null,
  });
}

export function getChatSessionBinding(
  deps: ChatSessionDependencies,
  sessionId: string,
): ChatSessionBindingRecord | undefined {
  deps.getSession(sessionId);
  return deps.storage.chatSessionBindings.get(sessionId);
}

export function setChatSessionBinding(
  deps: ChatSessionDependencies,
  input: {
    sessionId: string;
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  },
): ChatSessionBindingRecord {
  deps.getSession(input.sessionId);
  const sessionMeta = deps.storage.chatSessionMeta.ensure(input.sessionId);
  if (input.transport === "integration") {
    if (!input.connectionId?.trim() || !input.target?.trim()) {
      throw new Error("connectionId and target are required for integration transport");
    }
    deps.storage.integrationConnections.get(input.connectionId);
  }
  const binding = deps.storage.chatSessionBindings.upsert({
    sessionId: input.sessionId,
    workspaceId: deps.normalizeWorkspaceId(sessionMeta.workspaceId),
    transport: input.transport,
    connectionId: input.connectionId?.trim() || undefined,
    target: input.target?.trim() || undefined,
    writable: input.writable,
  });
  deps.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_binding_updated",
    sessionId: input.sessionId,
    transport: binding.transport,
  });
  return binding;
}

export function getChatSessionPrefs(deps: ChatSessionDependencies, sessionId: string): ChatSessionPrefsRecord {
  deps.getSession(sessionId);
  const prefs = deps.ensureChatSessionModelDefaults(sessionId, deps.storage.chatSessionPrefs.ensure(sessionId));
  return deps.hydrateChatPrefsWithAutonomy(sessionId, prefs);
}

export function updateChatSessionPrefs(
  deps: ChatSessionDependencies,
  sessionId: string,
  input: ChatSessionPrefsPatch,
  expectedRevision?: number,
): ChatSessionPrefsRecord {
  deps.getSession(sessionId);
  const { expectedRevision: inputExpectedRevision, ...prefsInput } = input;
  const normalizedInput = applyChatModePresetToPatch(prefsInput);
  const { basePatch, autonomyPatch } = splitChatPrefsPatch(normalizedInput);
  const currentRevision = deps.storage.chatSessionRevisions.ensure(sessionId).revision;
  const result = deps.storage.chatSessionRevisions.runWithRevision(
    sessionId,
    expectedRevision ?? inputExpectedRevision ?? currentRevision,
    () => {
      let baseResult = deps.storage.chatSessionPrefs.patchWithinAggregate(
        sessionId,
        basePatch,
        expectedRevision ?? inputExpectedRevision ?? currentRevision,
      );
      const normalizedBase = deps.ensureChatSessionModelDefaults(sessionId, baseResult.value);
      if (normalizedBase.model !== baseResult.value.model) {
        const normalizedResult = deps.storage.chatSessionPrefs.patchWithinAggregate(
          sessionId,
          { model: normalizedBase.model },
          expectedRevision ?? inputExpectedRevision ?? currentRevision,
        );
        baseResult = {
          value: normalizedResult.value,
          changed: baseResult.changed || normalizedResult.changed,
        };
      }
      const autonomyResult = deps.storage.sessionAutonomyPrefs.patchWithinAggregate(
        sessionId,
        autonomyPatch,
        expectedRevision ?? inputExpectedRevision ?? currentRevision,
      );
      return {
        value: baseResult.value,
        changed: baseResult.changed || autonomyResult.changed,
      };
    },
  );
  const hydrated = {
    ...deps.hydrateChatPrefsWithAutonomy(sessionId, result.value),
    revision: result.revision,
  };
  deps.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_prefs_updated",
    sessionId,
    prefs: hydrated,
  });
  return hydrated;
}

function buildSessionSearchHits(
  deps: ChatSessionDependencies,
  workspaceId: string,
  sessionIds: string[],
  query: string,
  limit = 160,
  includeHidden = false,
): Map<string, ChatSessionSearchHitRecord[]> {
  if (!query.trim() || sessionIds.length === 0) {
    return new Map();
  }
  const allowedSessionIds = new Set(sessionIds);
  const rows = deps.storage.chatMessages.searchMessages(query, {
    workspaceId,
    includeHidden,
    limit: Math.max(1, Math.min(50, limit)),
    contextRadius: 0,
  });

  const grouped = new Map<string, ChatSessionSearchHitRecord[]>();
  const appendRow = (row: (typeof rows)[number]) => {
    if (
      row.workspaceId !== workspaceId ||
      !allowedSessionIds.has(row.sessionId) ||
      !row.messageId ||
      !Number.isSafeInteger(row.sequence)
    ) {
      return;
    }
    const hits = grouped.get(row.sessionId) ?? [];
    hits.push({
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      messageId: row.messageId,
      sequence: row.sequence,
      excerpt: buildSearchExcerpt(row.content, query),
      score: scoreSearchHit(row.content, query),
      matchedText: query,
      timestamp: row.timestamp,
    });
    grouped.set(row.sessionId, hits);
  };
  for (const row of rows) {
    appendRow(row);
  }

  // The global rank is intentionally capped at 50. A later stable metadata
  // page can contain a content-only session below that global cut, so resolve
  // at most three scoped hits for each bounded page candidate not represented
  // above. This avoids both an unbounded scan and a giant dynamic IN clause.
  for (const sessionId of sessionIds) {
    if (grouped.has(sessionId)) {
      continue;
    }
    for (const row of deps.storage.chatMessages.searchMessages(query, {
      workspaceId,
      sessionId,
      includeHidden,
      limit: 3,
      contextRadius: 0,
    })) {
      appendRow(row);
    }
  }

  for (const [sessionId, hits] of grouped) {
    hits.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Date.parse(right.timestamp ?? "") - Date.parse(left.timestamp ?? "");
    });
    grouped.set(sessionId, hits.slice(0, 3));
  }

  return grouped;
}

function buildSearchExcerpt(content: string, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    return normalizedContent.slice(0, 180);
  }
  const matchIndex = normalizedContent.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return normalizedContent.slice(0, 180);
  }
  const start = Math.max(0, matchIndex - 48);
  const end = Math.min(normalizedContent.length, matchIndex + normalizedQuery.length + 96);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedContent.length ? "..." : "";
  return `${prefix}${normalizedContent.slice(start, end)}${suffix}`;
}

function normalizeConversationMode(_mode?: string): "chat" {
  return "chat";
}

function scoreSearchHit(content: string, query: string): number {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  if (normalizedContent.startsWith(normalizedQuery)) {
    return 6;
  }
  if (normalizedContent.includes(` ${normalizedQuery}`)) {
    return 4;
  }
  if (normalizedContent.includes(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function collectSessionSearchMatchedFields(session: ChatSessionRecord, normalizedQuery: string): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["title", session.title],
    ["sessionKey", session.sessionKey],
    ["channel", session.channel],
    ["account", session.account],
    ["projectName", session.projectName],
    ["folderName", session.folderName],
    ["mode", normalizeConversationMode(session.mode)],
  ];
  for (const tag of session.tags ?? []) {
    fields.push(["tags", tag]);
  }
  const matched = new Set<string>();
  for (const [field, value] of fields) {
    if (value?.toLowerCase().includes(normalizedQuery)) {
      matched.add(field);
    }
  }
  return [...matched];
}

const CROSS_PROJECT_RECENTS_MAX_LIMIT = 20;

/**
 * Lists recent sessions that are bound to a project, sorted by lastActivityAt desc.
 * turnCount is omitted for v1 — the storage layer does not denormalize it,
 * and computing it per session would require N additional queries.
 */
export function listRecentCrossProjectSessions(
  deps: ChatSessionDependencies,
  input: { workspaceId: string; limit: number },
): RecentCrossProjectSession[] {
  const limit = Math.max(1, Math.min(CROSS_PROJECT_RECENTS_MAX_LIMIT, input.limit));
  const fetchLimit = Math.max(20, limit * 3);

  const candidates = listChatSessions(deps, {
    workspaceId: input.workspaceId,
    scope: "all",
    view: "active",
    includeHidden: false,
    limit: fetchLimit,
  });

  const withProject = candidates.filter((record) => Boolean(record.projectId));
  withProject.sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));

  return withProject.slice(0, limit).map((record) => ({
    sessionId: record.sessionId,
    projectId: record.projectId as string,
    projectLabel: record.projectName ?? (record.projectId as string),
    title: record.title ?? null,
    sessionKey: record.sessionKey,
    mode: record.mode ?? "chat",
    lastActivityAt: record.lastActivityAt,
    lifecycleStatus: record.lifecycleStatus,
  }));
}
