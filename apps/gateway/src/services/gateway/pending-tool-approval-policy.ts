import type { ApprovalRequest, ToolPolicyActorContext } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { isRecord } from "../companion-auth-helpers.js";
import { assertLocalApprovedActionOwner } from "../remote-worker-approved-action-guard.js";
import { readAuthActorSource, readPermissionSurfaceValue } from "./external-runtime-approval-adapter.js";

interface PendingToolApprovalPolicyDeps {
  storage: Pick<
    AsyncStorage,
    | "pendingApprovalActions"
    | "approvals"
    | "chatSessionMeta"
    | "chatToolRuns"
    | "chatExecutionPlacements"
    | "remoteWorkerAssignments"
  >;
  defaultWorkspaceId: string;
  resolveToolPolicyContext(input: ToolPolicyActorContext): Promise<ToolPolicyActorContext>;
  resolveScheduledPolicy(approval: ApprovalRequest, request: Record<string, unknown>): Promise<ToolPolicyActorContext>;
}

/** Refresh a pending local tool's scope and return the scheduled replay check, when applicable. */
export async function refreshApprovedPendingToolPolicyContext(
  approvalId: string,
  deps: PendingToolApprovalPolicyDeps,
): Promise<(() => Promise<void>) | undefined> {
  const pending = await deps.storage.pendingApprovalActions.find(approvalId);
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return;
  }
  await assertLocalApprovedActionOwner(deps.storage, approvalId, pending);
  const request = pending.request;
  const existing = isRecord(request.policyContext) ? request.policyContext : {};
  const sessionId = readRecordString(request, "sessionId");
  const workspaceId =
    readRecordString(request, "workspaceId") ??
    readRecordString(existing, "workspaceId") ??
    (sessionId ? (await deps.storage.chatSessionMeta.get(sessionId))?.workspaceId : undefined) ??
    deps.defaultWorkspaceId;
  const consentContext = isRecord(request.consentContext) ? request.consentContext : {};
  const operatorId =
    readRecordString(existing, "operatorId") ??
    readRecordString(consentContext, "operatorId") ??
    readRecordString(existing, "authActorId") ??
    "system";
  const permissionProfileId =
    readRecordString(request, "permissionProfileId") ?? readRecordString(existing, "permissionProfileId");
  const readScheduledPolicy = permissionProfileId?.startsWith("scheduled-intersection:")
    ? async () => deps.resolveScheduledPolicy(await deps.storage.approvals.get(approvalId), request)
    : undefined;
  const resolved = readScheduledPolicy
    ? await readScheduledPolicy()
    : await deps.resolveToolPolicyContext({
        operatorId,
        authActorId: readRecordString(existing, "authActorId"),
        authActorSource: readAuthActorSource(existing.authActorSource),
        workspaceId,
        sessionId,
        taskId: readRecordString(request, "taskId") ?? readRecordString(existing, "taskId"),
        runId: readRecordString(request, "runId") ?? readRecordString(existing, "runId"),
        surface: readPermissionSurfaceValue(request.surface ?? existing.surface),
        permissionProfileId,
        localOperatorOverrideId:
          readRecordString(request, "localOperatorOverrideId") ?? readRecordString(existing, "localOperatorOverrideId"),
      });
  await deps.storage.pendingApprovalActions.upsertPending({
    approvalId,
    actionType: pending.actionType,
    request: {
      ...request,
      workspaceId,
      policyContext: resolved,
    },
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  });
  if (!readScheduledPolicy) return undefined;
  return async () => {
    await readScheduledPolicy();
  };
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
