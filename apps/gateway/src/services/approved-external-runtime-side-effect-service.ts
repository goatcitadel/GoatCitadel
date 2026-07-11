import { randomUUID } from "node:crypto";
import type { PendingApprovalAction, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

const APPROVED_EXTERNAL_RUNTIME_IN_PROGRESS_STALE_MS = 5 * 60 * 1000;
const inFlightByStorage = new WeakMap<object, Map<string, Promise<ToolInvokeResult>>>();

export interface ApprovedExternalRuntimeSideEffectInput {
  storage: Pick<
    Storage,
    | "approvalEvents"
    | "externalSideEffectRuns"
    | "mutationIdempotency"
    | "pendingApprovalActions"
    | "runImmediateTransaction"
  >;
  approvalId: string;
  request: ToolInvokeRequest;
  execute(markExternalCallStarted: () => void): Promise<ToolInvokeResult>;
}

export async function executeApprovedExternalRuntimeSideEffect(
  input: ApprovedExternalRuntimeSideEffectInput,
): Promise<ToolInvokeResult> {
  const storageKey = input.storage as object;
  const inFlight = inFlightByStorage.get(storageKey) ?? new Map<string, Promise<ToolInvokeResult>>();
  inFlightByStorage.set(storageKey, inFlight);
  const existing = inFlight.get(input.approvalId);
  if (existing) {
    return existing;
  }
  const execution = executeApprovedExternalRuntimeSideEffectOnce(input);
  inFlight.set(input.approvalId, execution);
  try {
    return await execution;
  } finally {
    // This invocation is the only writer for the key until its promise settles;
    // concurrent callers return the same promise above.
    inFlight.delete(input.approvalId);
  }
}

async function executeApprovedExternalRuntimeSideEffectOnce(
  input: ApprovedExternalRuntimeSideEffectInput,
): Promise<ToolInvokeResult> {
  const sideEffect = await runIdempotentExternalSideEffect({
    mutationStore: input.storage.mutationIdempotency,
    sideEffectRunStore: input.storage.externalSideEffectRuns,
    runClaimTransaction: (work) => input.storage.runImmediateTransaction(work),
    workspaceId: input.request.workspaceId ?? input.request.policyContext?.workspaceId ?? "default",
    boundary: "approved_external_runtime",
    catalogId: input.request.toolName,
    actionId: input.approvalId,
    actorScope: input.request.workspaceId ?? input.request.policyContext?.workspaceId ?? "default",
    idempotencyKey: `approved-external-runtime:${input.approvalId}`,
    checkedAt: new Date().toISOString(),
    payload: {
      approvalId: input.approvalId,
      toolName: input.request.toolName,
      args: input.request.args ?? {},
      sessionId: input.request.sessionId,
      taskId: input.request.taskId,
      runId: input.request.runId ?? input.request.policyContext?.runId,
    },
    label: `Approved external runtime action ${input.approvalId}`,
    output: {
      approvalId: input.approvalId,
      toolName: input.request.toolName,
    },
    requireDurableBoundaryRecord: true,
    execute: async (claim) => {
      const result = await input.execute(claim.markExternalCallStarted);
      if (!claim.externalCallStarted) {
        claim.markExternalCallNotRequired();
      }
      return result;
    },
    commitCompleted: (claim, result) => commitApprovedResult(input, claim, result),
  });

  if (sideEffect.status === "executed") {
    return sideEffect.value;
  }

  const persisted = input.storage.pendingApprovalActions.find(input.approvalId);
  if (persisted?.resolutionStatus && persisted.resolutionStatus !== "pending") {
    return toolInvokeResultFromPendingAction(persisted);
  }

  if (sideEffect.status === "failed" && sideEffect.claim.resumeState === "manual_retry_after_recorded_failure") {
    throw sideEffect.error;
  }

  const reconciledResumeState =
    sideEffect.claim.resumeState === "in_progress"
      ? resolveManualReconciliationState(input, sideEffect.claim)
      : undefined;
  if (sideEffect.claim.resumeState === "in_progress" && !reconciledResumeState) {
    const settled = input.storage.pendingApprovalActions.find(input.approvalId);
    if (settled?.resolutionStatus && settled.resolutionStatus !== "pending") {
      return toolInvokeResultFromPendingAction(settled);
    }
    throw new Error(`Approved external runtime action ${input.approvalId} is already executing on another worker.`);
  }

  const replayState = reconciledResumeState ?? sideEffect.claim.resumeState;
  const result: ToolInvokeResult = {
    outcome: "blocked",
    policyReason:
      `Approved external runtime outcome requires manual reconciliation; automatic replay was blocked ` +
      `(${replayState}).`,
    auditEventId: randomUUID(),
    result: {
      approvalId: input.approvalId,
      externalRuntime: true,
      manualReconciliationRequired: true,
      replayOutcome: sideEffect.claim.replayOutcome,
      resumeState: replayState,
      sideEffectRunId: sideEffect.claim.sideEffectRunId,
    },
  };
  return persistManualReconciliation(input, result);
}

function commitApprovedResult(
  input: ApprovedExternalRuntimeSideEffectInput,
  claim: {
    routePath: string;
    idempotencyKey: string;
    actorScope: string;
    sideEffectRunId?: string;
  },
  result: ToolInvokeResult,
): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      input.storage.runImmediateTransaction(() => {
        const pending = input.storage.pendingApprovalActions.find(input.approvalId);
        const terminalMatches = Boolean(
          pending && pending.resolutionStatus !== "pending" && pendingResultMatches(pending, result),
        );
        if (pending?.resolutionStatus !== "pending" && !terminalMatches) {
          throw new Error(`Approved action ${input.approvalId} already has conflicting terminal truth.`);
        }
        input.storage.mutationIdempotency.markCompleted({
          method: "POST",
          routePath: claim.routePath,
          idempotencyKey: claim.idempotencyKey,
          actorScope: claim.actorScope,
          updatedAt: new Date().toISOString(),
        });
        if (claim.sideEffectRunId) {
          input.storage.externalSideEffectRuns.markCompleted(
            claim.sideEffectRunId,
            { responsePayload: toolInvokeResultRecord(result) },
            new Date().toISOString(),
          );
        }
        if (!terminalMatches) {
          input.storage.pendingApprovalActions.markResolved(
            input.approvalId,
            result.outcome === "executed" ? "executed" : "failed",
            toolInvokeResultRecord(result),
          );
          appendApprovedActionEvent(input, result);
        }
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Approved external runtime result commit failed.");
}

function persistManualReconciliation(
  input: ApprovedExternalRuntimeSideEffectInput,
  result: ToolInvokeResult,
): ToolInvokeResult {
  let resolved = result;
  input.storage.runImmediateTransaction(() => {
    const pending = input.storage.pendingApprovalActions.find(input.approvalId);
    if (pending && pending.resolutionStatus !== "pending") {
      resolved = toolInvokeResultFromPendingAction(pending);
      return;
    }
    input.storage.pendingApprovalActions.markResolved(input.approvalId, "failed", toolInvokeResultRecord(result));
    appendApprovedActionEvent(input, result);
  });
  return resolved;
}

function appendApprovedActionEvent(input: ApprovedExternalRuntimeSideEffectInput, result: ToolInvokeResult): void {
  input.storage.approvalEvents.append({
    approvalId: input.approvalId,
    eventType: "approved_action_executed",
    actorId: "system",
    payload: {
      toolName: input.request.toolName,
      outcome: result.outcome,
      policyReason: result.policyReason,
      auditEventId: result.auditEventId,
      externalRuntime: true,
    },
  });
}

function pendingResultMatches(pending: PendingApprovalAction, result: ToolInvokeResult): boolean {
  return (
    pending.result?.outcome === result.outcome &&
    pending.result?.auditEventId === result.auditEventId &&
    pending.resolutionStatus === (result.outcome === "executed" ? "executed" : "failed")
  );
}

function resolveManualReconciliationState(
  input: ApprovedExternalRuntimeSideEffectInput,
  claim: { sideEffectRunId?: string },
): "manual_review_unknown_external_outcome" | undefined {
  if (!claim.sideEffectRunId) {
    return undefined;
  }
  const run = input.storage.externalSideEffectRuns.get(claim.sideEffectRunId);
  if (run.status === "unknown_external_outcome") {
    return "manual_review_unknown_external_outcome";
  }
  if (run.status === "claimed_not_sent" && isStaleSideEffectRun(run.updatedAt)) {
    const reconciled = input.storage.externalSideEffectRuns.markFailureIfStatus(
      run.runId,
      "claimed_not_sent",
      {
        status: "unknown_external_outcome",
        errorText:
          "Approved external runtime stale pre-boundary claim lost its execution owner; automatic replay is blocked.",
      },
      new Date().toISOString(),
    );
    return reconciled.status === "unknown_external_outcome" ? "manual_review_unknown_external_outcome" : undefined;
  }
  if (run.status !== "external_call_started") {
    return undefined;
  }
  if (!isStaleSideEffectRun(run.updatedAt)) {
    return undefined;
  }
  const reconciled = input.storage.externalSideEffectRuns.markFailureIfStatus(
    run.runId,
    "external_call_started",
    {
      status: "unknown_external_outcome",
      errorText:
        "Approved external runtime crossed the external boundary but lost its execution owner; automatic replay is blocked.",
    },
    new Date().toISOString(),
  );
  return reconciled.status === "unknown_external_outcome" ? "manual_review_unknown_external_outcome" : undefined;
}

function isStaleSideEffectRun(updatedAtValue: string): boolean {
  const updatedAt = Date.parse(updatedAtValue);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= APPROVED_EXTERNAL_RUNTIME_IN_PROGRESS_STALE_MS;
}

function toolInvokeResultFromPendingAction(pending: PendingApprovalAction): ToolInvokeResult {
  const result = pending.result ?? {};
  const outcome = result.outcome === "executed" || result.outcome === "blocked" ? result.outcome : "blocked";
  return {
    outcome,
    policyReason:
      typeof result.policyReason === "string"
        ? result.policyReason
        : `Approved external runtime action is already ${pending.resolutionStatus ?? "resolved"}.`,
    auditEventId: typeof result.auditEventId === "string" ? result.auditEventId : randomUUID(),
    result: isRecord(result.result) ? result.result : undefined,
  };
}

function toolInvokeResultRecord(result: ToolInvokeResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    policyReason: result.policyReason,
    auditEventId: result.auditEventId,
    result: result.result,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
