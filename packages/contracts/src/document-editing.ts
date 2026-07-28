export const DOCUMENT_PATCH_PROPOSAL_SCHEMA_VERSION = "document-patch-proposal.v1" as const;
export const DOCUMENT_EDITABLE_ARTIFACT_KINDS = ["markdown", "text"] as const;

export type DocumentPatchTargetKind = "personal_note" | "generated_artifact";
export type DocumentPatchProposalState = "pending" | "applied" | "rejected" | "conflicted";
export type DocumentPatchAuthorKind = "operator" | "assistant";

export interface DocumentPatchProposalRecord {
  proposalId: string;
  schemaVersion: typeof DOCUMENT_PATCH_PROPOSAL_SCHEMA_VERSION;
  workspaceId: string;
  sessionId?: string;
  targetKind: DocumentPatchTargetKind;
  targetId: string;
  baseRevision?: number;
  baseContentHash?: string;
  proposedContent: string;
  /** Server-derived unified diff for operator review. */
  derivedDiff: string;
  authorKind: DocumentPatchAuthorKind;
  authorId: string;
  turnId?: string;
  state: DocumentPatchProposalState;
  appliedTargetId?: string;
  appliedRevision?: number;
  appliedContentHash?: string;
  conflictReason?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CreateDocumentPatchProposalRequest {
  workspaceId: string;
  targetKind: DocumentPatchTargetKind;
  targetId: string;
  baseRevision?: number;
  baseContentHash?: string;
  proposedContent: string;
}

/**
 * Model-callable proposal input. Runtime identity and provenance are deliberately
 * absent: the Gateway binds workspace, session, turn, and assistant actor from
 * the active tool invocation.
 */
export type DocumentPatchProposalToolInput = Omit<CreateDocumentPatchProposalRequest, "workspaceId">;

export interface ApplyDocumentPatchProposalRequest {
  workspaceId: string;
}

export interface CreateGeneratedArtifactVersionRequest {
  workspaceId: string;
  baseContentHash: string;
  content: string;
  title?: string;
}

export interface DocumentPatchProposalListResponse {
  items: DocumentPatchProposalRecord[];
}
