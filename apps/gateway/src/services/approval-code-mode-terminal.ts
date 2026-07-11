import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ApprovalLifecycleHost } from "./approval-lifecycle-service.js";

export function markCodeModeRunTerminalForPendingApproval(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  pendingAction: ReturnType<ApprovalLifecycleHost["storage"]["pendingApprovalActions"]["find"]>,
  status: "rejected" | "expired",
  details: Record<string, unknown>,
): { runId?: string; pendingRunId?: string | null } | undefined {
  if (!pendingAction || pendingAction.actionType !== "code_mode.run" || pendingAction.resolutionStatus !== "pending") {
    return undefined;
  }
  const pendingRunId = readStringValue(pendingAction.request.runId);
  const approvalRunId = resolveCodeModeApprovalRunId(approval);
  const runId = approvalRunId ?? pendingRunId;
  if (!runId) {
    if (status !== "expired") {
      return undefined;
    }
    return markExpiredCodeModePendingActionWithoutRunUpdate(host, approval, pendingAction, details, {
      errorCode: "code_mode_run_id_missing",
      pendingRunId: null,
    });
  }
  const existing = host.storage.codeModeRuns.find(runId);
  if (!existing || existing.status !== "approval_pending") {
    if (status !== "expired") {
      return undefined;
    }
    return markExpiredCodeModePendingActionWithoutRunUpdate(host, approval, pendingAction, details, {
      errorCode: existing ? "code_mode_run_not_approval_pending" : "code_mode_run_missing",
      runId,
      pendingRunId: pendingRunId && pendingRunId !== runId ? pendingRunId : undefined,
    });
  }
  if (existing.approvalId !== approval.approvalId) {
    if (status !== "expired") {
      return undefined;
    }
    return markExpiredCodeModePendingActionWithoutRunUpdate(host, approval, pendingAction, details, {
      errorCode: "code_mode_approval_mismatch",
      runId,
      pendingRunId: pendingRunId && pendingRunId !== runId ? pendingRunId : undefined,
      actualApprovalId: existing.approvalId,
    });
  }
  const finishedAt = new Date().toISOString();
  const pendingRunIdDetail = pendingRunId === runId ? undefined : { pendingRunId: pendingRunId ?? null };
  host.storage.codeModeRuns.upsert({
    ...existing,
    status,
    error: typeof details.reason === "string" ? details.reason : undefined,
    errorDetails: {
      phase: "approval_resolution",
      ...details,
      ...(pendingRunIdDetail ?? {}),
    },
    finishedAt,
  });
  if (status === "expired") {
    host.storage.pendingApprovalActions.markResolved(pendingAction.approvalId, "failed", {
      ...details,
      status,
      runId,
      ...(pendingRunIdDetail ?? {}),
    });
    appendCodeModePendingActionRefused(host, approval, {
      ...details,
      actionType: "code_mode.run",
      runId,
      status,
      approvalStatus: approval.status,
      approvalExpiresAt: approval.expiresAt,
      pendingExpiresAt: pendingAction.expiresAt,
      ...(pendingRunIdDetail ?? {}),
    });
    enqueueCodeModeExpirationRealtime(host, approval, {
      runId,
      approvalId: approval.approvalId,
      status,
      error: typeof details.reason === "string" ? details.reason : "Code Mode approval expired before execution.",
      errorDetails: {
        phase: "approval_resolution",
        ...details,
        ...(pendingRunIdDetail ?? {}),
      },
    });
  }
  return {
    runId,
    ...(pendingRunIdDetail ? { pendingRunId: pendingRunId ?? null } : {}),
  };
}

function markExpiredCodeModePendingActionWithoutRunUpdate(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  pendingAction: ReturnType<ApprovalLifecycleHost["storage"]["pendingApprovalActions"]["find"]>,
  details: Record<string, unknown>,
  skipDetails: { errorCode: string; runId?: string; pendingRunId?: string | null; actualApprovalId?: string },
): { runId?: string; pendingRunId?: string | null } | undefined {
  if (!pendingAction || pendingAction.actionType !== "code_mode.run" || pendingAction.resolutionStatus !== "pending") {
    return undefined;
  }
  const payload = {
    ...details,
    status: "expired",
    runUpdateSkipped: true,
    errorCode: skipDetails.errorCode,
    ...(skipDetails.runId ? { runId: skipDetails.runId } : {}),
    ...(skipDetails.pendingRunId !== undefined ? { pendingRunId: skipDetails.pendingRunId } : {}),
    ...(skipDetails.actualApprovalId ? { actualApprovalId: skipDetails.actualApprovalId } : {}),
  };
  host.storage.pendingApprovalActions.markResolved(pendingAction.approvalId, "failed", payload);
  appendCodeModePendingActionRefused(host, approval, {
    ...payload,
    actionType: "code_mode.run",
    approvalStatus: approval.status,
    approvalExpiresAt: approval.expiresAt,
    pendingExpiresAt: pendingAction.expiresAt,
  });
  enqueueCodeModeExpirationRealtime(host, approval, {
    approvalId: approval.approvalId,
    status: "expired",
    error: typeof details.reason === "string" ? details.reason : "Code Mode approval expired before execution.",
    errorCode: skipDetails.errorCode,
    ...(skipDetails.runId ? { runId: skipDetails.runId } : {}),
    ...(skipDetails.pendingRunId !== undefined ? { pendingRunId: skipDetails.pendingRunId } : {}),
  });
  return {
    ...(skipDetails.runId ? { runId: skipDetails.runId } : {}),
    ...(skipDetails.pendingRunId !== undefined ? { pendingRunId: skipDetails.pendingRunId } : {}),
  };
}

function appendCodeModePendingActionRefused(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  payload: Record<string, unknown>,
): void {
  host.storage.approvalEvents.append({
    approvalId: approval.approvalId,
    eventType: "pending_action_refused",
    actorId: "system",
    payload,
  });
}

function enqueueCodeModeExpirationRealtime(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  payload: Record<string, unknown>,
): void {
  const runId = readStringValue(payload.runId);
  const errorCode = readStringValue(payload.errorCode);
  host.enqueueApprovalObservabilityEffects(approval.approvalId, [
    {
      operationId: `code_mode.expired.realtime:${runId ?? errorCode ?? "approval"}`,
      delivery: {
        kind: "realtime",
        eventType: "code_mode_run_failed",
        source: "approvals",
        payload,
        options: {
          eventClass: "domain_fact",
          eventAuthority: "durable_history",
          links: {
            approvalId: approval.approvalId,
            ...(runId ? { runId } : {}),
            ...(approval.linkage?.sessionId ? { sessionId: approval.linkage.sessionId } : {}),
            ...(approval.linkage?.turnId ? { turnId: approval.linkage.turnId } : {}),
            ...(approval.linkage?.taskId ? { taskId: approval.linkage.taskId } : {}),
            ...(approval.linkage?.durableRunId ? { durableRunId: approval.linkage.durableRunId } : {}),
          },
          correlationId: approval.approvalId,
        },
      },
    },
  ]);
}

function resolveCodeModeApprovalRunId(approval: ApprovalRequest): string | undefined {
  return (
    readStringValue(approval.linkage?.runId) ??
    readStringValue((approval.linkage as Record<string, unknown> | undefined)?.codeModeRunId) ??
    readStringValue(approval.payload.runId)
  );
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
