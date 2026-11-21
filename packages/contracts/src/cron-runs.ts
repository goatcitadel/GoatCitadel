import type { CronJobAction } from "./monitoring.js";

/** Canonical execution state for one admitted cron occurrence. */
export type CronRunStatus =
  | "admitting"
  | "admitted"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_lettered"
  | "manual_reconciliation_required";

export type CronRunActiveStatus = Extract<CronRunStatus, "admitting" | "admitted" | "running" | "waiting">;
export type CronRunTerminalStatus = Exclude<CronRunStatus, CronRunActiveStatus>;
export type CronRunPhase = "child_admission" | "chat_execution" | "autonomous_post_commit" | "delivery" | "settlement";
export type CronRunTrigger = "scheduled_due" | "manual" | "forced";

export interface CronRunLinkage {
  childSessionId?: string;
  childMessageId?: string;
  childTurnId?: string;
  childAssistantMessageId?: string;
  childDurableRunId?: string;
  deliveryRunId?: string;
  externalSideEffectRunId?: string;
  evidenceEnvelopeId?: string;
}

export interface CronRunRecord extends CronRunLinkage {
  runId: string;
  jobId: string;
  admissionKey: string;
  executionGeneration: number;
  trigger: CronRunTrigger;
  jobRevision: number;
  action: CronJobAction;
  actionSnapshot: Record<string, unknown>;
  scheduledFor: string;
  status: CronRunStatus;
  phase: CronRunPhase;
  outcome?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  reconciliationReason?: string;
  reconciliationResolution?: string;
  createdAt: string;
  updatedAt: string;
  admittedAt?: string;
  startedAt?: string;
  settledAt?: string;
  reconciledAt?: string;
  reconciledBy?: string;
}

export interface CronRunExecutionToken {
  runId: string;
  jobId: string;
  executionGeneration: number;
}

export interface CronRunBeginInput {
  runId?: string;
  jobId: string;
  admissionKey: string;
  scheduledFor: string;
  trigger?: CronRunTrigger;
  /** Exact operator/event-reviewed spec; rechecked under the canonical occurrence lock. */
  expectedJobRevision?: number;
  /** Last execution reviewed by the operator, checked under the job lock. */
  expectedExecutionGeneration?: number;
  /** Server-authored operator identity, frozen with the occurrence for exact retries. */
  operatorAction?: CronOperatorAction;
  /** Internal verified-event reference, frozen alongside the job action. Not a public mutation argument. */
  eventSource?: CronEventSource;
}

export interface CronOperatorAction {
  actorId: string;
  operationId: string;
  expectedExecutionGeneration: number;
}

export interface CronEventSource {
  eventId: string;
  eventType: "subagent.end";
  workspaceId: string;
  sourceConnectionId: string;
  payloadHash: string;
}

export type CronRunBeginResult =
  | { outcome: "begun"; run: CronRunRecord }
  | { outcome: "duplicate"; run: CronRunRecord }
  | { outcome: "blocked"; activeRun: CronRunRecord };

export function isCronRunTerminalStatus(status: CronRunStatus): status is CronRunTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "dead_lettered" ||
    status === "manual_reconciliation_required"
  );
}
