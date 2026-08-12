export type AgenticSurface = "chat" | "cowork" | "code";

export type AgenticRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "approval_required"
  | "paused"
  | "checkpointing"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped_by_limit";

export type AgenticContextMode = "isolated" | "fork";

export type AgenticWorkspaceKind = "none" | "session" | "worktree" | "external_harness";

export type AgenticFailureClass =
  | "spawn_failure"
  | "timeout"
  | "crash"
  | "stale_worker"
  | "invalid_assignee"
  | "unsafe_transition"
  | "missing_handoff"
  | "missing_artifact"
  | "repeated_tool_loop"
  | "approval_stale"
  | "delivery_failed"
  | "provider_fallback_loop"
  | "other";

export type AgenticDiagnosticSeverity = "info" | "warning" | "critical";

export const AGENTIC_DIAGNOSTIC_CODES = [
  "repeated_tool_result",
  "post_compaction_loop",
  "missing_assistant_output",
  "stale_approval",
  "child_timeout",
  "timeout_exceeded",
  "max_depth_exceeded",
  "spawn_failure",
  "worker_crash",
  "stale_worker",
  "invalid_assignee_profile",
  "unsafe_status_transition",
  "provider_fallback_loop",
  "projection_status_drift",
  "research_evidence_incomplete",
  "candidate_discovery_incomplete",
  "source_access_blocked",
  "durable_missing_after_completion",
  "dirty_worktree_without_artifact",
  "missing_claimed_artifact",
  "missing_claimed_file",
  "missing_claimed_test",
  "repeated_phase_failure",
  "final_delivery_retry",
] as const;

export type AgenticDiagnosticCode = (typeof AGENTIC_DIAGNOSTIC_CODES)[number];

export interface AgenticDiagnosticSignal {
  signalId: string;
  code: AgenticDiagnosticCode;
  severity: AgenticDiagnosticSeverity;
  title: string;
  summary: string;
  evidenceRef?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type AgenticClaimVerificationStatus = "unverified" | "verified" | "missing" | "failed";

export interface AgenticClaimVerification {
  status: AgenticClaimVerificationStatus;
  claimRef?: string;
  checkedAt?: string;
  detail?: string;
}

export type AgenticCommandRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "timed_out";

export interface AgenticCommandRunRecord {
  commandRunId: string;
  sessionId?: string;
  runId?: string;
  worktreePath?: string;
  command: string;
  args: string[];
  status: AgenticCommandRunStatus;
  exitCode?: number;
  timedOut?: boolean;
  startedAt: string;
  completedAt?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutArtifactRef?: string;
  stderrArtifactRef?: string;
  validationStatus: "pending" | "passed" | "failed";
}

export type AgenticPatchArtifactStatus =
  | "proposed"
  | "reviewing"
  | "approved"
  | "applied"
  | "reverted"
  | "rejected"
  | "invalid";

export interface AgenticPatchArtifactRecord {
  patchArtifactId: string;
  sessionId?: string;
  runId?: string;
  worktreePath?: string;
  changedFiles: string[];
  diffPreview: string;
  status: AgenticPatchArtifactStatus;
  createdAt: string;
  updatedAt: string;
  applyRef?: string;
  rollbackRef?: string;
  diagnostics?: AgenticDiagnosticSignal[];
}

export interface AgenticClaimVerificationRecord {
  verificationId: string;
  runId?: string;
  patchArtifactId?: string;
  claimType: "file" | "test" | "artifact";
  claimRef: string;
  status: AgenticClaimVerificationStatus;
  checkedAt: string;
  detail?: string;
}

export interface AgenticHandoffEvidence {
  summary: string;
  artifactRefs?: string[];
  fileRefs?: string[];
  testRefs?: string[];
  sourceStepId?: string;
  createdAt: string;
}

export type DelegatedWorkResultDisposition = "completed" | "blocked" | "scope_expansion";

export interface DelegatedScopeExpansionRequest {
  requestedPaths: string[];
  resolvedPaths?: string[];
  reason: string;
  scopeHash: string;
  approvalId?: string;
  requestedAt: string;
  resolvedAt?: string;
  decision?: "approved" | "rejected" | "expired";
}

export interface DelegatedFilesystemScopeControl {
  rootPath: string;
  /** Server-owned project binding frozen with the initial delegated scope. */
  projectId?: string;
  /** Frozen workspace-relative base for resolving the child's relative tool paths. */
  workingPath?: string;
  approvedPaths: string[];
  scopeHash: string;
  dispatchGeneration: string;
  updatedAt: string;
}

/** Content-free client projection; canonical host paths remain server-owned. */
export type DelegatedFilesystemScopePublicProjection = Omit<DelegatedFilesystemScopeControl, "rootPath" | "projectId">;

/**
 * A content-free, server-selected path option that can be submitted from Chat.
 * The client receives a workspace-relative display label and opaque id, never
 * a host path and never authority to name a different path.
 */
export interface ChatDelegatedScopeCandidateRecord {
  candidateId: string;
  label: string;
  scopeHash: string;
}

export interface ChatDelegatedScopeCandidatesResponse {
  runId: string;
  stepId: string;
  scopeHash: string;
  candidates: ChatDelegatedScopeCandidateRecord[];
  pendingApprovalId?: string;
}

export interface ChatDelegatedScopeExpansionRequest {
  candidateIds: string[];
}

export interface ChatDelegatedScopeExpansionResponse {
  runId: string;
  stepId: string;
  approvalId: string;
  waitingForApproval: true;
}

export interface DelegatedWorkResult {
  disposition: DelegatedWorkResultDisposition;
  summary: string;
  changedFiles: string[];
  evidenceRefs: string[];
  /** Server-owned scope authority under which this result was submitted. */
  scopeHash?: string;
  /** Server-owned dispatch generation under which this result was submitted. */
  dispatchGeneration?: string;
  scopeExpansion?: DelegatedScopeExpansionRequest;
}

export interface AgenticWorkspaceScope {
  kind: AgenticWorkspaceKind;
  rootPath?: string;
  worktreePath?: string;
  baseRef?: string;
  harnessId?: string;
}

export interface AgenticDeliveryState {
  target?: string;
  threadKey?: string;
  status: "not_required" | "queued" | "sending" | "sent" | "failed" | "rate_limited" | "stale";
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface AgenticDeliveryAttemptRecord {
  deliveryId: string;
  connectionId?: string;
  channelKey: string;
  target: string;
  runId?: string;
  attempt: number;
  status: AgenticDeliveryState["status"];
  queuedAt: string;
  attemptedAt?: string;
  completedAt?: string;
  nextAttemptAt?: string;
  providerMessageId?: string;
  error?: string;
  staleReason?: string;
}

export interface AgenticChannelRuntimeState {
  connectionId?: string;
  channelKey: string;
  activeTarget?: string;
  threadKey?: string;
  boundSessionId?: string;
  activeRunId?: string;
  progressDelivery?: AgenticDeliveryState;
  finalDelivery?: AgenticDeliveryState;
  staleReason?: string;
  diagnostics?: AgenticDiagnosticSignal[];
  checkedAt: string;
}

export interface AgenticTaskContext {
  boardId?: string;
  runId?: string;
  parentRunId?: string;
  childRunIds?: string[];
  parentSessionId?: string;
  childSessionId?: string;
  orchestrationRunId?: string;
  durableRunId?: string;
  surface?: AgenticSurface;
  status?: AgenticRunStatus;
  contextMode?: AgenticContextMode;
  profileId?: string;
  assigneeProfileId?: string;
  workspaceScope?: AgenticWorkspaceScope;
  heartbeatAt?: string;
  timeoutAt?: string;
  failureClass?: AgenticFailureClass;
  diagnostics?: AgenticDiagnosticSignal[];
  handoffEvidence?: AgenticHandoffEvidence[];
  providerId?: string;
  model?: string;
  maxSpawn?: number;
  activeChildCount?: number;
  costUsd?: number;
  tokenTotal?: number;
  filesTouched?: string[];
  capabilitySnapshotId?: string;
  policySnapshotHash?: string;
  claimVerification?: AgenticClaimVerification;
  deliveryState?: AgenticDeliveryState;
}

export interface AgenticRunListItem {
  taskId: string;
  taskRevision?: number;
  runId: string;
  boardId?: string;
  title: string;
  summary?: string;
  taskStatus: string;
  status?: AgenticRunStatus;
  surface?: AgenticSurface;
  parentSessionId?: string;
  parentRunId?: string;
  contextMode?: AgenticContextMode;
  profileId?: string;
  updatedAt: string;
  diagnostics?: AgenticDiagnosticSignal[];
}

export interface AgenticSubagentMetadata {
  runId?: string;
  parentRunId?: string;
  profileId?: string;
  contextMode?: AgenticContextMode;
  index?: number;
  depth?: number;
  dependsOnStepIds?: string[];
  heartbeatAt?: string;
  timeoutAt?: string;
  failureClass?: AgenticFailureClass;
  diagnostics?: AgenticDiagnosticSignal[];
  costUsd?: number;
  tokenTotal?: number;
  filesTouched?: string[];
  handoffEvidence?: AgenticHandoffEvidence;
  waiting?: AgenticSubagentWaitingProjection;
}

export interface AgenticSubagentWaitingProjection {
  status: "queued" | "running" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user_input";
  reason: string;
  childTurnId: string;
  durableRunId?: string;
  observedAt: string;
}

export interface AgenticRunTreeNode {
  id: string;
  kind: "run" | "task" | "subagent" | "approval" | "artifact" | "diagnostic";
  label: string;
  status: string;
  parentId?: string;
  taskId?: string;
  agentSessionId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AgenticRunTreeEdge {
  from: string;
  to: string;
  kind: "contains" | "depends_on" | "spawned" | "produced" | "blocked_by";
}

export interface AgenticRunTreeResponse {
  runId: string;
  taskRevision?: number;
  boardId?: string;
  generatedAt: string;
  nodes: AgenticRunTreeNode[];
  edges: AgenticRunTreeEdge[];
  diagnostics: AgenticDiagnosticSignal[];
  controls: AgenticControlDescriptor[];
}

export type AgenticControlAction =
  | "pause"
  | "cancel"
  | "retry"
  | "steer"
  | "kill_child"
  | "approve"
  | "reject"
  | "open_child";

export interface AgenticControlDescriptor {
  action: AgenticControlAction;
  label: string;
  enabled: boolean;
  reason?: string;
  requiresApproval?: boolean;
  runtimeEffect?: AgenticControlResponse["runtimeEffect"];
}

export interface AgenticControlRequest {
  action: AgenticControlAction;
  expectedRevision?: number;
  controlId?: string;
  reason?: string;
  instruction?: string;
  agentSessionId?: string;
  approvalId?: string;
  actorId?: string;
}

export interface AgenticControlResponse {
  action: AgenticControlAction;
  taskId: string;
  taskRevision: number;
  runId?: string;
  status: "recorded" | "applied" | "rejected";
  runtimeEffect: "state_only" | "runtime_pause" | "runtime_cancel" | "approval_resolution" | "navigation";
  controlId?: string;
  idempotentReplay?: boolean;
  message: string;
}

export type AgenticCapabilityAvailabilityStatus = "callable" | "blocked" | "not_configured" | "unavailable";

export interface AgenticCapabilityAvailability {
  capabilityId: string;
  label: string;
  family:
    | "tool"
    | "mcp"
    | "skill"
    | "plugin"
    | "provider"
    | "harness"
    | "channel"
    | "self_improvement"
    | "agent_sdk"
    | "agent_protocol";
  status: AgenticCapabilityAvailabilityStatus;
  callable: boolean;
  reasons: string[];
  checkedAt: string;
}

export type AgenticHarnessAvailabilityStatus = AgenticCapabilityAvailabilityStatus;

export interface AgenticHarnessAvailabilityRecord {
  harnessId: string;
  label: string;
  status: AgenticHarnessAvailabilityStatus;
  executablePath?: string;
  callable: boolean;
  reasons: string[];
  checkedAt: string;
  sandboxRequired?: boolean;
  sandboxSatisfied?: boolean;
}

export interface AgenticScriptedRunnerRecord {
  scriptRunId: string;
  runId?: string;
  sessionId?: string;
  status: AgenticCommandRunStatus;
  policySnapshotHash?: string;
  exposedTools: string[];
  outputPreview?: string;
  artifactRefs?: string[];
  approvalId?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface AgenticImprovementEvidenceRef {
  source: "agentic_diagnostic" | "prompt_lab" | "skill_evaluation" | "memory" | "plugin" | "provider" | "channel";
  sourceId: string;
  title: string;
  summary?: string;
}

export interface AgenticImprovementProposalSummary {
  proposalId: string;
  title: string;
  status:
    | "proposal"
    | "validation"
    | "approval_pending"
    | "approved"
    | "activated"
    | "rejected"
    | "revoked"
    | "snoozed";
  observedIssue: string;
  proposedChange: string;
  risk: "low" | "medium" | "high";
  callableImpact: "none" | "narrows" | "widens_after_approval";
  rollbackRef?: string;
  evidence: AgenticImprovementEvidenceRef[];
}

export interface AgenticPluginProviderRuntimeStatus {
  runtimeId: string;
  kind: "plugin" | "provider";
  label: string;
  status: AgenticHarnessAvailabilityStatus;
  manifestSource?: string;
  integrityStatus: "verified" | "unverified" | "corrupt" | "quarantined";
  permissions: string[];
  secretsRequired: string[];
  secretReadiness?: {
    required: string[];
    configured: string[];
    missing: string[];
  };
  rollbackRef?: string;
  callableExposure: AgenticCapabilityAvailabilityStatus;
  healthCheckedAt?: string;
  healthMessage?: string;
}

export type AgenticScalabilityTrackId = "openai_agents_sdk" | "claude_agent_sdk" | "a2a_protocol";

export type AgenticScalabilityTrackKind = "agent_sdk" | "agent_protocol";

export type AgenticScalabilityImplementationStatus = "implemented" | "partial" | "missing";

export interface AgenticScalabilityEvidenceRef {
  label: string;
  path?: string;
  url?: string;
}

export interface AgenticScalabilityTrackRecord {
  trackId: AgenticScalabilityTrackId;
  label: string;
  kind: AgenticScalabilityTrackKind;
  status: AgenticCapabilityAvailabilityStatus;
  callable: boolean;
  implementationStatus: AgenticScalabilityImplementationStatus;
  summary: string;
  reasons: string[];
  evidence: AgenticScalabilityEvidenceRef[];
  requiredNextSteps: string[];
  checkedAt: string;
}

export interface AgenticRuntimeAvailabilityResponse {
  generatedAt: string;
  items: AgenticCapabilityAvailability[];
  harnesses: AgenticHarnessAvailabilityRecord[];
  plugins: AgenticPluginProviderRuntimeStatus[];
  providers: AgenticPluginProviderRuntimeStatus[];
  channels: AgenticCapabilityAvailability[];
  scalability: AgenticScalabilityTrackRecord[];
}

export interface AgentProfileFileRecord {
  profileId: string;
  path: string;
  name: string;
  description: string;
  tools: string[];
  contextMode: AgenticContextMode;
  maxIterations?: number;
  requiresApproval?: string[];
  surfaces?: AgenticSurface[];
  workspaceKind?: AgenticWorkspaceKind;
}
