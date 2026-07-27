import type { ChatSessionRecord } from "./chat.js";

export const CHAT_SESSION_FORK_MANIFEST_VERSION = "chat.session-fork-manifest.v1" as const;

export interface ChatSessionForkRequest {
  title?: string;
  expectedRevision?: number;
}

export interface ChatSessionForkTurnMapping {
  sourceTurnId: string;
  copiedTurnId: string;
  sourceParentTurnId?: string;
  copiedParentTurnId?: string;
  sourceTraceHash: string;
  copiedTraceHash: string;
}

export interface ChatSessionForkMessageMapping {
  sourceMessageId: string;
  copiedMessageId: string;
  sourceTurnId: string;
  copiedTurnId: string;
  role: "user" | "assistant" | "system";
  contentHash: string;
}

export interface ChatSessionForkAttachmentCopy {
  sourceAttachmentId: string;
  copiedAttachmentId: string;
  sha256: string;
}

export interface ChatSessionForkArtifactCopy {
  sourceArtifactId: string;
  copiedArtifactId: string;
  contentHash: string;
  version: number;
}

export interface ChatSessionForkManifest {
  manifestVersion: typeof CHAT_SESSION_FORK_MANIFEST_VERSION;
  forkId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  newSessionId: string;
  workspaceId: string;
  transcriptPathHash: string;
  turnMappings: ChatSessionForkTurnMapping[];
  messageMappings: ChatSessionForkMessageMapping[];
  attachmentCopies: ChatSessionForkAttachmentCopy[];
  artifactCopies: ChatSessionForkArtifactCopy[];
  contextSnapshotHashes: string[];
  sourceEvidenceHashes: string[];
  createdByActorId: string;
  createdAt: string;
}

export interface ChatSessionForkRelationship {
  forkId: string;
  direction: "forked_from" | "forked_to";
  relatedSessionId: string;
  sourceTurnId: string;
  transcriptPathHash: string;
  createdAt: string;
}

export interface ChatSessionForkResponse {
  session: ChatSessionRecord;
  manifest: ChatSessionForkManifest;
}
