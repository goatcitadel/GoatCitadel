import { describe, expect, it } from "vitest";
import { decideNotificationDelivery } from "./notification-policy";
import type { DerivedRealtimeNotification } from "./realtime-derived";

const LIVE = { replayed: false, pageFocused: true } as const;
const approval: DerivedRealtimeNotification = {
  tone: "warning",
  message: "Approval waiting",
  groupKey: "approval-1",
  truthMode: "authoritative",
  attentionKind: "approval_waiting",
};

describe("decideNotificationDelivery", () => {
  it("never interrupts for replayed or generic refresh events", () => {
    expect(decideNotificationDelivery(approval, { ...LIVE, replayed: true }).toast).toBe(false);
    expect(decideNotificationDelivery({ ...approval, attentionKind: "conversation_update" }, LIVE).toast).toBe(false);
    expect(decideNotificationDelivery({ ...approval, attentionKind: "activity_update" }, LIVE).sound).toBe(false);
  });

  it("keeps transport status in the stream indicator", () => {
    for (const groupKey of ["connection-interrupted", "connection-restored", "stream-replay-gap"]) {
      expect(decideNotificationDelivery({ ...approval, groupKey }, LIVE)).toEqual({
        toast: false,
        sound: false,
        desktop: false,
      });
    }
  });

  it("interrupts for decisions and problems, with desktop decisions only in the background", () => {
    expect(decideNotificationDelivery(approval, LIVE)).toEqual({ toast: true, sound: true, desktop: false });
    expect(decideNotificationDelivery(approval, { ...LIVE, pageFocused: false })).toEqual({
      toast: true,
      sound: true,
      desktop: true,
    });
    expect(decideNotificationDelivery({ ...approval, attentionKind: "run_failed" }, LIVE)).toEqual({
      toast: true,
      sound: true,
      desktop: false,
    });
  });

  it("shows completions and Gateway-authored notices quietly", () => {
    for (const attentionKind of ["run_completed", "handoff_ready"] as const) {
      expect(decideNotificationDelivery({ ...approval, attentionKind }, LIVE)).toEqual({
        toast: true,
        sound: false,
        desktop: false,
      });
    }
    expect(decideNotificationDelivery({ ...approval, attentionKind: "activity_update", groupKey: "ui-timer_due" }, LIVE).toast).toBe(true);
  });

  it("keeps the visible conversation quiet", () => {
    expect(decideNotificationDelivery(approval, { ...LIVE, eventSessionId: "s1", visibleSessionId: "s1" }).toast).toBe(false);
    expect(decideNotificationDelivery(approval, { ...LIVE, eventSessionId: "s1", visibleSessionId: "s2" }).toast).toBe(true);
  });
});
