import type {
  CreateDocumentPatchProposalRequest,
  CreateGeneratedArtifactVersionRequest,
  DocumentPatchProposalListResponse,
  DocumentPatchProposalRecord,
} from "@goatcitadel/contracts";
import type { ChatGeneratedArtifactResponse } from "./chat.js";
import { request } from "./client-core.js";

export async function createChatGeneratedArtifactVersion(
  artifactId: string,
  input: CreateGeneratedArtifactVersionRequest,
): Promise<ChatGeneratedArtifactResponse> {
  return request<ChatGeneratedArtifactResponse>(
    `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifactId)}/versions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function listDocumentPatchProposals(input: {
  workspaceId: string;
  sessionId?: string;
  state?: DocumentPatchProposalRecord["state"];
}): Promise<DocumentPatchProposalListResponse> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.state) query.set("state", input.state);
  return request<DocumentPatchProposalListResponse>(`/api/v1/chat/document-patch-proposals?${query.toString()}`);
}

/** One document proposal by id, within its workspace. */
export async function fetchDocumentPatchProposal(
  proposalId: string,
  options: { workspaceId: string; signal?: AbortSignal },
): Promise<DocumentPatchProposalResponse> {
  return request<DocumentPatchProposalResponse>(
    `/api/v1/chat/document-patch-proposals/${encodeURIComponent(proposalId)}?workspaceId=${encodeURIComponent(options.workspaceId)}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export async function createDocumentPatchProposal(
  input: CreateDocumentPatchProposalRequest & { sessionId?: string },
): Promise<DocumentPatchProposalResponse> {
  return request<DocumentPatchProposalResponse>("/api/v1/chat/document-patch-proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function applyDocumentPatchProposal(
  proposalId: string,
  workspaceId: string,
): Promise<DocumentPatchProposalResponse> {
  return request<DocumentPatchProposalResponse>(
    `/api/v1/chat/document-patch-proposals/${encodeURIComponent(proposalId)}/apply`,
    { method: "POST", body: JSON.stringify({ workspaceId }) },
  );
}

export async function rejectDocumentPatchProposal(
  proposalId: string,
  workspaceId: string,
): Promise<DocumentPatchProposalResponse> {
  return request<DocumentPatchProposalResponse>(
    `/api/v1/chat/document-patch-proposals/${encodeURIComponent(proposalId)}/reject`,
    { method: "POST", body: JSON.stringify({ workspaceId }) },
  );
}

export interface DocumentPatchProposalResponse {
  item: DocumentPatchProposalRecord;
}
