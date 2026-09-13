import type { PendingApprovalAction } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

type ApprovalOwnerStorage = Pick<AsyncStorage,
  "approvals" | "chatToolRuns" | "chatExecutionPlacements" | "remoteWorkerAssignments">;

/** Ownership is still remote. This is a continuation wait, not a failed tool
 * invocation and never permission to dispatch through the local executor. */
export class RemoteWorkerApprovalResumeRequiredError extends Error {
  constructor() {
    super("Approved remote-worker tools require their resumed worker execution owner; local replay is unavailable.");
    this.name = "RemoteWorkerApprovalResumeRequiredError";
  }
}

/** The ordinary approval worker has no native worker generation/lease authority.
 * A future worker resume owner must retain and recheck that authority itself;
 * an operator approval cannot silently move a remote effect to the local runner. */
export async function assertLocalApprovedActionOwner(
  storage: ApprovalOwnerStorage,
  approvalId: string,
  pending: PendingApprovalAction,
): Promise<void> {
  if (pending.actionType !== "tool.invoke") return;
  const approval = await storage.approvals.get(approvalId);
  const linkage = approval.linkage;
  const request = pending.request;
  const policy = request.policyContext && typeof request.policyContext === "object" && !Array.isArray(request.policyContext)
    ? request.policyContext as Record<string, unknown> : {};
  const refuseRemote = () => {
    throw new RemoteWorkerApprovalResumeRequiredError();
  };
  for (const turnId of identifiers(linkage?.turnId, request.turnId)) {
    const tools = await storage.chatToolRuns.listByTurn(turnId);
    if (tools.some((tool) => tool.approvalId === approvalId && tool.toolRunId.startsWith("remote-tool:"))) refuseRemote();
  }
  for (const runId of identifiers(linkage?.runId, request.runId, policy.runId)) {
    const placement = await storage.chatExecutionPlacements.get(runId);
    if (placement?.executionKind === "remote_worker") refuseRemote();
    // Historical assignments may precede the immutable placement ledger.
    if (linkage?.workspaceId && linkage.sessionId && linkage.turnId &&
      await storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
        executionWorkspaceId: linkage.workspaceId, sessionId: linkage.sessionId,
        turnId: linkage.turnId, durableRunId: runId,
      })) refuseRemote();
  }
}

function identifiers(...values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}
