import type { OperatorInboxItem } from "@goatcitadel/contracts";
import {
  canRecoverDurableDeadLetter,
  canRetryDurableRun,
  sameDurableRecoveryEvidence,
  type DurableRunRecoveryEvidence,
} from "../../data/durable-run-recovery";

export type RunRecoveryEvidence = DurableRunRecoveryEvidence;

/** A client-side stale/scope guard; the Gateway owner still decides whether recovery is allowed. */
export function canRequestRunRecovery(item: OperatorInboxItem, evidence: RunRecoveryEvidence, workspaceId: string): boolean {
  const { run, deadLetter } = evidence;
  if (item.source.workspaceId !== workspaceId || !item.source.runId || item.source.runId !== run.runId) return false;
  if (item.kind === "failed_run") {
    return item.updatedAt === run.updatedAt && canRetryDurableRun(run, workspaceId);
  }
  if (item.kind === "dead_letter") {
    return Boolean(item.source.deadLetterId && deadLetter
      && deadLetter.deadLetterId === item.source.deadLetterId
      && deadLetter.createdAt === item.createdAt
      && canRecoverDurableDeadLetter(run, deadLetter, workspaceId));
  }
  return false;
}

export const sameRunRecoveryEvidence = sameDurableRecoveryEvidence;
