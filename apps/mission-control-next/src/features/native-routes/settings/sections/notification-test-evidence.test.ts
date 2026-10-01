import { beforeEach, expect, it } from "vitest";
import type { NotificationDeliveryRecord } from "@goatcitadel/contracts";
import {
  __resetNotificationTestEvidenceForTests,
  readNotificationTestEvidence,
  retainNotificationTestEvidence,
} from "./notification-test-evidence";
const pending: NotificationDeliveryRecord = {
  deliveryId: "one",
  eventId: "event",
  targetId: "target",
  workspaceId: "workspace",
  ruleId: "operator_test",
  idempotencyKey: "notification:event:operator_test:target",
  status: "pending",
  attemptCount: 1,
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
};
beforeEach(__resetNotificationTestEvidenceForTests);
it("rejects a stale mounted observer after another view settles the same delivery", () => {
  retainNotificationTestEvidence("installation-workspace", pending, true);
  const delivered = { ...pending, status: "delivered" as const, updatedAt: "2026-09-30T12:00:01.000Z" };
  retainNotificationTestEvidence("installation-workspace", delivered);
  retainNotificationTestEvidence("installation-workspace", pending);
  expect(readNotificationTestEvidence("installation-workspace", "target")).toEqual(delivered);
  const next = {
    ...pending,
    deliveryId: "two",
    eventId: "next",
    idempotencyKey: "notification:next:operator_test:target",
  };
  retainNotificationTestEvidence("installation-workspace", next, true);
  retainNotificationTestEvidence("installation-workspace", delivered);
  expect(readNotificationTestEvidence("installation-workspace", "target")).toEqual(next);
});
it("does not replace an unresolved test with another delivery", () => {
  retainNotificationTestEvidence("installation-workspace", pending, true);
  retainNotificationTestEvidence("installation-workspace", { ...pending, deliveryId: "other" }, true);
  expect(readNotificationTestEvidence("installation-workspace", "target")).toEqual(pending);
});
