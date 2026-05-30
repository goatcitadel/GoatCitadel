export type EvidenceEnvelopeEventKind =
  | "tool_invocation"
  | "approval_resolution"
  | "durable_checkpoint"
  | "memory_write"
  | "capability_pack_install"
  | "continuation_gate"
  | "skill_export"
  | "browser_content_guard"
  | "external_writeback";

export type EvidenceEnvelopeSignatureStatus = "signed_hmac" | "unsigned_local" | "verification_failed";

export interface EvidenceEnvelope {
  envelopeId: string;
  eventKind: EvidenceEnvelopeEventKind;
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
  sessionId?: string;
  turnId?: string;
  runId?: string;
  limit?: number;
}

export interface EvidenceEnvelopeListResponse {
  items: EvidenceEnvelope[];
}
