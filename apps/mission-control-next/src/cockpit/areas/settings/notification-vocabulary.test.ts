import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENT_TYPES } from "@goatcitadel/contracts";
import { NOTIFICATION_EVENT_TYPE_LABELS } from "./notification-vocabulary";

describe("notification event labels (U-ST-013)", () => {
  it("covers every event type with a plain label", () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const label = NOTIFICATION_EVENT_TYPE_LABELS[type];
      expect(label, type).toBeTruthy();
      expect(label).not.toMatch(/[_.]/);
    }
    expect(Object.keys(NOTIFICATION_EVENT_TYPE_LABELS).sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
  });
});
