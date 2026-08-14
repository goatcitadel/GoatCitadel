/** Canonical lifecycle for one Chat-native `agent.fanout` aggregate. */
export type ChatFanoutInvocationStatus =
  | "reserving"
  | "reserved"
  | "dispatching"
  | "waiting"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked";

/**
 * Immutable admission bindings plus the aggregate's durable progress. The
 * child details themselves remain canonical in chat_delegation_runs/steps;
 * this record is the exact parent-tool invocation bridge that makes the two
 * systems recoverable without an in-memory registry.
 */
export interface ChatFanoutInvocationRecord {
  invocationId: string;
  parentRunId: string;
  toolRunId: string;
  delegationRunId?: string;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  status: ChatFanoutInvocationStatus;
  childCount: number;
  /** Immutable, bounded child plan used only to reconstruct a crashed aggregate. */
  subtasks: Array<{ objective: string; label?: string; expectedOutput?: string }>;
  grantId: string;
  reservedActivations: number;
  reservedBudgetUsd: number;
  /** Bounded operator objective retained only as canonical run context. */
  objective: string;
  /** Frozen, secret-free capability profile digest. */
  capabilityProfileHash?: string;
  /** Frozen, secret-free policy profile digest. */
  policyProfileHash?: string;
  /** Frozen binding of the active project identity/revision. */
  projectBindingHash: string;
  /** Frozen authority binding; recovery still rechecks live grant status. */
  grantBindingHash: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  terminalReason?: string;
}

export interface ChatFanoutInvocationCreateResult {
  invocation: ChatFanoutInvocationRecord;
  created: boolean;
}

export interface ChatFanoutInvocationDetail {
  invocation: ChatFanoutInvocationRecord;
  children: Array<{
    stepId: string;
    index: number;
    label?: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    summary?: string;
    output?: string;
    error?: string;
    durableRunId?: string;
    childSessionId?: string;
    childTurnId?: string;
  }>;
}
