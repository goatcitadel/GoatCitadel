/* eslint-disable max-lines -- Chat API helpers intentionally centralize chat surface transport contracts and request wiring. */
import type {
  ChatAttachmentPreviewResponse,
  ChatArtifactCritiqueResponse,
  ChatArtifactRenderResponse,
  ChatAttachmentRecord,
  ChatCancelTurnResponse,
  ChatChangePlanRecord,
  ChatChangePlanRequest,
  ChangePlanCreateInput,
  ChangePlanRecord,
  ChangePlanRequest,
  ChangePlanResponseInput,
  ChangePlanStatus,
  ChatDelegateAcceptRequest,
  ChatDelegateResponse,
  ChatDelegatedScopeCandidatesResponse,
  ChatDelegatedScopeExpansionRequest,
  ChatDelegatedScopeExpansionResponse,
  ChatDelegationRunDetail,
  ChatFanoutInvocationStatus,
  ChatLatestWorkspaceExplorerResponse,
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactSourceSurface,
  ChatSessionCoreStateResponse,
  ChatGoalRequest,
  ChatGoalStatusResponse,
  ChatMessageRecord,
  ChatMessagingOverview,
  ChatMode,
  ChatProjectRecord,
  ChatProjectImportResult,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSideChatRecord,
  ChatSessionBindingRecord,
  ChatSessionBulkArchiveResult,
  ChatSessionOrigin,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionReadResponse,
  ChatSessionRecord,
  ChatSessionForkRequest,
  ChatSessionForkResponse,
  ChatSessionSearchMode,
  ChatSessionSearchResponse,
  ChatSessionStatusResponse,
  ChatTimerListResponse,
  ChatTimerMutationResponse,
  CreateChatTimerInput,
  ChatSteerRequest,
  ChatSteerResponse,
  CrossProjectRecentsResponse,
  RoutingPreflightRequest,
  RoutingPreflightResult,
  ChatThreadResponse,
  ChatTurnCapabilityProfileEnvelope,
  ChatRoutedContextInspectionEnvelope,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  ProactivePolicy,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
export type { ChatChangePlanRecord, ChatProjectImportResult } from "@goatcitadel/contracts";
export type { ChangePlanRecord } from "@goatcitadel/contracts";

import {
  buildGatewayUrl,
  readGatewayAuthHeaders,
  request,
} from "./client-core.js";
import { normalizeChatSurface, originSurfaceInit, type ChatRequestSurfaceOptions } from "./chat-request-surface.js";
import { uploadHashHeaders } from "./upload-hash.js";
import type { OpenAICodexDevicePollResponse, OpenAICodexDeviceStartResponse } from "./platform.js";
export {
  fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchTree,
  fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchFileDiff,
  fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchOutput,
  createChatSessionWorkbenchWorktree,
  saveChatSessionWorkbenchFile,
  previewChatSessionWorkbenchFileOperation,
  runChatSessionWorkbenchFileOperation,
  runChatSessionWorkbenchCommand,
  applyChatSessionWorkbenchPatch,
  exportChatSessionWorkbenchPatch,
  revertChatSessionWorkbenchFile,
  revertChatSessionWorkbenchChanges,
} from "./chat-workbench-operations.js";

export {
  runChatDelegation,
  runChatResearch,
  streamChatDelegation,
  suggestChatDelegation,
  triggerChatProactive,
} from "./chat-optional-actions.js";
export type { ChatDelegationStreamChunk, ChatDelegationStreamScopeControl } from "./chat-optional-actions.js";

export {
  fetchChatGeneratedArtifacts,
  fetchThreadKnowledgeAttachments,
  fetchChatProactiveStatus,
  fetchChatProactiveRuns,
  fetchChatSpecialistCandidates,
  fetchChatCommandCatalog,
} from "./chat-session-evidence.js";
export type { ChatProactiveStatusResponse } from "./chat-session-evidence.js";

export {
  createChatGeneratedArtifactVersion,
  listDocumentPatchProposals,
  fetchDocumentPatchProposal,
  createDocumentPatchProposal,
  applyDocumentPatchProposal,
  rejectDocumentPatchProposal,
} from "./chat-document-operations.js";
export type { DocumentPatchProposalResponse } from "./chat-document-operations.js";
export {
  answerChatUserInputPrompt,
  submitChatSecureConfiguration,
  approveChatTool,
  denyChatTool,
  selectChatBranchTurn,
  createChatSpecialistCandidate,
  updateChatSpecialistCandidate,
} from "./chat-operator-actions.js";
export type { ChatApprovalWriteGrantChoice, ApproveChatToolResult } from "./chat-operator-actions.js";
export {
  updateChatSession,
  deleteChatSession,
  pinChatSession,
  unpinChatSession,
  archiveChatSession,
  restoreChatSession,
  assignChatSessionProject,
} from "./chat-session-mutations.js";

export { fetchChatHistoryWindow, fetchChatHistoryContinuation, fetchChatMessagePage } from "./chat-history-reads.js";

export type { ChatRequestSurfaceOptions } from "./chat-request-surface.js";
export {
  resumeChatTurnStream,
  streamAgentChatMessage,
  streamEditChatTurn,
  streamRetryChatTurn,
} from "./chat-live-stream.js";

export interface ChatProjectsResponse {
  items: ChatProjectRecord[];
  view?: "active" | "archived" | "all";
}

export interface ChatSessionsResponse {
  membership?: import("@goatcitadel/contracts").ChatSessionListMembership;
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

export type {
  ChatArtifactCritiqueResponse,
  ChatArtifactRenderRecord,
  ChatArtifactRenderResponse,
} from "@goatcitadel/contracts";

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
  options: { signal?: AbortSignal } = {},
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
  return request<ChatProjectsResponse>(
    `/api/v1/chat/projects?${query.toString()}`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
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

export async function fetchChatSessions(
  input?: {
    sessionIds?: string[];
    sessionId?: string;
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
    /** Ask for each session's turn activity, so a list can show status without one read per row. */
    includeActivity?: boolean;
  },
  options: { signal?: AbortSignal } = {},
): Promise<ChatSessionsResponse> {
  const query = new URLSearchParams();
  if (input?.sessionIds !== undefined) query.set("sessionIds", JSON.stringify(input.sessionIds));
  if (input?.sessionId !== undefined) query.set("sessionId", input.sessionId);
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
  if (input?.includeActivity) query.set("includeActivity", "true");
  query.set("limit", String(input?.limit ?? 200));
  if (input?.cursor) query.set("cursor", input.cursor);
  return request<ChatSessionsResponse>(
    `/api/v1/chat/sessions?${query.toString()}`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

export async function fetchChatSessionSearch(
  input: {
    query: string;
    mode?: ChatSessionSearchMode;
    view?: "active" | "archived" | "all";
    citadelId?: string;
    workspaceId?: string;
    surface?: ChatMode;
    limit?: number;
    cursor?: string;
    includeHidden?: boolean;
    /** Ask for each result's turn activity, so a list can show status without one read per row. */
    includeActivity?: boolean;
  },
  options: { signal?: AbortSignal } = {},
): Promise<ChatSessionSearchResponse> {
  const query = new URLSearchParams();
  query.set("query", input.query);
  if (input.mode) query.set("mode", input.mode);
  if (input.view) query.set("view", input.view);
  if (input.citadelId) query.set("citadelId", input.citadelId);
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input.surface) query.set("surface", input.surface);
  if (input.includeHidden !== undefined) query.set("includeHidden", String(input.includeHidden));
  if (input.includeActivity) query.set("includeActivity", "true");
  query.set("limit", String(input.limit ?? 20));
  if (input.cursor) query.set("cursor", input.cursor);
  return request<ChatSessionSearchResponse>(
    `/api/v1/chat/session-search?${query.toString()}`,
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
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

export async function fetchChatSessionStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChatSessionStatusResponse> {
  return request<ChatSessionStatusResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/status`, {
    cache: "no-store",
    signal,
  });
}

/**
 * The Messaging overview: channel conversations grouped by their connection, with status and new-message counts.
 * The Gateway builds it per operator, so it is never served from a cache.
 */
export async function fetchChatMessaging(
  workspaceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ChatMessagingOverview> {
  const query = new URLSearchParams({ workspaceId });
  return request<ChatMessagingOverview>(`/api/v1/chat/messaging?${query.toString()}`, {
    cache: "no-store",
    signal: options.signal,
  });
}

/** Moves this operator's read marker for a conversation forward to `readThrough` (an ISO 8601 timestamp). */
export async function markChatSessionRead(sessionId: string, readThrough: string): Promise<ChatSessionReadResponse> {
  return request<ChatSessionReadResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: "POST",
    body: JSON.stringify({ readThrough }),
  });
}

/** Response from Chat's deliberately narrow durable aggregate-stop control. */
export interface ChatFanoutStopResponse {
  invocationId: string;
  status: ChatFanoutInvocationStatus;
  terminalReason?: string;
}

/**
 * Stops one canonical fan-out aggregate. The Gateway performs durable child
 * cancellation; the client never retries or rewires individual children.
 */
export async function stopChatFanout(sessionId: string, invocationId: string): Promise<ChatFanoutStopResponse> {
  return request<ChatFanoutStopResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/fanouts/${encodeURIComponent(invocationId)}/stop`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function fetchChatTimers(sessionId: string): Promise<ChatTimerListResponse> {
  return request<ChatTimerListResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers`, {
    cache: "no-store",
  });
}

export async function createChatTimer(
  sessionId: string,
  input: CreateChatTimerInput,
): Promise<ChatTimerMutationResponse> {
  return request<ChatTimerMutationResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelChatTimer(
  sessionId: string,
  timerId: string,
  expectedRevision: number,
): Promise<ChatTimerMutationResponse> {
  return request<ChatTimerMutationResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/timers/${encodeURIComponent(timerId)}`,
    { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
  );
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

export async function fetchChatMessages(
  sessionId: string,
  limit = 200,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ChatMessagesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.max(1, Math.min(limit, 1000))));
  if (cursor) {
    query.set("cursor", cursor);
  }
  return request<ChatMessagesResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
    { cache: "no-store", signal },
  );
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

/** Render an `html` generated artifact to offline PNG evidence (idempotent per content hash). */
export async function renderChatGeneratedArtifact(
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactRenderResponse> {
  return request<ChatArtifactRenderResponse>(
    `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifactId)}/renders`,
    { method: "POST", body: JSON.stringify({ workspaceId }) },
  );
}

/** Dispatch an `@skill impeccable critique` turn for an html artifact; the report arrives as that turn's reply. */
export async function critiqueChatGeneratedArtifact(
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactCritiqueResponse> {
  return request<ChatArtifactCritiqueResponse>(
    `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifactId)}/critique`,
    { method: "POST", body: JSON.stringify({ workspaceId }) },
  );
}

export async function listChatArtifactRenders(
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactRenderResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<ChatArtifactRenderResponse>(
    `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifactId)}/renders?${query.toString()}`,
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

export async function fetchChatSessionCoreState(
  sessionId: string,
  options: { includeThread?: boolean } = {},
): Promise<ChatSessionCoreStateResponse> {
  const query = options.includeThread === false ? "?includeThread=false" : "";
  return request<ChatSessionCoreStateResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/core-state${query}`,
  );
}

export async function fetchChatThread(sessionId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
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

export async function fetchChatTurnRoutedContext(
  sessionId: string,
  turnId: string,
  workspaceId?: string,
): Promise<ChatRoutedContextInspectionEnvelope> {
  const query = new URLSearchParams();
  if (workspaceId?.trim()) query.set("workspaceId", workspaceId.trim());
  return request<ChatRoutedContextInspectionEnvelope>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/routed-context${query.size ? `?${query}` : ""}`,
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
  // The File itself is the body: the browser streams it from disk and the Gateway streams it to disk, so neither
  // side builds a base64 copy. The details travel in the query string.
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    fileName: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
  });
  if (input.projectId) query.set("projectId", input.projectId);
  return request<ChatAttachmentRecord>(`/api/v1/chat/attachments?${query.toString()}`, {
    method: "POST",
    body: input.file,
    ...(await uploadHashHeaders(input.file)),
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

export async function createChatChangePlan(
  sessionId: string,
  requestInput: ChatChangePlanRequest,
): Promise<ChatChangePlanRecord> {
  return request<ChatChangePlanRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/change-plans`, {
    method: "POST",
    body: JSON.stringify(requestInput),
  });
}

export async function fetchChatChangePlans(
  sessionId: string,
  options?: { limit?: number },
): Promise<{ items: ChatChangePlanRecord[] }> {
  const query = options?.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
  return request<{ items: ChatChangePlanRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/change-plans${query}`,
  );
}

export async function confirmChatChangePlan(
  sessionId: string,
  planId: string,
  expectedRevision: number,
): Promise<ChatChangePlanRecord> {
  return request<ChatChangePlanRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/change-plans/${encodeURIComponent(planId)}/confirm`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
}

export async function cancelChatChangePlan(
  sessionId: string,
  planId: string,
  expectedRevision: number,
): Promise<ChatChangePlanRecord> {
  return request<ChatChangePlanRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/change-plans/${encodeURIComponent(planId)}/cancel`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
}

export interface ChangePlanClientContext {
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
}

export interface CreateChangePlanClientInput extends ChangePlanClientContext {
  /** The generic create route takes chat or settings only; Capabilities installs have their own route. */
  surface?: Exclude<ChangePlanCreateInput["origin"]["surface"], "system" | "capabilities">;
  request: ChangePlanRequest;
  idempotencyKey?: string;
}

function changePlanActorBody(context: ChangePlanClientContext): ChangePlanClientContext {
  return {
    workspaceId: context.workspaceId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

/** Canonical Evolution Control Plane resource API. */
export async function createChangePlan(input: CreateChangePlanClientInput): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>("/api/v1/change-plans", {
    method: "POST",
    body: JSON.stringify({
      ...changePlanActorBody(input),
      surface: input.surface ?? "chat",
      request: input.request,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }),
  });
}

export async function fetchChangePlans(
  context: ChangePlanClientContext,
  options?: { status?: ChangePlanStatus; limit?: number },
): Promise<{ items: ChangePlanRecord[] }> {
  const query = new URLSearchParams({ workspaceId: context.workspaceId });
  if (context.sessionId) query.set("sessionId", context.sessionId);
  if (options?.status) query.set("status", options.status);
  if (options?.limit) query.set("limit", String(options.limit));
  return request<{ items: ChangePlanRecord[] }>(`/api/v1/change-plans?${query.toString()}`);
}

export async function fetchChangePlan(planId: string, context: ChangePlanClientContext): Promise<ChangePlanRecord> {
  const query = new URLSearchParams({ workspaceId: context.workspaceId });
  if (context.sessionId) query.set("sessionId", context.sessionId);
  if (context.turnId) query.set("turnId", context.turnId);
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}?${query.toString()}`);
}

export async function respondToChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: ChangePlanResponseInput,
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/responses`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function confirmChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/confirmations`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function cancelChangePlan(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/cancellations`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function requestChangePlanRollback(
  planId: string,
  context: ChangePlanClientContext,
  expectedRevision: number,
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/rollback-requests`, {
    method: "POST",
    body: JSON.stringify({ ...changePlanActorBody(context), expectedRevision }),
  });
}

export async function submitChangePlanProviderSecret(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; apiKey: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/provider-secret`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanGatewayAuthCredential(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; credential: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/gateway-auth-credential`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanChannelSecrets(
  planId: string,
  context: ChangePlanClientContext,
  input: {
    expectedRevision: number;
    actionId: string;
    actionNonce: string;
    values: Readonly<Record<string, string>>;
  },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/channel-secrets`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function submitChangePlanManagedSourceSelection(
  planId: string,
  context: ChangePlanClientContext,
  input: {
    expectedRevision: number;
    actionId: string;
    actionNonce: string;
    rootPath: string;
  },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/managed-source-selections`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function completeChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string },
): Promise<ChangePlanRecord> {
  return request<ChangePlanRecord>(`/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-completions`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
  });
}

export async function startChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string },
): Promise<OpenAICodexDeviceStartResponse> {
  return request<OpenAICodexDeviceStartResponse>(
    `/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-starts`,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
    },
  );
}

export async function pollChangePlanProviderOAuth(
  planId: string,
  context: ChangePlanClientContext,
  input: { expectedRevision: number; actionId: string; actionNonce: string; flowId: string },
): Promise<OpenAICodexDevicePollResponse> {
  return request<OpenAICodexDevicePollResponse>(
    `/api/v1/change-plans/${encodeURIComponent(planId)}/provider-oauth-polls`,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ ...changePlanActorBody(context), ...input }),
    },
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

export async function acceptChatDelegation(
  sessionId: string,
  input: ChatDelegateAcceptRequest,
): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/accept`, {
    method: "POST",
    body: JSON.stringify(input),
  });
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
  changePlan?: ChatChangePlanRecord;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
}> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`, {
    method: "POST",
    body: JSON.stringify({ commandText, ...options }),
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

export async function fetchChatDelegationRun(sessionId: string, runId: string): Promise<ChatDelegationRunDetail> {
  return request<ChatDelegationRunDetail>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(runId)}`,
  );
}

export async function fetchLatestChatWorkspaceExplorer(sessionId: string): Promise<ChatDelegationRunDetail | null> {
  const response = await request<ChatLatestWorkspaceExplorerResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegations/latest-explorer`,
  );
  return response.item ?? null;
}

export async function fetchChatDelegatedScopeCandidates(input: {
  sessionId: string;
  runId: string;
  stepId: string;
}): Promise<ChatDelegatedScopeCandidatesResponse> {
  return request<ChatDelegatedScopeCandidatesResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/delegations/${encodeURIComponent(input.runId)}/steps/${encodeURIComponent(input.stepId)}/scope-candidates`,
  );
}

export async function requestChatDelegatedScopeExpansion(
  input: {
    sessionId: string;
    runId: string;
    stepId: string;
  } & ChatDelegatedScopeExpansionRequest,
): Promise<ChatDelegatedScopeExpansionResponse> {
  return request<ChatDelegatedScopeExpansionResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/delegations/${encodeURIComponent(input.runId)}/steps/${encodeURIComponent(input.stepId)}/scope-expansion`,
    {
      method: "POST",
      body: JSON.stringify({ candidateIds: input.candidateIds }),
    },
  );
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
