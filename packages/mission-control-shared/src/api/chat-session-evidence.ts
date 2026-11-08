import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactSourceSurface,
  ChatSpecialistCandidateRecord,
  ProactivePolicy,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import type { ChatGeneratedArtifactsResponse, ChatThreadKnowledgeAttachmentsResponse } from "./chat.js";
import { request } from "./client-core.js";

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
  if (input?.sourceSurface) query.set("sourceSurface", "chat");
  if (input?.kind) query.set("kind", input.kind);
  query.set("limit", String(input?.limit ?? 300));
  return request<ChatGeneratedArtifactsResponse>(`/api/v1/chat/generated-artifacts?${query.toString()}`);
}

export async function fetchThreadKnowledgeAttachments(
  sessionId: string,
): Promise<ChatThreadKnowledgeAttachmentsResponse> {
  return request<ChatThreadKnowledgeAttachmentsResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/knowledge-attachments`,
  );
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

export async function fetchChatProactiveRuns(sessionId: string, limit = 50): Promise<{ items: ProactiveRunRecord[] }> {
  return request<{ items: ProactiveRunRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/runs?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchChatSpecialistCandidates(
  sessionId: string,
  limit = 200,
): Promise<{ items: ChatSpecialistCandidateRecord[] }> {
  return request<{ items: ChatSpecialistCandidateRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchChatCommandCatalog(): Promise<{
  items: Array<{ command: string; usage: string; description: string }>;
}> {
  return request<{ items: Array<{ command: string; usage: string; description: string }> }>(
    "/api/v1/chat/catalog/commands",
  );
}
