import type {
  ChatSessionWorkbenchTreeResponse,
  ChatSessionWorkbenchReadOptions,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchCommandRunRequest,
  ChatSessionWorkbenchCommandRunResponse,
  ChatSessionWorkbenchFileOperationPreviewRequest,
  ChatSessionWorkbenchFileOperationPreviewResponse,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchFileOperationResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchPatchApplyRequest,
  ChatSessionWorkbenchPatchApplyResponse,
  ChatSessionWorkbenchPatchExportResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchRevertFileRequest,
  ChatSessionWorkbenchRevertResponse,
  ChatSessionWorkbenchSaveFileRequest,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

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

export async function previewChatSessionWorkbenchFileOperation(
  sessionId: string,
  input: ChatSessionWorkbenchFileOperationPreviewRequest,
): Promise<ChatSessionWorkbenchFileOperationPreviewResponse> {
  return request<ChatSessionWorkbenchFileOperationPreviewResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file-operation/preview`,
    { method: "POST", body: JSON.stringify(input) },
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

export async function fetchChatSessionWorkbench(
  sessionId: string,
  options?: ChatSessionWorkbenchReadOptions,
): Promise<{ state: ChatSessionWorkbenchRecord }> {
  return request<{ state: ChatSessionWorkbenchRecord }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench${options?.preview ? "?preview=true" : ""}`,
  );
}

export async function fetchChatSessionWorkbenchTree(
  sessionId: string,
  options?: ChatSessionWorkbenchReadOptions,
): Promise<ChatSessionWorkbenchTreeResponse> {
  return request<ChatSessionWorkbenchTreeResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/tree${options?.preview ? "?preview=true" : ""}`,
  );
}

export async function fetchChatSessionWorkbenchFile(
  sessionId: string,
  relativePath: string,
  options?: ChatSessionWorkbenchReadOptions,
): Promise<ChatSessionWorkbenchFileResponse> {
  const query = new URLSearchParams({ path: relativePath });
  if (options?.preview) query.set("preview", "true");
  return request<ChatSessionWorkbenchFileResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench/file?${query.toString()}`,
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
