import type { TaskPriority, TaskRecord } from "./tasks.js";

export type ReviewReadinessLaneStatus = "missing" | "stale" | "current";

export interface ReviewReadinessLane {
  lane: string;
  status: ReviewReadinessLaneStatus;
  artifactRef?: string;
  lastRunAt?: string;
  rerunHint: string;
}

export type RuntimeBuildKind = "development" | "source" | "packaged";
export type RuntimeBuildIntegrity = "clean" | "modified" | "unknown";
export type RuntimeBuildIdentitySource = "git_checkout" | "packaged_manifest" | "unavailable";
export type ReleaseCertificateState = "absent" | "malformed" | "parsed";
export type CertificateAttestationStatus =
  | "not_applicable"
  | "missing"
  | "pending"
  | "verified"
  | "invalid"
  | "unavailable";
export type RuntimePayloadIntegrityStatus =
  | "not_applicable"
  | "unverified"
  | "pending"
  | "verified"
  | "mismatch"
  | "unavailable";

export type ReleaseIdentityReasonCode =
  | "certificate_absent"
  | "certificate_malformed"
  | "certificate_attestation_missing"
  | "certificate_attestation_invalid"
  | "certificate_attestation_pending"
  | "certificate_attestation_unavailable"
  | "identity_sha_unavailable"
  | "identity_integrity_unavailable"
  | "runtime_payload_integrity_unverified"
  | "runtime_payload_integrity_pending"
  | "runtime_payload_integrity_mismatch"
  | "runtime_payload_integrity_unavailable"
  | "source_modified"
  | "certificate_sha_mismatch"
  | "certificate_version_mismatch"
  | "certificate_timestamp_invalid"
  | "accepted_failures_present"
  | "required_proof_missing"
  | "required_proof_failed"
  | "required_proof_stale"
  | "release_assets_missing"
  | "release_assets_invalid"
  | "release_asset_evidence_missing"
  | "release_asset_evidence_mismatch"
  | "release_evidence_path_invalid"
  | "proof_bundle_missing"
  | "proof_bundle_evidence_missing"
  | "proof_bundle_evidence_mismatch"
  | "certificate_exact_sha_invalid";

export interface RuntimeReleaseIdentity {
  verified: boolean;
  certificateState: ReleaseCertificateState;
  certificateCommit?: string;
  certificateVersion?: string;
  generatedAt?: string;
  requiredProof: {
    total: number;
    passed: number;
    missing: number;
    failed: number;
    stale: number;
  };
  acceptedFailureCount: number;
  acceptedFailures: string[];
  certificateAttestation: {
    status: CertificateAttestationStatus;
    verifiedAt?: string;
    issuer?: string;
    identity?: string;
  };
  runtimePayloadIntegrity: {
    status: RuntimePayloadIntegrityStatus;
    verifiedAt?: string;
    target?: string;
    manifestSha256?: string;
    fileCount?: number;
    totalBytes?: number;
  };
  reasonCodes: ReleaseIdentityReasonCode[];
  reasons: string[];
}

/**
 * Sanitized, server-resolved identity for the code that is currently serving
 * Mission Control. Clients can display this record but cannot author or
 * upgrade any of its trust fields.
 */
export interface RuntimeBuildIdentity {
  schemaVersion: 1;
  kind: RuntimeBuildKind;
  version: string;
  buildSha?: string;
  shortSha?: string;
  integrity: RuntimeBuildIntegrity;
  identitySource: RuntimeBuildIdentitySource;
  release: RuntimeReleaseIdentity;
}

export interface ReviewReadinessSummary {
  branch: string;
  sha: string;
  generatedAt: string;
  lanes: ReviewReadinessLane[];
  openFindings: number;
  linkedTasks: TaskRecord[];
  runtimeIdentity: RuntimeBuildIdentity;
  releaseProof?: {
    sourceCertificate: "release-certificate.json";
    exactShaStatus: "exact" | "partial" | "missing" | "unknown";
    artifacts: Array<{
      name: string;
      platformArch: string;
      /** Display-only signature inventory; never publisher-attestation proof. */
      signatureStatus: "signed" | "unsigned" | "experimental" | "unverified";
      sha256: string;
      sizeBytes: number;
      sourceWorkflow: string;
      exactShaStatus: string;
      certificateInclusion: "included" | "missing";
      acceptedCaveats: string[];
    }>;
  };
}

export interface ReviewFindingInput {
  source: string;
  component: string;
  title: string;
  files: string[];
  priority?: TaskPriority;
  summary?: string;
  evidenceRef?: string;
  severity?: ReviewFindingSeverity;
  whyItMatters?: string;
  confidence?: ReviewFindingConfidence;
  evidence?: ReviewFindingEvidence[];
  preExisting?: boolean;
  fixClass?: ReviewFindingFixClass;
  ownerRole?: string;
  suggestedFix?: string;
  requiresVerification?: boolean;
  testingGaps?: string[];
  residualRisks?: string[];
}

export type ReviewFindingSeverity = "p0" | "p1" | "p2" | "p3";
export type ReviewFindingConfidence = 0 | 25 | 50 | 75 | 100;
export type ReviewFindingFixClass = "approval_gated" | "manual" | "advisory";
export type ReviewRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ReviewFindingEvidence {
  path?: string;
  startLine?: number;
  endLine?: number;
  quote?: string;
  artifactRef?: string;
}

export interface ReviewFindingRecord extends ReviewFindingInput {
  findingId: string;
  reviewRunId: string;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingConfidence;
  preExisting: boolean;
  fixClass: ReviewFindingFixClass;
  requiresVerification: boolean;
  status: "open" | "accepted" | "dismissed" | "fix_requested" | "verified" | "closed";
  linkedTaskId?: string;
  fixApprovalId?: string;
  fixedByCodeModeRunId?: string;
  followUpReviewRunId?: string;
  verificationEvidence?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRunRecord {
  reviewRunId: string;
  source: "native" | "external_import";
  status: ReviewRunStatus;
  rootPath: string;
  reviewedSha: string;
  diffHash: string;
  changedFiles: string[];
  reviewerRoster: string[];
  preflight?: {
    participantCount: number;
    reviewerLensCount: number;
    estimatedReviewCalls: number;
    tokenBudget: number;
    costBudgetUsd: number;
  };
  modelReceipts: Array<{ role: string; providerId?: string; model?: string; runId?: string }>;
  assemblyRunId?: string;
  findings: ReviewFindingRecord[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ReviewFindingImportResult {
  reviewRunId?: string;
  importedAt: string;
  created: TaskRecord[];
  updated: TaskRecord[];
  skipped: ReviewFindingInput[];
}
