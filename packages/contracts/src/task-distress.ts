export type TaskDistressSignalCode =
  | "needs_user"
  | "tool_error"
  | "provider_outage"
  | "hallucination_suspected"
  | "stale_heartbeat"
  | "worker_crash"
  | "artifact_missing"
  | "retry_budget_exhausted";

export type TaskDistressSeverity = "info" | "warn" | "critical";

export interface TaskDistressSignal {
  signalId: string;
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface TaskRetryBudget {
  maxRetries: number;
  retryCount: number;
  lastAttemptAt?: string;
  exhaustedAt?: string;
}

export type TaskArtifactClaimKind = "file" | "url" | "commit_sha";

export interface TaskArtifactClaim {
  kind: TaskArtifactClaimKind;
  value: string;
  label?: string;
}

export type TaskArtifactVerificationStatus = "unchecked" | "verified" | "missing" | "error";

export interface TaskArtifactVerification {
  claim: TaskArtifactClaim;
  status: TaskArtifactVerificationStatus;
  checkedAt: string;
  detail?: string;
}
