import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function updateChatSession(
  sessionId: string,
  input: { expectedRevision: number; title?: string; folderId?: string; folderName?: string; tags?: string[] },
): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
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
