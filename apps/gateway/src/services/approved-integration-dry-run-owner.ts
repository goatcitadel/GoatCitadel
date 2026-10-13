import { randomUUID } from "node:crypto";
import type { PendingApprovalAction, ToolInvokeResult } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { isRecord } from "./companion-auth-helpers.js";
import { toolInvokeResultRecord } from "./gateway/external-runtime-approval-adapter.js";
import { approveDryRun } from "./dry-run-commit-service.js";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";

export interface ApprovedIntegrationDryRunHost {
  storage: Pick<AsyncStorage, "pendingApprovalActions" | "approvalEvents" | "approvals" | "dryRunCommits">;
  actionHost: IntegrationActionHost;
}

/** The integration action owner still reconstructs and verifies the approved hash before dispatch. */
export async function executeApprovedIntegrationDryRunCommit(
  host: ApprovedIntegrationDryRunHost,
  approvalId: string,
  pending: PendingApprovalAction,
): Promise<ToolInvokeResult | undefined> {
  const request = pending.request;
  const dryRunId = readRecordString(request, "dryRunId");
  const connectionId = readRecordString(request, "connectionId");
  const actionId = readRecordString(request, "actionId");
  const invokeRequest = isRecord(request.invokeRequest) ? request.invokeRequest : {};
  const finish = async (result: ToolInvokeResult): Promise<ToolInvokeResult> => {
    await host.storage.pendingApprovalActions.markResolved(
      approvalId,
      result.outcome === "executed" ? "executed" : "failed",
      toolInvokeResultRecord(result),
    );
    await host.storage.approvalEvents.append({
      approvalId,
      eventType: "approved_action_executed",
      actorId: "system",
      payload: {
        actionType: "integration.dry_run_commit",
        outcome: result.outcome,
        policyReason: result.policyReason,
        dryRunId,
        connectionId,
        actionId,
      },
    });
    return result;
  };
  if (!dryRunId || !connectionId || !actionId) {
    return finish({
      outcome: "blocked",
      policyReason:
        "Approved dry-run commit is missing its linkage (dryRunId/connectionId/actionId); nothing was executed.",
      auditEventId: randomUUID(),
    });
  }
  let approvedBy = "operator";
  try {
    approvedBy = (await host.storage.approvals.get(approvalId)).resolvedBy ?? "operator";
  } catch {
    // Keep the fallback actor; the commit still verifies against the approved hash.
  }
  await approveDryRun(host.storage.dryRunCommits, dryRunId, {
    approvedBy,
    approvedAt: new Date().toISOString(),
  });
  try {
    const idempotencyKey = readRecordString(invokeRequest, "idempotencyKey");
    const actionResult = await invokeIntegrationConnectionAction(
      host.actionHost,
      connectionId,
      actionId,
      {
        input: isRecord(invokeRequest.input) ? invokeRequest.input : {},
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      { dryRunCommit: { dryRunId, approvedBy } },
    );
    return finish({
      outcome: actionResult.status === "executed" ? "executed" : "blocked",
      policyReason: actionResult.message,
      auditEventId: randomUUID(),
      result: {
        connectionId,
        actionId,
        dryRunId,
        status: actionResult.status,
        ...(actionResult.blockedReason ? { blockedReason: actionResult.blockedReason } : {}),
        ...(actionResult.output ? { output: actionResult.output } : {}),
      },
    });
  } catch (error) {
    return finish({
      outcome: "blocked",
      policyReason:
        error instanceof Error ? error.message : "Approved dry-run commit failed before reaching the boundary.",
      auditEventId: randomUUID(),
    });
  }
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
