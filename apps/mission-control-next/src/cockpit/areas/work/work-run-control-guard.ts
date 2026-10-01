import type { DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { canRecoverDurableDeadLetter, canRetryDurableRun, sameDurableRecoveryEvidence } from "../../data/durable-run-recovery";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";

export type WorkRunAction = "pause" | "resume" | "cancel" | "retry" | "recover";

/** A stale/scope check for UI requests; the Gateway enforces the actual transition. */
export function canControlWorkRun(
  run: DurableRunRecord,
  action: WorkRunAction,
  workspaceId: string,
  deadLetter?: DurableDeadLetterRecord,
): boolean {
  if (action === "retry") return canRetryDurableRun(run, workspaceId);
  if (action === "recover") return canRecoverDurableDeadLetter(run, deadLetter, workspaceId);
  if (durableRunWorkspaceId(run) !== workspaceId || !Number.isSafeInteger(run.version) || run.version < 0) return false;
  if (action === "resume") return run.status === "paused";
  if (action === "pause") return run.status === "queued" || run.status === "running" || run.status === "waiting";
  return run.status === "queued" || run.status === "running" || run.status === "waiting" || run.status === "paused";
}

export function sameWorkRunEvidence(reviewed: DurableRunRecord, current: DurableRunRecord): boolean {
  return sameDurableRecoveryEvidence({ run: reviewed }, { run: current });
}
