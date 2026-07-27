/* eslint-disable max-lines -- Chat API helpers intentionally centralize chat surface transport contracts and request wiring. */
import type {
  ChatAttachmentPreviewResponse,
  ChatAttachmentRecord,
  ChatCancelTurnResponse,
  ChatDelegateAcceptRequest,
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactSourceSurface,
  ChatGoalRequest,
  ChatGoalStatusResponse,
  ChatHistoryWindowResponse,
  ChatHistoryContinuationResponse,
  ChatMessageRecord,
  ChatMessagePageResponse,
  ChatMode,
  ChatProjectRecord,
  ChatProjectImportResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSideChatRecord,
  ChatSessionBindingRecord,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchCommandRunRequest,
  ChatSessionWorkbenchCommandRunResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchFileOperationResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchPatchApplyRequest,
  ChatSessionWorkbenchPatchApplyResponse,
  ChatSessionWorkbenchPatchExportResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchRevertFileRequest,
  ChatSessionWorkbenchRevertResponse,
  ChatSessionWorkbenchSaveFileRequest,
  ChatSessionWorkbenchTreeResponse,
  ChatSessionBulkArchiveResult,
  ChatSessionOrigin,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSessionForkRequest,
  ChatSessionForkResponse,
  ChatSessionSearchMode,
  ChatSessionSearchResponse,
  ChatSessionStatusResponse,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatSteerRequest,
  ChatSteerResponse,
  CrossProjectRecentsResponse,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatTurnCapabilityProfileEnvelope,
  ChatUserInputPromptAnswerRequest,
  ChatUserInputPromptAnswerResponse,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  ProactivePolicy,
  ProactiveRunRecord,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  SurfaceClassifyRequest,
  SurfaceClassifyResponse,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
export type { ChatProjectImportResult } from "@goatcitadel/contracts";

import { createCorrelationId, recordClientDiagnostic } from "../state/dev-diagnostics-store";
import { buildGatewayHeaders, buildGatewayUrl, readGatewayAuthHeaders, request } from "./client-core.js";
import { consumeSseResponse, iterateSsePayloads, parseSseJson } from "./streaming.js";

export interface ChatRequestSurfaceOptions {
  originSurface?: ChatMode;
}

function originSurfaceHeader(options?: ChatRequestSurfaceOptions): HeadersInit | undefined {
  return options?.originSurface
    ? { "x-goatcitadel-origin-surface": normalizeChatSurface(options.originSurface) }
    : undefined;
}

function originSurfaceInit(options?: ChatRequestSurfaceOptions): Pick<RequestInit, "headers"> {
  const headers = originSurfaceHeader(options);
  return headers ? { headers } : {};
}

function normalizeChatSurface(_surface?: ChatMode | ChatGeneratedArtifactSourceSurface | null): "chat" {
  return "chat";
}

const DEFAULT_CHAT_HISTORY_MAX_BYTES = 65_536;
const MIN_CHAT_HISTORY_MAX_BYTES = 1_024;
const MAX_CHAT_HISTORY_MAX_BYTES = 1_048_576;

function clampChatHistoryMaxBytes(maxBytes?: number): number {
  const normalized =
    maxBytes !== undefined && Number.isFinite(maxBytes) ? Math.floor(maxBytes) : DEFAULT_CHAT_HISTORY_MAX_BYTES;
  return Math.max(MIN_CHAT_HISTORY_MAX_BYTES, Math.min(MAX_CHAT_HISTORY_MAX_BYTES, normalized));
}

export interface ChatProjectsResponse {
  items: ChatProjectRecord[];
  view?: "active" | "archived" | "all";
}

export interface ChatSessionsResponse {
  items: ChatSessionRecord[];
  nextCursor?: string;
}

export type { ChatSessionSearchResponse } from "@goatcitadel/contracts";

export interface ChatMessagesResponse {
  items: ChatMessageRecord[];
}

export interface ChatSideChatResponse {
  item: ChatSideChatRecord | null;
  childSession?: ChatSessionRecord;
}

export interface ChatSideChatCreateResponse {
  item: ChatSideChatRecord;
  childSession: ChatSessionRecord;
}

export interface ChatToolArtifactResponse {
  artifact: {
    artifactId: string;
    sessionId: string;
    turnId: string;
    toolRunId: string;
    toolName: string;
    contentType?: string;
    byteLength: number;
    snippet?: string;
    storageRelPath: string;
    createdAt: string;
  };
  content: string;
}

export interface ChatGeneratedArtifactsResponse {
  items: ChatGeneratedArtifactRecord[];
}

export interface ChatGeneratedArtifactResponse {
  item: ChatGeneratedArtifactRecord;
}

export interface ChatThreadKnowledgeAttachmentsResponse {
  items: ThreadKnowledgeAttachmentRecord[];
}

export async function fetchChatProjects(
  view: "active" | "archived" | "all" = "active",
  limit = 300,
  workspaceId?: string,
  citadelId?: string,
): Promise<ChatProjectsResponse> {
  const query = new URLSearchParams();
  query.set("view", view);
  query.set("limit", String(limit));
  if (citadelId?.trim()) {
    query.set("citadelId", citadelId.trim());
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<ChatProjectsResponse>(`/api/v1/chat/projects?${query.toString()}`);
}

export async function createChatProject(input: {
  citadelId?: string;
  workspaceId?: string;
  name: string;
  description?: string;
  workspacePath: string;
  color?: string;
}): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>("/api/v1/chat/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function importChatProject(input: {
  citadelId?: string;
  workspaceId?: string;
  name?: string;
  sourceType: "local_folder" | "github_repo";
  sourcePath?: string;
  repoUrl?: string;
  ref?: string;
}): Promise<ChatProjectImportResult> {
  return request<ChatProjectImportResult>("/api/v1/chat/projects/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateChatProject(
  projectId: string,
  input: {
    expectedRevision: number;
    citadelId?: string;
    workspaceId?: string;
    name?: string;
    description?: string;
    workspacePath?: string;
    color?: string;
  },
): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function restoreChatProject(projectId: string, expectedRevision: number): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function hardDeleteChatProject(
  projectId: string,
  expectedRevision: number,
): Promise<{ deleted: boolean; projectId: string; mode: "hard" }> {
  return request<{ deleted: boolean; projectId: string; mode: "hard" }>(
    `/api/v1/chat/projects/${encodeURIComponent(projectId)}?mode=hard&expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
    {
      method: "DELETE",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchChatSessions(input?: {
  scope?: "mission" | "external" | "all";
  citadelId?: string;
  workspaceId?: string;
  projectId?: string;
  folderId?: string;
  tag?: string;
  q?: string;
  view?: "active" | "archived" | "all";
  mode?: ChatMode;
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
}): Promise<ChatSessionsResponse> {
  const query = new URLSearchParams();
  if (input?.scope) query.set("scope", input.scope);
  if (input?.citadelId) query.set("citadelId", input.citadelId);
  if (input?.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input?.projectId) query.set("projectId", input.projectId);
  if (input?.folderId) query.set("folderId", input.folderId);
  if (input?.tag) query.set("tag", input.tag);
  if (input?.q) query.set("q", input.q);
  if (input?.view) query.set("view", input.view);
  if (input?.mode) query.set("mode", input.mode);
  if (input?.includeHidden !== undefined) query.set("includeHidden", String(input.includeHidden));
  query.set("limit", String(input?.limit ?? 200));
  if (input?.cursor) query.set("cursor", input.cursor);
  return request<ChatSessionsResponse>(`/api/v1/chat/sessions?${query.toString()}`);
}

export async function fetchChatSessionSearch(input: {
  query: string;
  mode?: ChatSessionSearchMode;
  view?: "active" | "archived" | "all";
  citadelId?: string;
  workspaceId?: string;
  surface?: ChatMode;
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
}): Promise<ChatSessionSearchResponse> {
  const query = new URLSearchParams();
  query.set("query", input.query);
  if (input.mode) query.set("mode", input.mode);
  if (input.view) query.set("view", input.view);
  if (input.citadelId) query.set("citadelId", input.citadelId);
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input.surface) query.set("surface", input.surface);
  if (input.includeHidden !== undefined) query.set("includeHidden", String(input.includeHidden));
  query.set("limit", String(input.limit ?? 20));
  if (input.cursor) query.set("cursor", input.cursor);
  return request<ChatSessionSearchResponse>(`/api/v1/chat/session-search?${query.toString()}`);
}

export async function createChatSession(
  input?: {
    citadelId?: string;
    workspaceId?: string;
    title?: string;
    folderId?: string;
    folderName?: string;
    tags?: string[];
    projectId?: string;
    mode?: ChatMode;
    origin?: ChatSessionOrigin;
    includeInHistory?: boolean;
  },
  options?: ChatRequestSurfaceOptions,
): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>("/api/v1/chat/sessions", {
    method: "POST",
    ...originSurfaceInit(options),
    body: JSON.stringify(input ?? {}),
  });
}

export async function forkChatSessionFromTurn(
  sessionId: string,
  turnId: string,
  input: ChatSessionForkRequest = {},
): Promise<ChatSessionForkResponse> {
  return request<ChatSessionForkResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/fork`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function archiveWorkspaceChatSessions(input?: {
  workspaceId?: string;
  scope?: "mission" | "external" | "all";
  includeHidden?: boolean;
}): Promise<ChatSessionBulkArchiveResult> {
  return request<ChatSessionBulkArchiveResult>("/api/v1/chat/sessions/archive-bulk", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function updateChatSession(
  sessionId: string,
  input: { expectedRevision: number; title?: string; folderId?: string; folderName?: string; tags?: string[] },
): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchChatSessionStatus(sessionId: string): Promise<ChatSessionStatusResponse> {
  return request<ChatSessionStatusResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/status`, {
    cache: "no-store",
  });
}

export async function deleteChatSession(
  sessionId: string,
  expectedRevision: number,
): Promise<{ deleted: boolean; sessionId: string }> {
  return request<{ deleted: boolean; sessionId: string }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}?mode=hard&expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
    { method: "DELETE" },
  );
}

export async function pinChatSession(sessionId: string, expectedRevision: number): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/pin`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function unpinChatSession(sessionId: string, expectedRevision: number): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/unpin`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function archiveChatSession(sessionId: string, expectedRevision: number): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function restoreChatSession(sessionId: string, expectedRevision: number): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function assignChatSessionProject(
  sessionId: string,
  projectId: string | undefined,
  expectedRevision: number,
): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/project`, {
    method: "POST",
    body: JSON.stringify({ projectId, expectedRevision }),
  });
}

export async function fetchChatSideChat(sessionId: string): Promise<ChatSideChatResponse> {
  return request<ChatSideChatResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/side-chats`);
}

export async function createChatSideChat(
  sessionId: string,
  input?: {
    createdFromSurface?: ChatMode;
    sourceTurnId?: string;
  },
  options?: ChatRequestSurfaceOptions,
): Promise<ChatSideChatCreateResponse> {
  return request<ChatSideChatCreateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/side-chats`, {
    method: "POST",
    ...originSurfaceInit(options),
    body: JSON.stringify(input ?? {}),
  });
}

export async function setChatSessionBinding(
  sessionId: string,
  input: {
    transport: "llm" | "integration";
    connectionId?: string;
    target?: string;
    writable?: boolean;
  },
): Promise<ChatSessionBindingRecord> {
  return request<ChatSessionBindingRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/binding`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatSessionBinding(sessionId: string): Promise<{ item: ChatSessionBindingRecord | null }> {
  return request<{ item: ChatSessionBindingRecord | null }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/binding`,
  );
}

export async function fetchChatSessionWorkbench(sessionId: string): Promise<{ state: ChatSessionWorkbenchRecord }> {
  return request<{ state: ChatSessionWorkbenchRecord }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench`,
  );
}

export async function createChatSessionWorkbenchWorktree(
  sessionId: string,
  input?: { baseRef?: string },
): Promise<{ state: ChatSessionWorkbenchRecord }> {
  return request<{ state: ChatSessionWorkbenchRecord }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/worktree`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchChatSessionWorkbenchTree(sessionId: string): Promise<ChatSessionWorkbenchTreeResponse> {
  return request<ChatSessionWorkbenchTreeResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/tree`,
  );
}

export async function fetchChatSessionWorkbenchFile(
  sessionId: string,
  relativePath: string,
): Promise<ChatSessionWorkbenchFileResponse> {
  const query = new URLSearchParams({ path: relativePath });
  return request<ChatSessionWorkbenchFileResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file?${query.toString()}`,
  );
}

export async function saveChatSessionWorkbenchFile(
  sessionId: string,
  input: ChatSessionWorkbenchSaveFileRequest,
): Promise<ChatSessionWorkbenchFileResponse> {
  return request<ChatSessionWorkbenchFileResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function runChatSessionWorkbenchFileOperation(
  sessionId: string,
  input: ChatSessionWorkbenchFileOperationRequest,
): Promise<ChatSessionWorkbenchFileOperationResponse> {
  return request<ChatSessionWorkbenchFileOperationResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file-operation`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchChatSessionWorkbenchFileDiff(
  sessionId: string,
  relativePath: string,
): Promise<ChatSessionWorkbenchFileDiffResponse> {
  const query = new URLSearchParams({ path: relativePath });
  return request<ChatSessionWorkbenchFileDiffResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file-diff?${query.toString()}`,
  );
}

export async function fetchChatSessionWorkbenchDiff(sessionId: string): Promise<ChatSessionWorkbenchDiffResponse> {
  return request<ChatSessionWorkbenchDiffResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/diff`,
  );
}

export async function fetchChatSessionWorkbenchOutput(sessionId: string): Promise<ChatSessionWorkbenchOutputResponse> {
  return request<ChatSessionWorkbenchOutputResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/output`,
  );
}

export async function runChatSessionWorkbenchCommand(
  sessionId: string,
  input: ChatSessionWorkbenchCommandRunRequest,
): Promise<ChatSessionWorkbenchCommandRunResponse> {
  return request<ChatSessionWorkbenchCommandRunResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/command`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function applyChatSessionWorkbenchPatch(
  sessionId: string,
  input: ChatSessionWorkbenchPatchApplyRequest,
): Promise<ChatSessionWorkbenchPatchApplyResponse> {
  return request<ChatSessionWorkbenchPatchApplyResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/patch/apply`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function exportChatSessionWorkbenchPatch(
  sessionId: string,
): Promise<ChatSessionWorkbenchPatchExportResponse> {
  return request<ChatSessionWorkbenchPatchExportResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/patch/export`,
  );
}

export async function revertChatSessionWorkbenchFile(
  sessionId: string,
  input: ChatSessionWorkbenchRevertFileRequest,
): Promise<ChatSessionWorkbenchRevertResponse> {
  return request<ChatSessionWorkbenchRevertResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/revert-file`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function revertChatSessionWorkbenchChanges(
  sessionId: string,
): Promise<ChatSessionWorkbenchRevertResponse> {
  return request<ChatSessionWorkbenchRevertResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/revert-all`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchChatMessages(
  sessionId: string,
  limit = 200,
  cursor?: string,
): Promise<ChatMessagesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.max(1, Math.min(limit, 1000))));
  if (cursor) {
    query.set("cursor", cursor);
  }
  return request<ChatMessagesResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
  );
}

export async function fetchChatHistoryWindow(input: {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  sequence: number;
  limit?: number;
  maxBytes?: number;
}): Promise<ChatHistoryWindowResponse> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    sequence: String(input.sequence),
    limit: String(input.limit ?? 21),
    maxBytes: String(clampChatHistoryMaxBytes(input.maxBytes)),
  });
  return request<ChatHistoryWindowResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}

export async function fetchChatHistoryContinuation(input: {
  workspaceId: string;
  sessionId: string;
  direction: "older" | "newer";
  cursor: { messageId: string; sequence: number; snapshotMaxSequence: number };
  limit?: number;
  maxBytes?: number;
}): Promise<ChatHistoryContinuationResponse> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    direction: input.direction,
    cursor: input.cursor.messageId,
    cursorSequence: String(input.cursor.sequence),
    snapshotMaxSequence: String(input.cursor.snapshotMaxSequence),
    limit: String(input.limit ?? 21),
    maxBytes: String(clampChatHistoryMaxBytes(input.maxBytes)),
  });
  return request<ChatHistoryContinuationResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}

export async function fetchChatMessagePage(input: {
  workspaceId: string;
  sessionId: string;
  limit?: number;
  cursor?: string;
  offset?: number;
  snapshotMaxSequence?: number;
  snapshotMessageCount?: number;
}): Promise<ChatMessagePageResponse> {
  if (input.cursor !== undefined && input.offset !== undefined) {
    throw new Error("cursor and offset cannot be used together");
  }
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    limit: String(input.limit ?? 200),
  });
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.offset !== undefined) query.set("offset", String(input.offset));
  if (input.snapshotMaxSequence !== undefined) {
    query.set("snapshotMaxSequence", String(input.snapshotMaxSequence));
  }
  if (input.snapshotMessageCount !== undefined) {
    query.set("snapshotMessageCount", String(input.snapshotMessageCount));
  }
  return request<ChatMessagePageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}

export async function fetchChatGeneratedArtifacts(input?: {
  citadelId?: string;
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  sourceSurface?: ChatGeneratedArtifactSourceSurface;
  kind?: ChatGeneratedArtifactKind;
  limit?: number;
}): Promise<ChatGeneratedArtifactsResponse> {
  const query = new URLSearchParams();
  if (input?.citadelId) query.set("citadelId", input.citadelId);
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  if (input?.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input?.projectId) query.set("projectId", input.projectId);
  if (input?.sourceSurface) query.set("sourceSurface", normalizeChatSurface(input.sourceSurface));
  if (input?.kind) query.set("kind", input.kind);
  query.set("limit", String(input?.limit ?? 300));
  return request<ChatGeneratedArtifactsResponse>(`/api/v1/chat/generated-artifacts?${query.toString()}`);
}

export async function fetchChatGeneratedArtifact(
  artifactId: string,
  workspaceId: string,
  citadelId?: string,
): Promise<ChatGeneratedArtifactResponse> {
  const query = new URLSearchParams({ workspaceId });
  if (citadelId?.trim()) {
    query.set("citadelId", citadelId.trim());
  }
  return request<ChatGeneratedArtifactResponse>(
    `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
  );
}

export async function fetchChatSessionGeneratedArtifacts(
  sessionId: string,
  input?: {
    kind?: ChatGeneratedArtifactKind;
    sourceSurface?: ChatGeneratedArtifactSourceSurface;
    limit?: number;
  },
): Promise<ChatGeneratedArtifactsResponse> {
  const query = new URLSearchParams();
  if (input?.kind) query.set("kind", input.kind);
  if (input?.sourceSurface) query.set("sourceSurface", normalizeChatSurface(input.sourceSurface));
  query.set("limit", String(input?.limit ?? 300));
  return request<ChatGeneratedArtifactsResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/generated-artifacts?${query.toString()}`,
  );
}

export async function createChatGeneratedArtifact(
  sessionId: string,
  turnId: string,
  input?: {
    supersedeLatest?: boolean;
  },
): Promise<ChatGeneratedArtifactResponse> {
  return request<ChatGeneratedArtifactResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/generated-artifact`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchThreadKnowledgeAttachments(
  sessionId: string,
): Promise<ChatThreadKnowledgeAttachmentsResponse> {
  return request<ChatThreadKnowledgeAttachmentsResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/knowledge-attachments`,
  );
}

export async function attachThreadKnowledgeAttachment(
  sessionId: string,
  input: {
    chatAttachmentId?: string;
    url?: string;
    title?: string;
    retrievalMode: ThreadKnowledgeRetrievalMode;
  },
): Promise<{ item: ThreadKnowledgeAttachmentRecord }> {
  return request<{ item: ThreadKnowledgeAttachmentRecord }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/knowledge-attachments`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function removeThreadKnowledgeAttachment(
  sessionId: string,
  attachmentId: string,
): Promise<{ deleted: boolean; attachmentId: string }> {
  return request<{ deleted: boolean; attachmentId: string }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/knowledge-attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function fetchChatThread(sessionId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
}

export async function answerChatUserInputPrompt(
  sessionId: string,
  turnId: string,
  promptId: string,
  input: ChatUserInputPromptAnswerRequest,
): Promise<ChatUserInputPromptAnswerResponse> {
  return request<ChatUserInputPromptAnswerResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/user-input/${encodeURIComponent(promptId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchChatPendingApprovals(sessionId: string): Promise<{
  items: Array<{
    approvalId: string;
    sessionId?: string;
    kind?: string;
    toolName?: string;
    reason?: string;
    riskLevel?: "safe" | "caution" | "danger" | "nuclear";
    expiresAt?: string;
    createdAt: string;
    stale: boolean;
    staleReason?: string;
    details?: Record<string, unknown>;
  }>;
  activeApprovalId: string | null;
  remainingCount: number;
}> {
  return request(`/api/v1/chat/tools/approvals?sessionId=${encodeURIComponent(sessionId)}`);
}

export async function sendAgentChatMessage(
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: ChatRequestSurfaceOptions,
): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`, {
    method: "POST",
    ...originSurfaceInit(options),
    body: JSON.stringify(input),
  });
}

export async function preflightChatRoute(
  sessionId: string,
  input: RoutingPreflightRequest,
  options?: ChatRequestSurfaceOptions,
): Promise<RoutingPreflightResult> {
  return request<RoutingPreflightResult>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`, {
    method: "POST",
    ...originSurfaceInit(options),
    body: JSON.stringify(input),
  });
}

export async function fetchChatTurnCapabilityProfile(
  sessionId: string,
  turnId: string,
  workspaceId?: string,
): Promise<ChatTurnCapabilityProfileEnvelope> {
  const query = new URLSearchParams();
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request<ChatTurnCapabilityProfileEnvelope>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/capability-profile${suffix}`,
  );
}

export async function classifySurfaceMode(input: SurfaceClassifyRequest): Promise<SurfaceClassifyResponse> {
  return request<SurfaceClassifyResponse>("/api/v1/surface/classify", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function streamAgentChatMessage(
  sessionId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`;
  const correlationId = createCorrelationId();
  recordClientDiagnostic({
    level: "info",
    category: "chat",
    event: "stream.start",
    message: "Agent chat stream started",
    correlationId,
    sessionId,
    route: path,
  });
  // Every `stream.start` must have a matching terminal event so the diagnostics
  // timeline never shows an orphaned start. A user cancel / transport drop throws
  // an AbortError, and a non-ok response throws after emitting its own
  // `stream.error`; the try/catch below records the terminal event for the paths
  // that would otherwise escape (consume-time abort, transport failure) without
  // double-recording the non-ok case.
  let terminalRecorded = false;
  try {
    const response = await fetch(buildGatewayUrl(path), {
      method: "POST",
      signal: options.signal,
      headers: buildGatewayHeaders(path, "POST", correlationId, {
        "x-goatcitadel-session-id": sessionId,
        ...originSurfaceHeader(options),
      }),
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      recordClientDiagnostic({
        level: "error",
        category: "chat",
        event: "stream.error",
        message: `Agent chat stream failed (${response.status})`,
        correlationId,
        sessionId,
        route: path,
        context: { status: response.status, body: text.slice(0, 600) },
      });
      terminalRecorded = true;
      throw new Error(`API error ${response.status}: ${text}`);
    }
    await consumeSseResponse(
      response.body,
      (chunk) => {
        if (chunk.type === "error") {
          recordClientDiagnostic({
            level: "error",
            category: "chat",
            event: "stream.chunk_error",
            message: "Agent chat stream emitted an error chunk",
            correlationId,
            sessionId,
            route: path,
            turnId: chunk.turnId,
          });
        }
        onChunk(chunk);
      },
      options.signal,
    );
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "stream.complete",
      message: "Agent chat stream completed",
      correlationId,
      sessionId,
      route: path,
    });
  } catch (error) {
    if (!terminalRecorded) {
      recordStreamTerminalFailure({ error, correlationId, sessionId, route: path });
    }
    throw error;
  }
}

/**
 * Records the terminal diagnostic for a chat stream that ended without a
 * `stream.complete` — `stream.aborted` for a user cancel / transport drop
 * (AbortError) and `stream.error` for any other failure. Pairs every
 * `stream.start` with a terminal event in the diagnostics timeline.
 */
function recordStreamTerminalFailure(input: {
  error: unknown;
  correlationId: string;
  sessionId: string;
  route: string;
}): void {
  const { error, correlationId, sessionId, route } = input;
  if (isStreamAbortError(error)) {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "stream.aborted",
      message: "Agent chat stream aborted before completion",
      correlationId,
      sessionId,
      route,
    });
    return;
  }
  recordClientDiagnostic({
    level: "error",
    category: "chat",
    event: "stream.error",
    message: error instanceof Error ? `Agent chat stream errored: ${error.message}` : "Agent chat stream errored",
    correlationId,
    sessionId,
    route,
  });
}

function isStreamAbortError(error: unknown): boolean {
  if (typeof DOMException === "function" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return (
    typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError"
  );
}

export async function selectChatBranchTurn(sessionId: string, turnId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/select`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function retryChatTurn(
  sessionId: string,
  turnId: string,
  input?: Partial<ChatSendMessageRequest>,
  options?: ChatRequestSurfaceOptions,
): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retry`,
    {
      method: "POST",
      ...originSurfaceInit(options),
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function streamRetryChatTurn(
  sessionId: string,
  turnId: string,
  input: Partial<ChatSendMessageRequest>,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retry/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader(options),
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function editChatTurn(
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  options?: ChatRequestSurfaceOptions,
): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/edit`,
    {
      method: "POST",
      ...originSurfaceInit(options),
      body: JSON.stringify(input),
    },
  );
}

export async function streamEditChatTurn(
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/edit/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader(options),
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function resumeChatTurnStream(
  sessionId: string,
  turnId: string,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; sinceEventId?: string; originSurface?: ChatMode } = {},
): Promise<void> {
  const query = new URLSearchParams();
  if (options.sinceEventId) {
    query.set("sinceEventId", options.sinceEventId);
  }
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stream${query.size > 0 ? `?${query.toString()}` : ""}`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "GET",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "GET", correlationId, {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "x-goatcitadel-session-id": sessionId,
      ...(options.sinceEventId ? { "Last-Event-ID": options.sinceEventId } : {}),
      ...originSurfaceHeader(options),
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function cancelChatTurn(
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): Promise<ChatCancelTurnResponse> {
  return request<ChatCancelTurnResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify(cancelledBy ? { cancelledBy } : {}),
    },
  );
}

export async function approveChatTool(
  sessionId: string,
  approvalId: string,
  options?: { allowScope?: "once" | "session" | "workspace" },
): Promise<{
  ok: boolean;
  approvalId: string;
  allowScope?: "once" | "session" | "workspace";
  resumed?: boolean;
  resumedTurnId?: string;
  resumedRunId?: string;
}> {
  return request<{
    ok: boolean;
    approvalId: string;
    allowScope?: "once" | "session" | "workspace";
    resumed?: boolean;
    resumedTurnId?: string;
    resumedRunId?: string;
  }>("/api/v1/chat/tools/approve", {
    method: "POST",
    body: JSON.stringify({ sessionId, approvalId, ...(options?.allowScope ? { allowScope: options.allowScope } : {}) }),
  });
}

export async function denyChatTool(
  sessionId: string,
  approvalId: string,
): Promise<{ ok: boolean; approvalId: string }> {
  return request<{ ok: boolean; approvalId: string }>("/api/v1/chat/tools/deny", {
    method: "POST",
    body: JSON.stringify({ sessionId, approvalId }),
  });
}

export async function fetchChatToolArtifact(
  artifactId: string,
  workspaceId: string,
): Promise<ChatToolArtifactResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<ChatToolArtifactResponse>(
    `/api/v1/chat/tools/artifacts/${encodeURIComponent(artifactId)}?${query.toString()}`,
  );
}

export async function uploadChatAttachment(input: {
  sessionId: string;
  projectId?: string;
  file: File;
}): Promise<ChatAttachmentRecord> {
  const bytesBase64 = await encodeFileBase64(input.file);
  return request<ChatAttachmentRecord>("/api/v1/chat/attachments", {
    method: "POST",
    body: JSON.stringify({
      sessionId: input.sessionId,
      projectId: input.projectId,
      fileName: input.file.name,
      mimeType: input.file.type || "application/octet-stream",
      bytesBase64,
    }),
  });
}

export async function fetchChatAttachment(attachmentId: string): Promise<ChatAttachmentRecord> {
  return request<ChatAttachmentRecord>(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}`);
}

export async function downloadChatAttachment(
  attachmentId: string,
): Promise<{ blob: Blob; fileName: string; mimeType: string }> {
  const meta = await fetchChatAttachment(attachmentId);
  const authHeaders = readGatewayAuthHeaders(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content`);
  const response = await fetch(
    buildGatewayUrl(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content?disposition=attachment`),
    {
      headers: authHeaders,
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  const blob = await response.blob();
  return {
    blob,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
  };
}

export async function fetchChatAttachmentPreview(attachmentId: string): Promise<ChatAttachmentPreviewResponse> {
  return request<ChatAttachmentPreviewResponse>(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/preview`);
}

export async function fetchChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord> {
  return request<ChatSessionPrefsRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`);
}

export async function updateChatSessionPrefs(
  sessionId: string,
  input: ChatSessionPrefsPatch & { expectedRevision: number },
): Promise<ChatSessionPrefsRecord> {
  return request<ChatSessionPrefsRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface ChatProactiveStatusResponse {
  policy: ProactivePolicy;
  idleSeconds: number;
  hasRunningTurn: boolean;
  pendingSuggestions: number;
  actionsLastHour: number;
  lastRun?: ProactiveRunRecord;
}

export async function fetchChatProactiveStatus(sessionId: string): Promise<ChatProactiveStatusResponse> {
  return request<ChatProactiveStatusResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/status`,
  );
}

export async function updateChatProactivePolicy(
  sessionId: string,
  input: Partial<{
    proactiveMode: ProactivePolicy["mode"];
    autonomyBudget: Partial<ProactivePolicy["autonomyBudget"]>;
    retrievalMode: ProactivePolicy["retrievalMode"];
    reflectionMode: ProactivePolicy["reflectionMode"];
  }> & { expectedRevision: number },
): Promise<ProactivePolicy> {
  return request<ProactivePolicy>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/policy`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function triggerChatProactive(
  sessionId: string,
  input?: {
    source?: "scheduler" | "manual" | "chat";
    reason?: string;
    surface?: ChatMode;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  },
): Promise<ProactiveRunRecord> {
  return request<ProactiveRunRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/trigger`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchChatProactiveRuns(sessionId: string, limit = 50): Promise<{ items: ProactiveRunRecord[] }> {
  return request<{ items: ProactiveRunRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/runs?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchChatLearnedMemory(
  sessionId: string,
  limit = 200,
): Promise<{
  items: LearnedMemoryItemRecord[];
  conflicts: LearnedMemoryConflictRecord[];
}> {
  return request<{
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory?limit=${Math.max(1, Math.min(limit, 1000))}`,
  );
}

export async function updateChatLearnedMemoryItem(
  sessionId: string,
  itemId: string,
  input: LearnedMemoryUpdateInput,
): Promise<LearnedMemoryItemRecord> {
  return request<LearnedMemoryItemRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function rebuildChatLearnedMemory(sessionId: string): Promise<{
  rebuiltAt: string;
  items: LearnedMemoryItemRecord[];
  conflicts: LearnedMemoryConflictRecord[];
}> {
  return request<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/rebuild`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchChatSpecialistCandidates(
  sessionId: string,
  limit = 200,
): Promise<{ items: ChatSpecialistCandidateRecord[] }> {
  return request<{ items: ChatSpecialistCandidateRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function createChatSpecialistCandidate(
  sessionId: string,
  input: {
    turnId?: string;
    suggestion: ChatSpecialistCandidateSuggestionRecord;
  },
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updateChatSpecialistCandidate(
  sessionId: string,
  candidateId: string,
  input: ChatSpecialistCandidatePatchInput,
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates/${encodeURIComponent(candidateId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function suggestChatDelegation(
  sessionId: string,
  input: ChatDelegateSuggestRequest = {},
): Promise<ChatDelegateSuggestResponse> {
  return request<ChatDelegateSuggestResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/suggest`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function acceptChatDelegation(
  sessionId: string,
  input: ChatDelegateAcceptRequest,
): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/accept`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatCommandCatalog(): Promise<{
  items: Array<{ command: string; usage: string; description: string }>;
}> {
  return request<{ items: Array<{ command: string; usage: string; description: string }> }>(
    "/api/v1/chat/catalog/commands",
  );
}

export async function parseChatCommand(
  sessionId: string,
  commandText: string,
  options: {
    policyRunId?: string;
    policyTaskId?: string;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    surface?: ChatMode;
  } = {},
): Promise<{
  ok: boolean;
  command: string;
  args: string[];
  message: string;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
}> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`, {
    method: "POST",
    body: JSON.stringify({ commandText, ...options }),
  });
}

export async function runChatResearch(
  sessionId: string,
  input: {
    query: string;
    mode?: "quick" | "deep";
    providerId?: string;
    model?: string;
    policyRunId?: string;
    policyTaskId?: string;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    surface?: ChatMode;
  },
): Promise<ResearchSummaryRecord> {
  return request<ResearchSummaryRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/research/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatResearchRun(
  sessionId: string,
  runId: string,
): Promise<{
  run: ResearchRunRecord;
  sources: ResearchSourceRecord[];
}> {
  return request<{ run: ResearchRunRecord; sources: ResearchSourceRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/research/${encodeURIComponent(runId)}`,
  );
}

export async function runChatDelegation(sessionId: string, input: ChatDelegateRequest): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate`, {
    method: "POST",
    ...originSurfaceInit({ originSurface: input.surfaceMode }),
    body: JSON.stringify(input),
  });
}

export interface ChatDelegationStreamChunk {
  type: "status" | "step" | "done" | "error";
  runId?: string;
  taskId?: string;
  message?: string;
  step?: {
    stepId: string;
    runId: string;
    role: string;
    label?: string;
    status: string;
    index: number;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    summary?: string;
    output?: string;
    error?: string;
    failureGuidance?: string;
  };
  result?: ChatDelegateResponse;
  error?: string;
}

export async function streamChatDelegation(
  sessionId: string,
  input: ChatDelegateRequest,
  onChunk: (chunk: ChatDelegationStreamChunk) => void,
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader({ originSurface: input.surfaceMode }),
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  let streamError: string | null = null;
  for await (const dataText of iterateSsePayloads(response.body)) {
    const chunk = parseSseJson<ChatDelegationStreamChunk>(dataText);
    onChunk(chunk);
    if (chunk.type === "error") {
      streamError = chunk.error || "Streaming request failed.";
    }
  }
  if (streamError) {
    throw new Error(streamError);
  }
}

export async function fetchChatDelegationRun(
  sessionId: string,
  runId: string,
): Promise<{
  run: ChatDelegationRunRecord;
  steps: ChatDelegationStepRecord[];
}> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(runId)}`);
}

export async function steerChatSession(sessionId: string, input: ChatSteerRequest): Promise<ChatSteerResponse> {
  return request<ChatSteerResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatSessionGoal(sessionId: string): Promise<ChatGoalStatusResponse> {
  return request<ChatGoalStatusResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/goal`);
}

export async function setChatSessionGoal(
  sessionId: string,
  input: ChatGoalRequest & { expectedRevision: number },
): Promise<ChatGoalStatusResponse> {
  return request<ChatGoalStatusResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/goal`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function clearChatSessionGoal(
  sessionId: string,
  expectedRevision: number,
): Promise<ChatGoalStatusResponse> {
  return request<ChatGoalStatusResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/goal?expectedRevision=${encodeURIComponent(String(expectedRevision))}`,
    { method: "DELETE" },
  );
}

export async function fetchCrossProjectRecentSessions(
  workspaceId: string,
  limit = 8,
): Promise<CrossProjectRecentsResponse> {
  const query = new URLSearchParams({
    workspaceId,
    limit: String(Math.max(1, Math.min(20, limit))),
  });
  return request<CrossProjectRecentsResponse>(`/api/v1/chat/sessions/recents?${query.toString()}`);
}

async function encodeFileBase64(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment."));
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Failed to encode attachment."));
          return;
        }
        const comma = reader.result.indexOf(",");
        resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
