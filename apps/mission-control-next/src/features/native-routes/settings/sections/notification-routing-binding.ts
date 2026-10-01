import {
  canonicalJsonString,
  type NotificationRule,
  type NotificationRuleInput,
  type NotificationTarget,
  type NotificationTargetInput,
  type NotificationTargetKind,
} from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export const emptyNotificationTarget = (kind: NotificationTargetKind = "channel_connection") => ({
  label: "",
  kind,
  channelConnectionId: "",
  webhookUrlSecretRef: "",
  credentialSecretRef: "",
});
export const emptyNotificationRule = (): NotificationRuleInput => ({
  label: "",
  eventTypes: [
    "turn.failed",
    "turn.blocked",
    "approval.requested",
    "user_input.requested",
    "durable.attention_required",
    "timer.due",
    "scheduled_turn.failed",
  ],
  targetIds: [],
  deliveryPolicy: "when_away",
});
export const sameNotificationValue = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
export function notificationTargetInput(value: NotificationTargetInput): NotificationTargetInput {
  return {
    label: value.label.trim(),
    kind: value.kind,
    lifecycleState: value.lifecycleState ?? "active",
    ...(value.kind === "channel_connection"
      ? { channelConnectionId: value.channelConnectionId?.trim() }
      : {
          webhookUrlSecretRef: value.webhookUrlSecretRef?.trim(),
          ...(value.credentialSecretRef?.trim() ? { credentialSecretRef: value.credentialSecretRef.trim() } : {}),
        }),
  };
}
export function notificationRuleInput(value: NotificationRuleInput): NotificationRuleInput {
  return {
    label: value.label.trim(),
    eventTypes: [...new Set(value.eventTypes)],
    targetIds: [...new Set(value.targetIds.map((id) => id.trim()))],
    deliveryPolicy: value.deliveryPolicy ?? "always",
    lifecycleState: value.lifecycleState ?? "active",
  };
}
export function assertNotificationReceipt<T extends NotificationTarget | NotificationRule>(
  receipt: T,
  workspaceId: string,
  input: NotificationTargetInput | NotificationRuleInput,
  before?: T,
) {
  const isTarget = "kind" in input;
  const id = isTarget ? (receipt as NotificationTarget)?.targetId : (receipt as NotificationRule)?.ruleId;
  const priorId = before && ("targetId" in before ? before.targetId : before.ruleId);
  if (
    !receipt ||
    receipt.workspaceId !== workspaceId ||
    !id ||
    (before && id !== priorId) ||
    receipt.revision !== (before ? before.revision + 1 : 1) ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    (before && receipt.createdAt !== before.createdAt) ||
    !sameNotificationValue(
      isTarget
        ? notificationTargetInput(receipt as NotificationTarget)
        : notificationRuleInput(receipt as NotificationRule),
      input,
    )
  ) {
    throw new Error("The notification owner did not acknowledge the exact reviewed configuration.");
  }
}
export function notificationConflictRejected(
  error: unknown,
  kind: "target" | "rule",
  id: string,
  expectedRevision: number,
) {
  if (
    !isApiRequestError(error) ||
    error.status !== 409 ||
    error.method !== "PATCH" ||
    error.path !== `/api/v1/notifications/${kind}s/${encodeURIComponent(id)}`
  )
    return false;
  const body = error.body as
    | {
        code?: string;
        committed?: boolean;
        mutationCommitted?: boolean;
        details?: {
          resourceKind?: string;
          resourceId?: string;
          expectedRevision?: number;
          committed?: boolean;
          mutationCommitted?: boolean;
        };
      }
    | undefined;
  return (
    body?.code === "WRITE_CONFLICT" &&
    body.details?.resourceKind === `notification_${kind}` &&
    body.details.resourceId === id &&
    body.details.expectedRevision === expectedRevision &&
    !body.committed &&
    !body.mutationCommitted &&
    !body.details.committed &&
    !body.details.mutationCommitted
  );
}
