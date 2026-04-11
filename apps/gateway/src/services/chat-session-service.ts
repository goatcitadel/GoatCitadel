/**
 * Chat session service.
 *
 * Owns chat session CRUD / archive / prefs / binding behavior behind a
 * narrow host contract so GatewayService can act as composition root
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
  type SessionMeta,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import {
  buildChatSessionUpdatedPayload,
  deriveChatSessionTitleFromContent,
  splitChatPrefsPatch,
  toChatSessionRecord,
} from "./chat-session-utils.js";

const log = logger.child("chat-session-service");

export interface ChatSessionHost {
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
  patchSessionAutonomyPrefs(
    sessionId: string,
    patch: ReturnType<typeof splitChatPrefsPatch>["autonomyPatch"],
  ): void;
}

export function listChatSessions(host: ChatSessionHost, query: ChatSessionListQuery = {}): ChatSessionRecord[] {
  const workspaceId = host.normalizeWorkspaceId(query.workspaceId);
  const scope = query.scope ?? "all";
  const view = query.view ?? "active";
  const includeHidden = query.includeHidden ?? false;
  const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 200)));
  const allSessions = host.storage.sessions.list(20000);
  const projects = host.storage.chatProjects.list("all", 2000, workspaceId);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const sessionIds = allSessions.map((session) => session.sessionId);
  const metaBySessionId = host.storage.chatSessionMeta.listBySessionIds(sessionIds, workspaceId);
  const projectLinkBySessionId = host.storage.chatSessionProjects.listBySessionIds(sessionIds);

  let records = allSessions.map((session) => {
    const meta = metaBySessionId.get(session.sessionId) ?? {
      workspaceId,
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active" as const,
    };
    const link = projectLinkBySessionId.get(session.sessionId);
    const project = link ? projectById.get(link.projectId) : undefined;
    return toChatSessionRecord(session, meta, project);
  });

  records = records.filter((record) => host.normalizeWorkspaceId(record.workspaceId) === workspaceId);
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
  if (query.q?.trim()) {
    const q = query.q.trim().toLowerCase();
    records = records.filter((record) => {
      const haystack = [record.title ?? "", record.sessionKey, record.channel, record.account, record.projectName ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  records.sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (byUpdated !== 0) {
      return byUpdated;
    }
    return right.sessionId.localeCompare(left.sessionId);
  });

  if (query.cursor) {
    const [cursorUpdatedAt, cursorSessionId] = query.cursor.split("|");
    if (cursorUpdatedAt && cursorSessionId) {
      records = records.filter((record) => {
        if (record.updatedAt < cursorUpdatedAt) {
          return true;
        }
        if (record.updatedAt > cursorUpdatedAt) {
          return false;
        }
        return record.sessionId < cursorSessionId;
      });
    }
  }

  return records.slice(0, limit);
}

export function createChatSession(host: ChatSessionHost, input: ChatSessionCreateInput = {}): ChatSessionRecord {
  const workspaceId = host.normalizeWorkspaceId(input.workspaceId);
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
  host.storage.sessions.upsert({
    sessionId: resolution.sessionId,
    sessionKey: resolution.sessionKey,
    kind: resolution.kind,
    channel: route.channel,
    account: route.account,
    displayName: input.title?.trim() || undefined,
    timestamp: now,
  });
  host.operatorSummaryCache.invalidate();
  host.storage.chatSessionMeta.ensure(resolution.sessionId, now, workspaceId);
  host.storage.chatSessionPrefs.ensure(resolution.sessionId, now);
  host.ensureChatSessionRuntimeGrants(resolution.sessionId);
  host.storage.chatSessionMeta.patch(
    resolution.sessionId,
    {
      workspaceId,
      title: input.title?.trim() ? input.title.trim() : undefined,
      origin: input.origin,
      includeInHistory: input.includeInHistory,
    },
    now,
  );
  host.storage.chatSessionBindings.upsert(
    {
      sessionId: resolution.sessionId,
      workspaceId,
      transport: "llm",
      writable: true,
    },
    now,
  );
  if (input.projectId) {
    const project = host.storage.chatProjects.get(input.projectId);
    if (host.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
      throw new Error("project workspace does not match requested session workspace");
    }
    host.storage.chatSessionProjects.assign(resolution.sessionId, input.projectId, now);
  }
  if (input.mode) {
    updateChatSessionPrefs(host, resolution.sessionId, buildChatModePrefsPatch(input.mode));
  }
  const created = host.requireChatSession(resolution.sessionId);
  if (!created) {
    throw new Error(`Failed to create chat session ${resolution.sessionId}`);
  }
  host.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_created",
    sessionId: created.sessionId,
    sessionKey: created.sessionKey,
  });
  return created;
}

export function updateChatSession(
  host: ChatSessionHost,
  sessionId: string,
  input: { title?: string },
): ChatSessionRecord {
  host.getSession(sessionId);
  host.storage.chatSessionMeta.patch(sessionId, {
    title: input.title,
  });
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime("chat_session_title_updated", "chat", {
    type: "chat_session_title_updated",
    sessionId: updated.sessionId,
    title: updated.title,
  });
  return updated;
}

export function maybeAutoTitleChatSession(host: ChatSessionHost, sessionId: string, content: string): void {
  const meta = host.storage.chatSessionMeta.ensure(sessionId);
  if (meta.title?.trim()) {
    return;
  }
  const derivedTitle = deriveChatSessionTitleFromContent(content);
  if (!derivedTitle) {
    return;
  }
  host.storage.chatSessionMeta.patch(sessionId, { title: derivedTitle });
  host.publishRealtime("chat_session_title_updated", "chat", {
    type: "chat_session_title_updated",
    sessionId,
    title: derivedTitle,
  });
}

export function pinChatSession(host: ChatSessionHost, sessionId: string): ChatSessionRecord {
  host.getSession(sessionId);
  host.storage.chatSessionMeta.patch(sessionId, { pinned: true });
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime("chat_session_updated", "chat", buildChatSessionUpdatedPayload("chat_session_pinned", updated));
  return updated;
}

export function unpinChatSession(host: ChatSessionHost, sessionId: string): ChatSessionRecord {
  host.getSession(sessionId);
  host.storage.chatSessionMeta.patch(sessionId, { pinned: false });
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_unpinned", updated),
  );
  return updated;
}

export function archiveChatSession(host: ChatSessionHost, sessionId: string): ChatSessionRecord {
  host.getSession(sessionId);
  host.storage.chatSessionMeta.patch(sessionId, {
    lifecycleStatus: "archived",
    archivedAt: new Date().toISOString(),
  });
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_archived", updated),
  );
  return updated;
}

export function restoreChatSession(host: ChatSessionHost, sessionId: string): ChatSessionRecord {
  host.getSession(sessionId);
  host.storage.chatSessionMeta.patch(sessionId, {
    lifecycleStatus: "active",
    archivedAt: undefined,
  });
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_restored", updated),
  );
  return updated;
}

export async function deleteChatSession(
  host: ChatSessionHost,
  sessionId: string,
): Promise<{ deleted: boolean; sessionId: string }> {
  host.getSession(sessionId);
  const result = host.storage.deleteChatSessionData(sessionId);
  host.clearChatTurnWriteLease(sessionId);
  host.operatorSummaryCache.invalidate();
  const cleanupResults = await Promise.allSettled([
    host.storage.transcripts.delete(sessionId),
    ...result.cleanupRelPaths.map((storageRelPath) => host.removeChatSessionStoredFile(storageRelPath)),
  ]);
  for (const cleanupResult of cleanupResults) {
    if (cleanupResult.status === "rejected") {
      log.warn("chat session delete cleanup failed", {
        sessionId,
        error: cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason),
      });
    }
  }
  host.publishRealtime("chat_session_deleted", "chat", {
    type: "chat_session_deleted",
    sessionId,
    mode: "hard",
  });
  return {
    deleted: result.deleted,
    sessionId,
  };
}

export async function archiveChatSessionsBulk(
  host: ChatSessionHost,
  input: ChatSessionBulkArchiveInput = {},
): Promise<ChatSessionBulkArchiveResult> {
  const workspaceId = host.normalizeWorkspaceId(input.workspaceId);
  const scope = input.scope ?? "mission";
  const candidates = listChatSessions(host, {
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
      const archived = archiveChatSession(host, session.sessionId);
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
  host: ChatSessionHost,
  sessionId: string,
  projectId?: string,
): ChatSessionRecord {
  host.getSession(sessionId);
  const meta = host.storage.chatSessionMeta.ensure(sessionId);
  const workspaceId = host.normalizeWorkspaceId(meta.workspaceId);
  if (!projectId) {
    host.storage.chatSessionProjects.unassign(sessionId);
    const updated = host.requireChatSession(sessionId);
    host.publishRealtime(
      "chat_session_updated",
      "chat",
      buildChatSessionUpdatedPayload("chat_session_project_unassigned", updated),
    );
    return updated;
  }
  const project = host.storage.chatProjects.get(projectId);
  if (host.normalizeWorkspaceId(project.workspaceId) !== workspaceId) {
    throw new Error("project workspace does not match session workspace");
  }
  host.storage.chatSessionProjects.assign(sessionId, projectId);
  const updated = host.requireChatSession(sessionId);
  host.publishRealtime(
    "chat_session_updated",
    "chat",
    buildChatSessionUpdatedPayload("chat_session_project_assigned", updated),
  );
  return updated;
}

export function getChatSessionBinding(host: ChatSessionHost, sessionId: string): ChatSessionBindingRecord | undefined {
  host.getSession(sessionId);
  return host.storage.chatSessionBindings.get(sessionId);
}

export function setChatSessionBinding(
  host: ChatSessionHost,
  input: {
    sessionId: string;
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  },
): ChatSessionBindingRecord {
  host.getSession(input.sessionId);
  const sessionMeta = host.storage.chatSessionMeta.ensure(input.sessionId);
  if (input.transport === "integration") {
    if (!input.connectionId?.trim() || !input.target?.trim()) {
      throw new Error("connectionId and target are required for integration transport");
    }
    host.storage.integrationConnections.get(input.connectionId);
  }
  const binding = host.storage.chatSessionBindings.upsert({
    sessionId: input.sessionId,
    workspaceId: host.normalizeWorkspaceId(sessionMeta.workspaceId),
    transport: input.transport,
    connectionId: input.connectionId?.trim() || undefined,
    target: input.target?.trim() || undefined,
    writable: input.writable,
  });
  host.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_binding_updated",
    sessionId: input.sessionId,
    transport: binding.transport,
  });
  return binding;
}

export function getChatSessionPrefs(host: ChatSessionHost, sessionId: string): ChatSessionPrefsRecord {
  host.getSession(sessionId);
  const prefs = host.ensureChatSessionModelDefaults(sessionId, host.storage.chatSessionPrefs.ensure(sessionId));
  return host.hydrateChatPrefsWithAutonomy(sessionId, prefs);
}

export function updateChatSessionPrefs(
  host: ChatSessionHost,
  sessionId: string,
  input: ChatSessionPrefsPatch,
): ChatSessionPrefsRecord {
  host.getSession(sessionId);
  const normalizedInput = applyChatModePresetToPatch(input);
  const { basePatch, autonomyPatch } = splitChatPrefsPatch(normalizedInput);
  if (Object.keys(autonomyPatch).length > 0) {
    host.patchSessionAutonomyPrefs(sessionId, autonomyPatch);
  }
  const updated = host.storage.chatSessionPrefs.patch(sessionId, basePatch);
  const normalized = host.ensureChatSessionModelDefaults(sessionId, updated);
  const hydrated = host.hydrateChatPrefsWithAutonomy(sessionId, normalized);
  host.publishRealtime("chat_session_updated", "chat", {
    type: "chat_session_prefs_updated",
    sessionId,
    prefs: hydrated,
  });
  return hydrated;
}
