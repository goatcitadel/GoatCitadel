import { describe, expect, it } from "vitest";
import type { OperatorInboxItem, OperatorInboxResponse, RealtimeEvent } from "@goatcitadel/contracts";
import type { DerivedRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { inboxItemLocation, resolveInboxNotificationItem } from "./inbox-notification";

const item: OperatorInboxItem = { id: "approval:a/1", kind: "approval", group: "needs_decision", title: "Review write",
  summary: "Review the current owner", createdAt: "2026-09-30T00:00:00Z", source: { workspaceId: "w", approvalId: "a" }, href: "/ops/approvals" };
const projection = { authority: "derived_projection", workspaceId: "w", items: [item] } as OperatorInboxResponse;
const event: RealtimeEvent = { eventId: "e", sequence: 1, eventType: "approval_created", source: "approvals",
  timestamp: "2026-09-30T00:00:00Z", payload: {}, links: { approvalId: "a" }, eventAuthority: "retained_stream" };
const notice: DerivedRealtimeNotification = { tone: "warning", message: "signal", groupKey: "approval-a", truthMode: "authoritative", attentionKind: "approval_waiting" };
describe("Inbox notification owner selection", () => {
  it("uses the exact projected item and encodes its deep link", () => {
    expect(resolveInboxNotificationItem(projection, event, notice, "w")).toBe(item);
    expect(inboxItemLocation(item)).toBe("/inbox?workspaceId=w&item=approval%3Aa%2F1");
  });
  it("withholds absent, ambiguous, foreign and expired items", () => {
    for (const items of [[], [item, { ...item, id: "duplicate" }], [{ ...item, source: { ...item.source, workspaceId: "foreign" } }],
      [{ ...item, expiresAt: "2000-01-01" }], [{ ...item, expiresAt: "invalid" }]]) {
      expect(resolveInboxNotificationItem({ ...projection, items }, event, notice, "w")).toBeUndefined();
    }
    expect(resolveInboxNotificationItem({ ...projection, workspaceId: "foreign" }, event, notice, "w")).toBeUndefined();
  });
  it("never fills missing or conflicting event links from payload or guesses", () => {
    for (const links of [undefined, {}, { approvalId: "other" }, { approvalId: "a", sessionId: "unbound" },
      { approvalId: "a", workspaceId: "foreign" }, { approvalId: "a", turnId: "unbound" }]) {
      expect(resolveInboxNotificationItem(projection, { ...event, links, payload: { approvalId: "a" } }, notice, "w")).toBeUndefined();
    }
    expect(resolveInboxNotificationItem(projection, { ...event, eventAuthority: "durable_history" }, notice, "w")).toBeUndefined();
  });
  it("requires the current owner kind for a linked run", () => {
    const runItem = { ...item, kind: "failed_run" as const, source: { workspaceId: "w", runId: "r" } };
    const runEvent = { ...event, links: { durableRunId: "r" } };
    const failure = { ...notice, attentionKind: "run_failed" as const };
    expect(resolveInboxNotificationItem({ ...projection, items: [runItem] }, runEvent, failure, "w")).toBe(runItem);
    expect(resolveInboxNotificationItem({ ...projection, items: [runItem] }, runEvent, { ...failure, attentionKind: "run_completed" }, "w")).toBeUndefined();
    expect(resolveInboxNotificationItem({ ...projection, items: [runItem] }, { ...runEvent, links: { runId: "x", durableRunId: "r" } }, failure, "w")).toBeUndefined();
  });
  it("does not assign a generic runtime notice to an unrelated Inbox item", () => {
    expect(resolveInboxNotificationItem(projection, event, { ...notice, attentionKind: "runtime_degraded" }, "w")).toBeUndefined();
  });
});
