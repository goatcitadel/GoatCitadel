import type { ChangePlanRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { inboxMatchesWorkspace } from "./inbox-presentation";

const ATTENTION_STATUSES = new Set<ChangePlanRecord["status"]>(["manual_required", "failed", "rollback_failed"]);
const WAITING_STATUSES = new Set<ChangePlanRecord["status"]>(["awaiting_input", "awaiting_confirmation", "awaiting_approval"]);

export function currentInboxChangePlan(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  plan: ChangePlanRecord,
  workspaceId: string,
): ChangePlanRecord | undefined {
  if (!hasCurrentInboxChangePlanItem(item, projection, workspaceId)
    || plan.planId !== item.source.planId || plan.origin.workspaceId !== workspaceId
    || plan.revision !== item.source.planRevision || plan.status !== item.source.planStatus
    || plan.origin.sessionId !== item.source.sessionId || plan.origin.turnId !== item.source.turnId
    || plan.createdAt !== item.createdAt || plan.updatedAt !== item.updatedAt
    || plan.expiresAt !== item.expiresAt || plan.risk !== item.riskLevel) return undefined;
  const group = ATTENTION_STATUSES.has(plan.status) ? "needs_attention"
    : WAITING_STATUSES.has(plan.status) ? "needs_decision" : undefined;
  return group === item.group ? plan : undefined;
}

export function hasCurrentInboxChangePlanItem(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  workspaceId: string,
): boolean {
  const planId = item.source.planId;
  if (item.kind !== "change_plan" || !planId || !item.source.planRevision || !item.source.planStatus
    || item.id !== `change_plan:${planId}`
    || item.source.workspaceId !== workspaceId || projection.authority !== "derived_projection"
    || !inboxMatchesWorkspace(projection, workspaceId)) return false;
  const currentItem = projection.items.find((entry) => entry.id === item.id);
  return Boolean(currentItem && JSON.stringify(currentItem) === JSON.stringify(item));
}

export function canConfirmInboxChangePlan(plan: ChangePlanRecord | undefined): boolean {
  if (!plan || plan.status !== "awaiting_confirmation" || plan.requiredAction?.kind !== "confirmation") return false;
  if (!plan.expiresAt) return true;
  const expiresAt = Date.parse(plan.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
