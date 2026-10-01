import { sanitizeChannelOutboundMessage, type NotificationDeliveryRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ChannelEvidence {
  delivery_id: string;
  connection_id: string;
  target: string;
  payload_json: string | null;
  payload_hash: string;
  status: string;
  delivery_status: string | null;
  attempts: number;
  updated_at: string;
  event_workspace: string;
  event_session: string | null;
  event_turn: string | null;
  event_title: string;
  event_message: string;
  target_workspace: string;
  target_kind: string;
  target_connection: string | null;
  target_revision: number;
}

/** Observe the existing channel journal only; never dispatch or resume a send. */
export function settleNotificationFromChannel(db: DatabaseClient, delivery: NotificationDeliveryRecord): void {
  if (delivery.attemptCount < 1 || delivery.status === "suppressed_present") return;
  if (delivery.idempotencyKey !== `notification:${delivery.eventId}:${delivery.ruleId}:${delivery.targetId}`) return;
  const channelKey = `channel-delivery:effect:${delivery.idempotencyKey}`;
  const evidence = db
    .prepare(
      `
    SELECT q.*, e.workspace_id AS event_workspace, e.session_id AS event_session,
      e.turn_id AS event_turn, e.title AS event_title, e.message AS event_message,
      t.workspace_id AS target_workspace, t.kind AS target_kind,
      t.channel_connection_id AS target_connection, t.revision AS target_revision
    FROM comms_deliveries q
    JOIN notification_events e ON e.event_id = @eventId
    JOIN notification_targets t ON t.target_id = @targetId
    WHERE q.idempotency_key = @channelKey
  `,
    )
    .get<ChannelEvidence>({ eventId: delivery.eventId, targetId: delivery.targetId, channelKey });
  if (!evidence || !matchesNotification(delivery, evidence)) return;
  const settlement = readSettlement(evidence);
  if (!settlement) return;
  const attempts = Math.max(delivery.attemptCount, evidence.attempts);
  if (
    delivery.status === settlement.status &&
    delivery.attemptCount === attempts &&
    delivery.lastError === settlement.error
  )
    return;

  // Both snapshots participate in this CAS. Concurrent readers cannot downgrade
  // a newer projection, and a queue/target change invalidates the observed evidence.
  // The caller's transaction returns the canonical row after this conditional write.
  db.prepare(
    `
    UPDATE notification_deliveries SET status = @status, attempt_count = @attempts,
      last_error = @error, updated_at = @now
    WHERE delivery_id = @deliveryId AND workspace_id = @workspaceId
      AND idempotency_key = @notificationKey AND status = @previousStatus
      AND attempt_count = @previousAttempts AND updated_at = @previousUpdatedAt
      AND EXISTS (SELECT 1 FROM comms_deliveries q WHERE q.delivery_id = @queueId
        AND q.idempotency_key = @channelKey AND q.connection_id = @connectionId
        AND q.payload_hash = @payloadHash AND q.payload_json = @payloadJson
        AND q.status = @queueStatus AND COALESCE(q.delivery_status, '') = @queueDeliveryStatus
        AND q.attempts = @queueAttempts AND q.updated_at = @queueUpdatedAt)
      AND EXISTS (SELECT 1 FROM notification_targets t WHERE t.target_id = @targetId
        AND t.workspace_id = @workspaceId AND t.kind = 'channel_connection'
        AND t.channel_connection_id = @connectionId AND t.revision = @targetRevision)
  `,
  ).run({
    status: settlement.status,
    attempts,
    error: settlement.error ?? null,
    now: new Date().toISOString(),
    deliveryId: delivery.deliveryId,
    workspaceId: delivery.workspaceId,
    notificationKey: delivery.idempotencyKey,
    previousStatus: delivery.status,
    previousAttempts: delivery.attemptCount,
    previousUpdatedAt: delivery.updatedAt,
    queueId: evidence.delivery_id,
    channelKey,
    connectionId: evidence.connection_id,
    payloadHash: evidence.payload_hash,
    payloadJson: evidence.payload_json,
    queueStatus: evidence.status,
    queueDeliveryStatus: evidence.delivery_status ?? "",
    queueAttempts: evidence.attempts,
    queueUpdatedAt: evidence.updated_at,
    targetId: delivery.targetId,
    targetRevision: evidence.target_revision,
  });
}

function matchesNotification(delivery: NotificationDeliveryRecord, evidence: ChannelEvidence): boolean {
  if (
    evidence.event_workspace !== delivery.workspaceId ||
    evidence.target_workspace !== delivery.workspaceId ||
    evidence.target_kind !== "channel_connection" ||
    evidence.target_connection !== evidence.connection_id ||
    !Number.isSafeInteger(evidence.attempts) ||
    evidence.attempts < 0
  )
    return false;
  let payload: unknown;
  try {
    payload = JSON.parse(evidence.payload_json ?? "null");
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const input = payload as Record<string, unknown>;
  if (
    input.effectId !== delivery.idempotencyKey ||
    input.workspaceId !== delivery.workspaceId ||
    input.connectionId !== evidence.connection_id ||
    input.target !== evidence.target ||
    input.operatorId !== "notification-routing" ||
    (input.sessionId ?? null) !== evidence.event_session ||
    (input.taskId ?? null) !== evidence.event_turn
  )
    return false;
  // The existing channel owner sanitizes and may split a notification. Compare
  // its complete sanitized text, without persisting or returning any queue body.
  const parts = input.messageParts;
  if (
    parts !== undefined &&
    (!Array.isArray(parts) ||
      parts.length < 1 ||
      parts.length > 128 ||
      parts.some((part) => typeof part !== "string") ||
      input.message !== parts[0])
  )
    return false;
  const message = Array.isArray(parts) ? parts.join("") : input.message;
  return message === sanitizeChannelOutboundMessage(`${evidence.event_title}\n\n${evidence.event_message}`).message;
}

function readSettlement(
  evidence: ChannelEvidence,
): { status: NotificationDeliveryRecord["status"]; error?: string } | undefined {
  if (evidence.status === "sent" && evidence.delivery_status === "sent") return { status: "delivered" };
  if (evidence.status === "failed") {
    if (evidence.delivery_status === "manual_reconciliation_required")
      return {
        status: "unknown_after_send",
        error: "Channel delivery requires manual reconciliation; it may have been sent.",
      };
    if (["blocked", "degraded", "not_available"].includes(evidence.delivery_status ?? ""))
      return {
        status: "failed",
        error: "Channel delivery failed or was blocked. Inspect channel delivery evidence.",
      };
  }
  if (evidence.status === "queued") {
    if (evidence.delivery_status === "waiting_approval")
      return { status: "pending", error: "Channel delivery is awaiting approval." };
    if (evidence.delivery_status === "retrying" || evidence.delivery_status === null) return { status: "pending" };
  }
  return undefined;
}
