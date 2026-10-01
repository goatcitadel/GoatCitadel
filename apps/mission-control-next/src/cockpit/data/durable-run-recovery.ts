import type { DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { durableRunWorkspaceId } from "./durable-run-scope";

export interface DurableRunRecoveryEvidence {
  run: DurableRunRecord;
  deadLetter?: DurableDeadLetterRecord;
}

/** UI eligibility only. Gateway workflow policy and durable state remain authoritative. */
export function canRetryDurableRun(run: DurableRunRecord, workspaceId: string): boolean {
  const admittedChat = run.workflowKey === "chat.turn.execute" && run.payload.version === "chat.turn.execute.v2";
  return durableRunWorkspaceId(run) === workspaceId && Number.isSafeInteger(run.version) && run.version >= 0
    && run.status === "failed" && !admittedChat
    && Number.isSafeInteger(run.attemptCount) && Number.isSafeInteger(run.maxAttempts)
    && run.attemptCount < run.maxAttempts;
}

export function canRecoverDurableDeadLetter(
  run: DurableRunRecord,
  letter: DurableDeadLetterRecord | undefined,
  workspaceId: string,
): boolean {
  return Boolean(letter && durableRunWorkspaceId(run) === workspaceId
    && Number.isSafeInteger(run.version) && run.version >= 0
    && run.status === "dead_lettered" && Number.isSafeInteger(run.attemptCount) && run.attemptCount < 20
    && letter.runId === run.runId && !letter.resolvedAt);
}

export function sameDurableRecoveryEvidence(
  reviewed: DurableRunRecoveryEvidence,
  current: DurableRunRecoveryEvidence,
): boolean {
  return reviewed.run.runId === current.run.runId
    && reviewed.run.version === current.run.version
    && reviewed.run.status === current.run.status
    && reviewed.run.updatedAt === current.run.updatedAt
    && reviewed.run.attemptCount === current.run.attemptCount
    && reviewed.run.maxAttempts === current.run.maxAttempts
    && reviewed.deadLetter?.deadLetterId === current.deadLetter?.deadLetterId
    && reviewed.deadLetter?.createdAt === current.deadLetter?.createdAt
    && reviewed.deadLetter?.resolvedAt === current.deadLetter?.resolvedAt;
}
