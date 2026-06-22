export type EvidenceEnvelopeEventKind =
  | "tool_invocation"
  | "approval_resolution"
  | "durable_checkpoint"
  | "memory_write"
  | "capability_pack_install"
  | "capability_pack_materialization"
  | "continuation_gate"
  | "skill_export"
  | "browser_content_guard"
  | "external_writeback";

export type EvidenceEnvelopeSignatureStatus = "signed_hmac" | "unsigned_local" | "verification_failed";

export interface EvidenceEnvelope {
  envelopeId: string;
  eventKind: EvidenceEnvelopeEventKind;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  contentHash: string;
  previousEnvelopeHash?: string;
  payloadHash: string;
  toolCallHashes: string[];
  memoryLineage: string[];
  policyHash?: string;
  signatureStatus: EvidenceEnvelopeSignatureStatus;
  signature?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceEnvelopeListQuery {
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  limit?: number;
}

export interface EvidenceEnvelopeListResponse {
  items: EvidenceEnvelope[];
}

export type BrowserProofActionKind = "observe" | "extract" | "act";

export interface BrowserProofRecord {
  proofId: string;
  actionKind: BrowserProofActionKind;
  targetDescription: string;
  selector?: string;
  semanticTarget?: string;
  screenshotRef?: string;
  screenshotSha256?: string;
  artifactRefs?: string[];
  actionResult: "succeeded" | "blocked" | "failed" | "unknown";
  policyDecision: "allowed" | "blocked" | "requires_approval" | "not_evaluated";
  privateHostGuard: "allowed" | "blocked" | "not_applicable" | "unknown";
  networkGuard: "allowed" | "blocked" | "not_applicable" | "unknown";
  redactionSummary: {
    applied: boolean;
    fields: string[];
    note: string;
  };
  createdAt: string;
}
