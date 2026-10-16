import { randomUUID } from "node:crypto";
import type { ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import type {
  ExternalSideEffectProbeResult,
  ExternalSideEffectReplayWorkerResult,
  ExternalSideEffectReplayWorkerSkipReason,
  IdempotentExternalSideEffectRunInput,
} from "./external-side-effect-runner-service.js";

const MAX_PROBE_OUTPUT_KEYS = 16;
const MAX_PROBE_STRING_LENGTH = 512;
const MAX_PROBE_KEY_LENGTH = 64;
const MAX_EXTERNAL_REFERENCE_ID_LENGTH = 256;
const MAX_ERROR_NAME_LENGTH = 64;

const NOT_FOUND_MESSAGE =
  "The provider shows no matching effect; the outcome stays unknown and replay will not resend it.";

export interface CrossedExternalSideEffectReconciliationOptions {
  checkedAt: string;
}

/**
 * Reconciles an `unknown_external_outcome` run that already crossed the external dispatch boundary by
 * asking the owning integration's read-only provider probe whether the effect
 * landed. It never calls `execute`: a crossed run is settled `completed` only
 * on positive provider proof, and otherwise stays unknown for an operator.
 *
 * Returns `undefined` when the job supplies no probe so the worker keeps its
 * historical `external_boundary_already_crossed` skip unchanged.
 */
export async function reconcileCrossedExternalSideEffectRun<TValue>(
  run: ExternalSideEffectRunRecord,
  job: IdempotentExternalSideEffectRunInput<TValue>,
  options: CrossedExternalSideEffectReconciliationOptions,
): Promise<ExternalSideEffectReplayWorkerResult<TValue> | undefined> {
  const { reconcileExternalOutcome, sideEffectRunStore, mutationStore, runClaimTransaction } = job;
  if (!reconcileExternalOutcome) {
    return undefined;
  }
  const markCompletedIfStatus = sideEffectRunStore?.markCompletedIfStatus?.bind(sideEffectRunStore);
  const markReconciledCompleted = mutationStore?.markReconciledCompleted?.bind(mutationStore);
  if (!markCompletedIfStatus || !markReconciledCompleted || !runClaimTransaction) {
    return skip(
      run,
      "job_unavailable",
      "External side-effect reconciliation requires status-guarded completion stores and one transaction owner.",
    );
  }
  if (run.status === "external_call_started") {
    // Its mutation row is still pending/dispatched; the next claim on this
    // identity converges it to unknown_after_send, after which it is reconciled.
    return skip(
      run,
      "external_call_in_flight",
      "The external call has not settled as unknown yet; reconciliation left it alone and will not probe or resend it.",
    );
  }
  if (run.status !== "unknown_external_outcome") {
    return skip(run, "blocked_or_unrecoverable", "External side-effect run is not recoverable by reconciliation.");
  }

  let probe: ExternalSideEffectProbeResult;
  try {
    probe = await reconcileExternalOutcome();
  } catch (error) {
    return skip(
      run,
      "external_outcome_not_found",
      `The provider read probe failed (${readErrorName(error)}); the outcome stays unknown for manual review and replay will not resend it.`,
    );
  }
  if (!isFoundProbe(probe)) {
    return skip(run, "external_outcome_not_found", NOT_FOUND_MESSAGE);
  }

  const externalReferenceId = boundString(probe.externalReferenceId, MAX_EXTERNAL_REFERENCE_ID_LENGTH);
  const reconciliationId = randomUUID();
  let settled: { won: boolean; current: ExternalSideEffectRunRecord };
  try {
    settled = await runClaimTransaction(async () => {
      const current = await markCompletedIfStatus(
        run.runId,
        "unknown_external_outcome",
        {
          replayOutcome: "duplicate",
          ...(externalReferenceId ? { externalReferenceId } : {}),
          responsePayload: {
            ...summarizeProbeOutput(probe.output),
            reconciled: true,
            reconciliationId,
          },
        },
        options.checkedAt,
      );
      if (!wonCompletion(current, reconciliationId)) {
        return { won: false as const, current };
      }
      const mutationSettled = await markReconciledCompleted({
        method: "POST",
        routePath: run.routePath,
        idempotencyKey: run.idempotencyKey,
        actorScope: run.actorScope,
        updatedAt: options.checkedAt,
      });
      if (!mutationSettled) {
        // Throwing rolls the run CAS back so the two ledgers never disagree.
        throw new ReconciliationLedgerMismatchError();
      }
      return { won: true as const, current };
    });
  } catch (error) {
    if (error instanceof ReconciliationLedgerMismatchError) {
      return skip(
        run,
        "blocked_or_unrecoverable",
        "The provider confirmed the effect, but the mutation ledger is not in unknown_after_send; the run stays unknown for manual review and replay will not resend it.",
      );
    }
    throw error;
  }
  if (!settled.won) {
    return skip(
      settled.current,
      "completed",
      "Another owner settled this external side-effect run first; reconciliation did not settle it again.",
    );
  }
  return {
    status: "reconciled",
    run: settled.current,
    ...(externalReferenceId ? { externalReferenceId } : {}),
    message: "The provider confirmed the external effect landed; the run is settled completed without resending it.",
  };
}

class ReconciliationLedgerMismatchError extends Error {
  public constructor() {
    super("External side-effect reconciliation found the mutation ledger outside unknown_after_send.");
    this.name = "ReconciliationLedgerMismatchError";
  }
}

function skip<TValue>(
  run: ExternalSideEffectRunRecord,
  reason: ExternalSideEffectReplayWorkerSkipReason,
  message: string,
): ExternalSideEffectReplayWorkerResult<TValue> {
  return { status: "skipped", run, reason, message };
}

function wonCompletion(current: ExternalSideEffectRunRecord, reconciliationId: string): boolean {
  return current.status === "completed" && current.responsePayload?.reconciliationId === reconciliationId;
}

function isFoundProbe(value: unknown): value is Extract<ExternalSideEffectProbeResult, { found: true }> {
  return typeof value === "object" && value !== null && (value as { found?: unknown }).found === true;
}

function readErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const safe = typeof name === "string" ? name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, MAX_ERROR_NAME_LENGTH) : "";
  return safe || "Error";
}

function boundString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/** Keeps a bounded, primitive-only projection of the probe output. Nested values are dropped. */
function summarizeProbeOutput(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return {};
  }
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (Object.keys(summary).length >= MAX_PROBE_OUTPUT_KEYS) {
      break;
    }
    if (key.length > MAX_PROBE_KEY_LENGTH || key === "reconciled" || key === "reconciliationId") {
      continue;
    }
    if (typeof value === "string") {
      summary[key] = value.slice(0, MAX_PROBE_STRING_LENGTH);
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      summary[key] = value;
    }
  }
  return summary;
}
