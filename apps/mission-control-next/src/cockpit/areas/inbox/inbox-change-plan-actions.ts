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
    throw new Error("Gateway returned an unexpected change-plan receipt.");
  }
}
