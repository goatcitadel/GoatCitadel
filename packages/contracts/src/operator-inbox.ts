import type { ChangePlanStatus } from "./change-plan.js";

/** Read-only, workspace-scoped view of canonical operator decisions and attention. */
export type OperatorInboxGroup = "needs_decision" | "proposals" | "needs_attention" | "updates";

export type OperatorInboxKind =
  | "approval"
  | "user_input"
  | "change_plan"
  | "memory_proposal"
  | "document_proposal"
  | "capability_proposal"
  | "improvement_proposal"
  | "failed_run"
  | "dead_letter"
  | "runtime_health"
  | "backup_trust"
  | "spend_coverage"
  | "task_deliverable"
  | "completed_background_run";

export interface OperatorInboxItem {
  /** Stable projection key. The owning record remains authoritative. */
  id: string;
  /** Server-authored public update content version; absent on decisions. */
  version?: string;
  read?: boolean;
  kind: OperatorInboxKind;
  group: OperatorInboxGroup;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  source: {
    workspaceId: string;
    sessionId?: string;
    turnId?: string;
    promptId?: string;
    runId?: string;
    deadLetterId?: string;
    approvalId?: string;
    planId?: string;
    planRevision?: number;
    planStatus?: ChangePlanStatus;
    proposalId?: string;
    taskId?: string;
    deliverableId?: string;
  };
  /** A link into the canonical owner. Actions are never applied to this projection. */
  href: string;
}

/** Limited is a declared scope or freshness limit; partial means an expected read was incomplete. */
export type OperatorInboxSourceState = "current" | "limited" | "not_enabled" | "partial" | "unavailable";

export interface OperatorInboxSourceCoverage {
  source: string;
  state: OperatorInboxSourceState;
  detail?: string;
  /** Installation-wide inspection identity; absence or missing identity never verifies a manifest. */
  backupTrust?: {
    state: "verified" | "stale" | "failed" | "none" | "unknown";
    backupId?: string;
    createdAt?: string;
    observedAt: string;
  };
}

export interface OperatorInboxCount {
  known: number;
  /** False means `known` is a lower bound, never a definitive zero. */
  complete: boolean;
}

export interface OperatorInboxResponse {
  readStatus?: OperatorInboxReadStatus;
  authority: "derived_projection";
  workspaceId: string;
  generatedAt: string;
  items: OperatorInboxItem[];
  coverage: OperatorInboxSourceCoverage[];
  counts: Record<OperatorInboxGroup, OperatorInboxCount>;
}

export interface OperatorInboxReadStatus {
  scope: "operator" | "browser_local" | "unavailable";
  /** Opaque actor/workspace binding, never a credential. */
  scopeId?: string;
}
export interface OperatorInboxUpdateReference {
  id: string;
  version: string;
}
export interface OperatorInboxReadResponse {
  readStatus: OperatorInboxReadStatus;
  acknowledged: OperatorInboxUpdateReference[];
  skipped: Array<OperatorInboxUpdateReference & { reason: "not_current" | "unavailable" | "browser_local" }>;
}
