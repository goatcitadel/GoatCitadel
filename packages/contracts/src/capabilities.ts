export type CapabilityKind = "tool" | "skill" | "code_mode" | "proposal" | "candidate_skill";

export type CapabilityCategory = "built_in" | "optional" | "project_local" | "self_generated" | "community_imported";

export type SkillLifecycleState = "draft" | "candidate" | "approved" | "trusted" | "deprecated" | "revoked";

export type CapabilityProposalStatus =
  | "proposed"
  | "validating"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "activated"
  | "failed";

export type CapabilityCatalogScope = "inspectable" | "callable";
export type CapabilityProposalKind = "skill" | "tool";
export type CodeModeLanguage = "javascript" | "typescript";
export type CandidateLifecycleAction = "promote" | "revoke" | "rollback";
export type CodeModeRunArtifactKind =
  | "source"
  | "wrapper_manifest"
  | "policy_snapshot"
  | "stdout"
  | "stderr"
  | "aider_request"
  | "aider_invocation_plan"
  | "aider_result_envelope"
  | "aider_patch"
  | "aider_stdout"
  | "aider_stderr";

export type CodeModeRunStatus =
  | "approval_pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "expired";

export interface CapabilityArtifactRecord {
  artifactId: string;
  relPath: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  createdAt: string;
}

export interface CapabilityCatalogEntry {
  capabilityId: string;
  kind: CapabilityKind;
  category: CapabilityCategory;
  title: string;
  summary: string;
  callable: boolean;
  lifecycleState?: SkillLifecycleState;
  trustLabel?: string;
  reviewWarning?: string;
  sourceRef?: string;
  sourceProvider?: string;
  toolName?: string;
  skillId?: string;
  proposalId?: string;
  candidateId?: string;
  declaredTools?: string[];
  requires?: string[];
  wrapperVisibility?: {
    readOnly: boolean;
    deterministic: boolean;
    codeModeAllowed: boolean;
  };
}

export interface CapabilityCatalogSnapshotRecord {
  snapshotId: string;
  inspectableEntries: CapabilityCatalogEntry[];
  callableEntries: CapabilityCatalogEntry[];
  createdAt: string;
}

export interface ToolSchemaRef {
  refId: string;
  toolName: string;
  schemaHash: string;
  schemaUri: string;
}

export interface EffectiveToolGrantSummary {
  capabilityId: string;
  toolName: string;
  title: string;
  summary: string;
  riskLabel: string;
  schemaRef: ToolSchemaRef;
  readOnly: boolean;
  deterministic: boolean;
  codeModeAllowed: boolean;
}

export interface CompactToolDirectorySnapshot {
  snapshotId: string;
  version: "compact-tool-directory.v1";
  source: "callable_catalog";
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
  hash: string;
  toolCount: number;
  tools: EffectiveToolGrantSummary[];
  omitted: {
    inspectableOnlyCount: number;
    reason: "callable_only";
  };
}

export interface SkillLifecycleRecord {
  skillId: string;
  category: CapabilityCategory;
  lifecycleState: SkillLifecycleState;
  trustLabel: string;
  reviewWarning?: string;
  provenance?: {
    source: string;
    sourceRef?: string;
    sourceProvider?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CandidateSkillVersionRecord {
  candidateId: string;
  versionId: string;
  sourceKind: "code_mode_generated" | "manual";
  title: string;
  summary?: string;
  bundleRoot: string;
  originatingRunId?: string;
  wrapperManifestHash?: string;
  lifecycleState: SkillLifecycleState;
  manifestArtifact: CapabilityArtifactRecord;
  instructionArtifact: CapabilityArtifactRecord;
  proofArtifact: CapabilityArtifactRecord;
  programArtifact?: CapabilityArtifactRecord;
  schemaArtifact?: CapabilityArtifactRecord;
  createdAt: string;
  updatedAt: string;
  lastSuccessfulExecutionAt?: string;
}

export interface CapabilityProposalRecord {
  proposalId: string;
  proposalKind: CapabilityProposalKind;
  status: CapabilityProposalStatus;
  title: string;
  summary: string;
  candidateId?: string;
  activationTargetId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityProposalEventRecord {
  eventId: string;
  proposalId: string;
  eventType: "created" | "validated" | "approved" | "rejected" | "activated" | "failed";
  actorId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CodeModeSandboxMetadata {
  runnerId: string;
  runnerVersion: string;
  platform: "linux" | "darwin" | "win32" | "unknown";
  isolationProfile: string;
  required: boolean;
  available: boolean;
  /**
   * True only when `available` rests on adversarially-verified enforcement rather than
   * intended-but-unverified controls. Platforms whose passing checks include any
   * `*_intended` marker (e.g. the Windows AppContainer launcher) report `available: true`
   * with `enforcementVerified: false`, so callers must not imply verified isolation from
   * `available` alone. The public hostile-code claim remains separately gated.
   *
   * Optional for back-compat with stored/legacy snapshots; treat a missing value as
   * not-verified. Runtime metadata from `buildSandboxMetadata` always sets it.
   */
  enforcementVerified?: boolean;
  checksPassed: string[];
  checksFailed: string[];
  hostileSandboxClaim?: CodeModeHostileSandboxClaimMetadata;
  failClosedReason?: string;
  advisoryUnsandboxedReason?: string;
}

export type CodeModeHostileSandboxCanary =
  | "outside_root_read_denied"
  | "outside_root_write_denied"
  | "network_denied"
  | "env_secret_absent"
  | "symlink_path_traversal_denied"
  | "process_job_limits_enforced"
  | "artifact_hash_integrity"
  | "fail_closed_required_mode";

export type CodeModeHostileSandboxClaimStatus = "not_promoted" | "blocked" | "promoted";
export type CodeModeHostileSandboxPlatformProofStatus = "pass" | "fail" | "missing" | "not_applicable";
export type CodeModeHostileSandboxNativePlatform = "linux" | "darwin" | "win32";
export type CodeModeHostileSandboxProofPlatform = CodeModeHostileSandboxNativePlatform | "unknown";

export interface CodeModeHostileSandboxPlatformProof {
  platform: CodeModeHostileSandboxProofPlatform;
  status: CodeModeHostileSandboxPlatformProofStatus;
  checksPassed: CodeModeHostileSandboxCanary[];
  checksFailed: CodeModeHostileSandboxCanary[];
  evidenceRef?: string;
  checkedAt?: string;
}

export interface CodeModeHostileSandboxPlatformClaimMetadata {
  platform: CodeModeHostileSandboxNativePlatform;
  claimStatus: CodeModeHostileSandboxClaimStatus;
  publicClaimAllowed: boolean;
  proof: CodeModeHostileSandboxPlatformProof;
  blockers: string[];
  governance: string[];
}

export interface CodeModeHostileSandboxClaimMetadata {
  claimStatus: CodeModeHostileSandboxClaimStatus;
  publicClaimAllowed: boolean;
  requiredCanaries: CodeModeHostileSandboxCanary[];
  platformProof: CodeModeHostileSandboxPlatformProof[];
  platformClaims: Record<CodeModeHostileSandboxNativePlatform, CodeModeHostileSandboxPlatformClaimMetadata>;
  blockers: string[];
  governance: string[];
}

export type CodeModeExecutionBackendKind =
  | "host"
  | "docker"
  | "aider_adapter"
  | "e2b"
  | "daytona"
  | "sandbox0"
  | "kubernetes_agent_sandbox";
export type CodeModeExecutionBackendStatus = "active" | "available" | "preview" | "blocked" | "unknown";
export type CodeModeExecutionRuntimeSupport = "active_runner" | "preview_only" | "not_available";

export type CodeModeBackendEvaluationScore = "strong" | "partial" | "weak" | "unknown" | "not_applicable";

export interface CodeModeBackendEvaluationMatrix {
  credentialStorage: CodeModeBackendEvaluationScore;
  pathIsolation: CodeModeBackendEvaluationScore;
  networkControls: CodeModeBackendEvaluationScore;
  artifactCapture: CodeModeBackendEvaluationScore;
  resumeStateSemantics: CodeModeBackendEvaluationScore;
  windowsSupport: CodeModeBackendEvaluationScore;
  localFirstViability: CodeModeBackendEvaluationScore;
  license: CodeModeBackendEvaluationScore;
  cost: CodeModeBackendEvaluationScore;
  requiredProofLanes: string[];
}

export interface CodeModeRunExecutionBackendRef {
  backendId: string;
  kind: CodeModeExecutionBackendKind;
  label: string;
  status: CodeModeExecutionBackendStatus;
  runtimeSupport: CodeModeExecutionRuntimeSupport;
  isolationProfile?: string;
  adapterForBackendId?: string;
}

export interface CodeModeExecutionBackendRecord extends CodeModeRunExecutionBackendRef {
  default: boolean;
  callable: boolean;
  description: string;
  blockers: string[];
  governance: string[];
  evaluationOnly?: boolean;
  evaluation?: CodeModeBackendEvaluationMatrix;
  evidence: {
    sandbox?: CodeModeSandboxMetadata;
    detectedCommand?: string;
    envFlag?: string;
    credentialFileChecks?: Array<{
      pathLabel: string;
      exists: boolean;
      permissionStatus: "ok" | "too_broad" | "missing" | "unknown";
      note: string;
    }>;
  };
}

export interface CodeModeExecutionBackendsResponse {
  generatedAt: string;
  readOnly: true;
  mutationSemantics: "none";
  defaultBackendId: string;
  activeBackendId: string;
  items: CodeModeExecutionBackendRecord[];
}

export type CodeModeAiderAdapterOutcome = "patch_produced" | "no_changes" | "failed" | "refused";

export interface CodeModeAiderAdapterPatchArtifact {
  kind: "unified_diff" | "git_patch";
  artifact: CapabilityArtifactRecord;
  baseRef?: string;
  headRef?: string;
  fileCount?: number;
}

export interface CodeModeAiderAdapterResultEnvelope {
  contractVersion: 1;
  adapterId: "aider-cli-adapter";
  outcome: CodeModeAiderAdapterOutcome;
  runId?: string;
  repository?: {
    rootRelPath?: string;
    baseRef?: string;
    headRef?: string;
  };
  command: {
    argvRedacted: string[];
    cwdRelPath?: string;
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  };
  patchArtifact?: CodeModeAiderAdapterPatchArtifact;
  stdoutArtifact?: CapabilityArtifactRecord;
  stderrArtifact?: CapabilityArtifactRecord;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  replay: {
    replaySafe: false;
    policy: "audit_only";
    reason: string;
  };
}

export type CodeModeTrustedCodeWriteVerificationArtifactKind =
  | "source"
  | "wrapper_manifest"
  | "policy_snapshot"
  | "stdout"
  | "stderr";

export interface CodeModeTrustedCodeWriteVerificationArtifact {
  artifactKind: CodeModeTrustedCodeWriteVerificationArtifactKind;
  artifactId: string;
  relPath: string;
  expectedSha256: string;
  actualSha256: string;
  verified: boolean;
  bytes?: number;
}

export interface CodeModeTrustedCodeWriteVerification {
  mode: "trusted_code_artifact_hash_check";
  claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox";
  verifiedAt: string;
  artifacts: CodeModeTrustedCodeWriteVerificationArtifact[];
  notes: string[];
}

export interface CodeModeRunRecord {
  runId: string;
  status: CodeModeRunStatus;
  language: CodeModeLanguage;
  originSurface?: import("./proactive.js").ProactiveOriginSurface;
  workspaceId?: string;
  operatorId?: string;
  permissionProfileId?: string;
  permissionProfileLabel?: string;
  localOperatorOverrideId?: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess: boolean;
  capabilitySnapshotId: string;
  codeModeInputHash: string;
  wrapperManifestHash: string;
  policySnapshotHash: string;
  codeHash: string;
  approvalId?: string;
  sessionId?: string;
  turnId?: string;
  sandbox?: CodeModeSandboxMetadata;
  executionBackend?: CodeModeRunExecutionBackendRef;
  autonomousActivation?: CodeModeAutonomousActivationEvidence;
  codeArtifact: CapabilityArtifactRecord;
  wrapperManifestArtifact: CapabilityArtifactRecord;
  policySnapshotArtifact: CapabilityArtifactRecord;
  stdoutArtifact?: CapabilityArtifactRecord;
  stderrArtifact?: CapabilityArtifactRecord;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  trustedCodeWriteVerification?: CodeModeTrustedCodeWriteVerification;
  result?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CodeModeRunArtifactPreview {
  runId: string;
  artifactKind: CodeModeRunArtifactKind;
  artifact: CapabilityArtifactRecord;
  content: string;
  sha256: string;
  verifiedAt: string;
  truncated: boolean;
}

export interface CodeModeRunComparisonRecord {
  runId: string;
  baselineRunId: string;
  comparedAt: string;
  run: Pick<
    CodeModeRunRecord,
    | "runId"
    | "status"
    | "capabilitySnapshotId"
    | "codeModeInputHash"
    | "wrapperManifestHash"
    | "policySnapshotHash"
    | "codeHash"
    | "permissionProfileId"
    | "localOperatorOverrideId"
    | "createdAt"
    | "finishedAt"
  >;
  baseline: Pick<
    CodeModeRunRecord,
    | "runId"
    | "status"
    | "capabilitySnapshotId"
    | "codeModeInputHash"
    | "wrapperManifestHash"
    | "policySnapshotHash"
    | "codeHash"
    | "permissionProfileId"
    | "localOperatorOverrideId"
    | "createdAt"
    | "finishedAt"
  >;
  matches: {
    capabilitySnapshot: boolean;
    source: boolean;
    input: boolean;
    wrapperManifest: boolean;
    policySnapshot: boolean;
    permissionProfile: boolean;
    localOperatorOverride: boolean;
    sandboxRunner: boolean;
    sandboxProfile: boolean;
    sandboxAvailability: boolean;
  };
  sandbox: {
    run?: CodeModeSandboxMetadata;
    baseline?: CodeModeSandboxMetadata;
  };
}

export interface CodeModeRunRequest {
  language: CodeModeLanguage;
  source: string;
  executionBackendId?: string;
  originSurface?: import("./proactive.js").ProactiveOriginSurface;
  workspaceId?: string;
  operatorId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  autonomousActivation?: boolean;
  estimatedCostUsd?: number;
  input?: Record<string, unknown>;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess?: boolean;
  sessionId?: string;
  turnId?: string;
  aider?: {
    requestMarkdown: string;
    repositoryRootRelPath?: string;
    model?: string;
  };
}

export interface CodeModeAutonomousActivationEvidence {
  requested: boolean;
  allowed: boolean;
  matchedGrantId?: string;
  riskLevel: import("./autonomy.js").AutonomousActivationRiskLevel;
  governance: string[];
  blockers: string[];
}

export interface CodeModeRunListOptions {
  limit?: number;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  status?: CodeModeRunStatus;
}

export interface CandidateSkillDetailRecord {
  candidateId: string;
  versions: CandidateSkillVersionRecord[];
  latestVersion?: CandidateSkillVersionRecord;
  activeVersion?: CandidateSkillVersionRecord;
  relatedProposals: CapabilityProposalRecord[];
  originatingRun?: CodeModeRunRecord;
  activationBlocked: boolean;
  activationBlockers: string[];
}

export interface CapabilityProposalDetailRecord {
  proposal: CapabilityProposalRecord;
  events: CapabilityProposalEventRecord[];
  candidate?: CandidateSkillDetailRecord;
}

export interface CandidateLifecycleActionResult {
  action: CandidateLifecycleAction;
  candidateId: string;
  selectedVersionId: string;
  changedVersionIds: string[];
  occurredAt: string;
  detail: CandidateSkillDetailRecord;
}
