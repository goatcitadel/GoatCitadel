import {
  canonicalJsonString,
  CHANGE_PLAN_STATUSES,
  type ChangePlanRecord,
  type OperatorInboxItem,
  type OperatorInboxResponse,
} from "@goatcitadel/contracts";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import {
  canConfirmInboxChangePlan,
  currentInboxChangePlan,
  hasCurrentInboxChangePlanItem,
} from "./inbox-change-plan-guard";
import { inboxMatchesWorkspace } from "./inbox-presentation";

/**
 * The plan, still in this workspace's Inbox. Opening the detail checks the cached Inbox; confirming
 * re-reads the Inbox once (no `cached`) so it never acts on a superseded item.
 */
export async function readCurrentInboxPlan(
  item: OperatorInboxItem,
  workspaceId: string,
  cached?: OperatorInboxResponse,
): Promise<ChangePlanRecord | null> {
  if (!item.source.planId) return null;
  const projection = cached ?? (await fetchOperatorInbox(workspaceId));
  if (!hasCurrentInboxChangePlanItem(item, projection, workspaceId)) return null;
  const plan = await fetchChangePlan(item.source.planId, {
    workspaceId,
    sessionId: item.source.sessionId,
    turnId: item.source.turnId,
  });
  return currentInboxChangePlan(item, projection, plan, workspaceId) ?? null;
}

const SETTLED_STATUSES = new Set<ChangePlanRecord["status"]>([
  "completed",
  "applied",
  "cancelled",
  "failed",
  "manual_required",
  "rolled_back",
  "rollback_failed",
]);

/**
 * How a plan ended once it left this workspace's current Inbox, read once from its owner with the item's own
 * identity, so the detail can say "Applied" instead of "may have been applied or cancelled" (#496). A foreign
 * projection, a plan still listed, a different conversation or a plan still in progress gives nothing.
 */
export async function readSettledInboxPlan(
  item: OperatorInboxItem,
  workspaceId: string,
): Promise<ChangePlanRecord | null> {
  const planId = item.source.planId;
  if (
    item.kind !== "change_plan" ||
    !planId ||
    item.id !== `change_plan:${planId}` ||
    item.source.workspaceId !== workspaceId
  )
    return null;
  const projection = await fetchOperatorInbox(workspaceId);
  if (projection.authority !== "derived_projection" || !inboxMatchesWorkspace(projection, workspaceId)) return null;
  if (projection.items.some((entry) => entry.id === item.id)) return null;
  const plan = await fetchChangePlan(planId, {
    workspaceId,
    sessionId: item.source.sessionId,
    turnId: item.source.turnId,
  });
  const sameRecord =
    plan.planId === planId &&
    plan.origin.workspaceId === workspaceId &&
    plan.origin.sessionId === item.source.sessionId &&
    plan.origin.turnId === item.source.turnId;
  return sameRecord && SETTLED_STATUSES.has(plan.status) ? plan : null;
}

export function canReviewInboxConfirmation(plan: ChangePlanRecord | null | undefined): plan is ChangePlanRecord {
  return Boolean(
    plan &&
    canConfirmInboxChangePlan(plan) &&
    plan.schemaVersion === 1 &&
    Number.isSafeInteger(plan.revision) &&
    plan.revision > 0 &&
    plan.kind === plan.request?.kind &&
    plan.intentHash?.trim() &&
    plan.adapter?.adapterId?.trim() &&
    Number.isSafeInteger(plan.adapter.version) &&
    plan.adapter.version > 0 &&
    plan.target?.ownerId?.trim() &&
    plan.target.resourceId?.trim() &&
    plan.requiredAction?.actionId?.trim() &&
    plan.requiredAction.actionNonce?.trim(),
  );
}

function immutableBinding(plan: ChangePlanRecord) {
  return canonicalJsonString({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    origin: plan.origin,
    adapter: plan.adapter,
    kind: plan.kind,
    scope: plan.scope,
    request: plan.request,
    intentHash: plan.intentHash,
    target: plan.target,
    createdAt: plan.createdAt,
  });
}

export function requireInboxConfirmationReceipt(reviewed: ChangePlanRecord, receipt: ChangePlanRecord) {
  if (
    !receipt ||
    immutableBinding(receipt) !== immutableBinding(reviewed) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision <= reviewed.revision ||
    !CHANGE_PLAN_STATUSES.includes(receipt.status) ||
    receipt.requiredAction?.actionNonce === reviewed.requiredAction?.actionNonce
  ) {
    throw new Error("The saved result did not match the reviewed change plan.");
  }
}
