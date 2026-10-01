import { useEffect, useSyncExternalStore } from "react";
import type { NotificationDeliveryRecord, NotificationDispatchResult } from "@goatcitadel/contracts";
import { sameNotificationValue } from "./notification-routing-binding";

const observations = new Map<string, ReadonlyMap<string, NotificationDeliveryRecord>>();
const EMPTY = new Map<string, NotificationDeliveryRecord>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = (key: string) => observations.get(key) ?? EMPTY;
const validStatus = (status: string) =>
  ["pending", "delivered", "failed", "suppressed_present", "unknown_after_send"].includes(status);
export const notificationTestUnsettled = (delivery?: NotificationDeliveryRecord) =>
  delivery?.status === "pending" || delivery?.status === "unknown_after_send";
export const notificationTestPending = (key: string, targetId: string) =>
  notificationTestUnsettled(snapshot(key).get(targetId));

export function assertNotificationTestReceipt(
  result: NotificationDispatchResult,
  workspaceId: string,
  targetId: string,
) {
  const delivery = result.deliveries?.[0];
  if (
    !result.event?.eventId ||
    result.event.workspaceId !== workspaceId ||
    result.event.source !== "operator_test" ||
    result.deliveries.length !== 1 ||
    !delivery?.deliveryId ||
    delivery.idempotencyKey !== `notification:${result.event.eventId}:operator_test:${targetId}` ||
    delivery.eventId !== result.event.eventId ||
    delivery.targetId !== targetId ||
    delivery.workspaceId !== workspaceId ||
    delivery.ruleId !== "operator_test" ||
    result.status !== delivery.status ||
    !validStatus(delivery.status) ||
    !Number.isSafeInteger(delivery.attemptCount) ||
    delivery.attemptCount < 0 ||
    !Number.isFinite(Date.parse(delivery.createdAt)) ||
    !Number.isFinite(Date.parse(delivery.updatedAt)) ||
    Date.parse(delivery.updatedAt) < Date.parse(delivery.createdAt)
  ) {
    throw new Error(
      "The notification test outcome is unconfirmed. Inspect delivery evidence before sending another test.",
    );
  }
  return delivery;
}

/** A fresh read may advance queued delivery state; its original identity cannot change. */
export function notificationDeliveryObservationMatches(
  before: NotificationDeliveryRecord,
  after?: NotificationDeliveryRecord,
): after is NotificationDeliveryRecord {
  if (
    !after ||
    !validStatus(after.status) ||
    !Number.isSafeInteger(after.attemptCount) ||
    after.attemptCount < before.attemptCount ||
    !Number.isFinite(Date.parse(after.updatedAt)) ||
    Date.parse(after.updatedAt) < Date.parse(before.updatedAt)
  )
    return false;
  const identity = ({
    status: _status,
    attemptCount: _attempts,
    lastError: _error,
    updatedAt: _updated,
    ...record
  }: NotificationDeliveryRecord) => record;
  return (
    sameNotificationValue(identity(before), identity(after)) &&
    (before.status === "pending" ||
      (before.status === "unknown_after_send" && after.status !== "pending") ||
      before.status === after.status)
  );
}

export const readNotificationTestEvidence = (key: string, targetId: string) => snapshot(key).get(targetId);
export function retainNotificationTestEvidence(key: string, delivery: NotificationDeliveryRecord, newTest = false) {
  const current = readNotificationTestEvidence(key, delivery.targetId);
  if (
    current &&
    (current.deliveryId === delivery.deliveryId
      ? !notificationDeliveryObservationMatches(current, delivery)
      : !newTest || notificationTestUnsettled(current))
  )
    return;
  const next = new Map(snapshot(key));
  next.set(delivery.targetId, structuredClone(delivery));
  observations.set(key, next);
  for (const listener of listeners) listener();
}
export function useNotificationTestEvidence(key: string, deliveries: NotificationDeliveryRecord[]) {
  const records = useSyncExternalStore(
    subscribe,
    () => snapshot(key),
    () => EMPTY,
  );
  useEffect(() => {
    for (const before of records.values()) {
      const after = deliveries.find((item) => item.deliveryId === before.deliveryId);
      if (notificationDeliveryObservationMatches(before, after) && !sameNotificationValue(before, after)) {
        retainNotificationTestEvidence(key, after);
      }
    }
  }, [key, deliveries, records]);
  return {
    testDelivery: (targetId: string) => records.get(targetId),
    testPending: (targetId: string) => notificationTestUnsettled(records.get(targetId)),
  };
}
export function __resetNotificationTestEvidenceForTests() {
  observations.clear();
  for (const listener of listeners) listener();
}
