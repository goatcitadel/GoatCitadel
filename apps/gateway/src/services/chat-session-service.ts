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
  type ChatSessionBindingRecord,
  type ChatSessionBulkArchiveInput,
  type ChatSessionBulkArchiveResult,
  type ChatSessionCreateInput,
  type ChatSessionListQuery,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatSessionRecord,
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
  const sessionsById = deps.storage.sessions.listBySessionIds(sessionIds);
  const projects = deps.storage.chatProjects.list("all", 2000, workspaceId);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const metaBySessionId = deps.storage.chatSessionMeta.listBySessionIds(sessionIds);
  const prefsBySessionId = deps.storage.chatSessionPrefs.listBySessionIds(sessionIds);
  const projectLinkBySessionId = deps.storage.chatSessionProjects.listBySessionIds(sessionIds);
  const generatedArtifactsBySessionId = deps.storage.chatGeneratedArtifacts.listBySessionIds(sessionIds);
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
    records = records.filter((record) => record.mode === query.mode);
  }

  const searchHitsBySessionId = query.q?.trim()
    ? buildSessionSearchHits(
        deps,
        records.map((record) => record.sessionId),
        query.q.trim(),
        Math.min(1000, Math.max(limit * 4, 160)),
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

export function searchChatSessions(
  deps: ChatSessionDependencies,
  input: ChatSessionSearchQuery,
): ChatSessionSearchResponse {
  const query = input.query.trim();
  if (!query) {
    throw new Error("query is required for session search");
  }
  const mode = input.mode ?? "discovery";
  const limit = Math.max(
    1,
    Math.min(mode === "browse" ? 200 : mode === "scroll" ? 100 : 50, Math.floor(input.limit ?? 20)),
  );
  const candidates = listChatSessions(deps, {
    workspaceId: input.workspaceId,
    scope: "all",
    view: "all",
    mode: input.surface,
    limit: 20_000,
    cursor: input.cursor,
    includeHidden: input.includeHidden ?? false,
  });
  const hitsBySessionId = buildSessionSearchHits(
    deps,
    candidates.map((session) => session.sessionId),
    query,
    Math.min(500, Math.max(limit * 8, 80)),
  );
  const normalizedQuery = query.toLowerCase();
  const items: ChatSessionSearchResult[] = [];

  for (const session of candidates) {
    const matchedFields = collectSessionSearchMatchedFields(session, normalizedQuery);
    const hits = hitsBySessionId.get(session.sessionId) ?? [];
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

  items.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const updatedDelta = Date.parse(right.session.updatedAt) - Date.parse(left.session.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return right.session.sessionId.localeCompare(left.session.sessionId);
  });
  const sliced = items.slice(0, limit);
  const last = sliced.at(-1)?.session;
  return {
    items: sliced,
    nextCursor: items.length > limit && last ? `${last.updatedAt}|${last.sessionId}` : undefined,
    query,
    mode,
    generatedAt: new Date().toISOString(),
  };
}

export function createChatSession(
  deps: ChatSessionDependencies,
  input: ChatSessionCreateInput = {},
): ChatSessionRecord {
  const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
  const peer = `chat_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
): ChatSessionRecord {
  deps.getSession(sessionId);
  deps.storage.chatSessionMeta.patch(sessionId, {
    title: input.title,
    folderId: input.folderId,
    folderName: input.folderName,
    tags: input.tags,
  });
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
  deps.storage.chatSessionMeta.patch(sessionId, { title: derivedTitle });
  deps.publishRealtime("chat_session_title_updated", "chat", {
    type: "chat_session_title_updated",
    sessionId,
    title: derivedTitle,
  });
}

export function pinChatSession(deps: ChatSessionDependencies, sessionId: string): ChatSessionRecord {
  deps.getSession(sessionId);
  deps.storage.chatSessionMeta.patch(sessionId, { pinned: true });
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_pinned", updated));
  return updated;
}

export function unpinChatSession(deps: ChatSessionDependencies, sessionId: string): ChatSessionRecord {
  deps.getSession(sessionId);
  deps.storage.chatSessionMeta.patch(sessionId, { pinned: false });
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_unpinned", updated),
  );
  return updated;
}

export function archiveChatSession(deps: ChatSessionDependencies, sessionId: string): ChatSessionRecord {
  deps.getSession(sessionId);
  deps.storage.chatSessionMeta.patch(sessionId, {
    lifecycleStatus: "archived",
    archivedAt: new Date().toISOString(),
  });
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_archived", updated),
  );
  return updated;
}

export function restoreChatSession(deps: ChatSessionDependencies, sessionId: string): ChatSessionRecord {
  deps.getSession(sessionId);
  deps.storage.chatSessionMeta.patch(sessionId, {
    lifecycleStatus: "active",
    archivedAt: undefined,
  });
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
): Promise<{ deleted: boolean; sessionId: string }> {
  deps.getSession(sessionId);
  const sideChildSessionIds = [deps.storage.chatSideChats.getByParentSession(sessionId)?.childSessionId].filter(
    (value): value is string => Boolean(value && value !== sessionId),
  );
  for (const childSessionId of sideChildSessionIds) {
    try {
      await deleteChatSession(deps, childSessionId);
    } catch (error) {
      log.warn("side chat child delete cleanup failed", {
        sessionId,
        childSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const result = deps.storage.deleteChatSessionData(sessionId);
  deps.clearChatTurnWriteLease(sessionId);
  deps.operatorSummaryCache.invalidate();
  const cleanupResults = await Promise.allSettled([
    deps.storage.transcripts.delete(sessionId),
    ...result.cleanupRelPaths.map((storageRelPath) => deps.removeChatSessionStoredFile(storageRelPath)),
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
    deleted: result.deleted,
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
      const archived = archiveChatSession(deps, session.sessionId);
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
): ChatSessionRecord {
  deps.getSession(sessionId);
  const meta = deps.storage.chatSessionMeta.ensure(sessionId);
  const workspaceId = deps.normalizeWorkspaceId(meta.workspaceId);
  if (!projectId) {
    deps.storage.chatSessionProjects.unassign(sessionId);
    deps.storage.chatGeneratedArtifacts.updateProjectForSession(sessionId, undefined);
    resetWorkbenchForProjectChange(deps, sessionId, undefined);
    const updated = deps.requireChatSession(sessionId);
    deps.publishRealtime(
      "chat_session_updated",
      "chat",
      buildChatSessionUpdatedPayload("chat_session_project_unassigned", updated),
    );
    return updated;
  }
  const project = deps.storage.chatProjects.get(projectId);
  if (deps.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
    throw new Error("project workspace does not match session workspace");
  }
  const currentProjectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
  deps.storage.chatSessionProjects.assign(sessionId, projectId);
  deps.storage.chatGeneratedArtifacts.updateProjectForSession(sessionId, projectId);
  if (currentProjectId !== projectId) {
    resetWorkbenchForProjectChange(deps, sessionId, projectId);
  }
  const updated = deps.requireChatSession(sessionId);
  deps.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_project_assigned", updated),
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
): ChatSessionPrefsRecord {
  deps.getSession(sessionId);
  const normalizedInput = applyChatModePresetToPatch(input);
  const { basePatch, autonomyPatch } = splitChatPrefsPatch(normalizedInput);
  if (Object.keys(autonomyPatch).length > 0) {
    deps.patchSessionAutonomyPrefs(sessionId, autonomyPatch);
  }
  const updated = deps.storage.chatSessionPrefs.patch(sessionId, basePatch);
  const normalized = deps.ensureChatSessionModelDefaults(sessionId, updated);
  const hydrated = deps.hydrateChatPrefsWithAutonomy(sessionId, normalized);
  deps.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_prefs_updated",
    sessionId,
    prefs: hydrated,
  });
  return hydrated;
}

interface SessionMessageSearchHitRow {
  session_id: string;
  message_id: string;
  turn_id: string | null;
  content: string;
  timestamp: string;
}

function buildSessionSearchHits(
  deps: ChatSessionDependencies,
  sessionIds: string[],
  query: string,
  limit = 160,
): Map<string, ChatSessionSearchHitRecord[]> {
  if (!query.trim() || sessionIds.length === 0) {
    return new Map();
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = deps.storage.gatewaySql
    .prepare(
      `
        SELECT
          m.session_id,
          m.message_id,
          COALESCE(user_turn.turn_id, assistant_turn.turn_id) AS turn_id,
          m.content,
          m.timestamp
        FROM chat_messages AS m
        LEFT JOIN chat_turn_traces AS user_turn
          ON user_turn.user_message_id = m.message_id
        LEFT JOIN chat_turn_traces AS assistant_turn
          ON assistant_turn.assistant_message_id = m.message_id
        WHERE m.session_id IN (${placeholders})
          AND LOWER(m.content) LIKE ?
        ORDER BY m.timestamp DESC
        LIMIT ?
      `,
    )
    .all(...sessionIds, `%${query.trim().toLowerCase()}%`, limit) as SessionMessageSearchHitRow[];

  const grouped = new Map<string, ChatSessionSearchHitRecord[]>();
  for (const row of rows) {
    if (!row?.session_id || !row.message_id || typeof row.content !== "string") {
      continue;
    }
    const hits = grouped.get(row.session_id) ?? [];
    hits.push({
      messageId: row.message_id,
      turnId: row.turn_id ?? undefined,
      excerpt: buildSearchExcerpt(row.content, query),
      score: scoreSearchHit(row.content, query),
      matchedText: query,
      timestamp: row.timestamp,
    });
    grouped.set(row.session_id, hits);
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
    ["mode", session.mode],
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
