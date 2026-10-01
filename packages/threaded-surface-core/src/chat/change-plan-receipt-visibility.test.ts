import { describe, expect, it } from "vitest";
import {
  DISMISSED_CHANGE_PLAN_RECEIPTS_KEY,
  readDismissedChangePlanReceiptKeys,
  shouldShowTerminalChangePlanReceipt,
  writeDismissedChangePlanReceiptKeys,
} from "./change-plan-receipt-visibility";

const now = Date.parse("2026-09-28T12:00:00.000Z");

describe("terminal change-plan receipts", () => {
  it("shows recent terminal plans only until their origin turn is superseded", () => {
    const settledAt = new Date(now - 60_000).toISOString();
    expect(shouldShowTerminalChangePlanReceipt({ originTurnId: "t2", latestTurnId: "t2", settledAt, now })).toBe(true);
    expect(shouldShowTerminalChangePlanReceipt({ originTurnId: "t2", latestTurnId: "t3", settledAt, now })).toBe(false);
  });

  it("does not pin old, future, or undated terminal receipts", () => {
    for (const settledAt of [new Date(now - 11 * 60_000).toISOString(), new Date(now + 60_000).toISOString(), "invalid"]) {
      expect(shouldShowTerminalChangePlanReceipt({ settledAt, now })).toBe(false);
    }
  });

  it("persists only the most recent fifty dismissals", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Storage;
    writeDismissedChangePlanReceiptKeys(new Set(Array.from({ length: 55 }, (_, index) => `plan-${index}`)), storage);
    const restored = readDismissedChangePlanReceiptKeys(storage);
    expect(restored.size).toBe(50);
    expect(restored.has("plan-54")).toBe(true);
    expect(restored.has("plan-0")).toBe(false);
    storage.setItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY, "{bad json");
    expect(readDismissedChangePlanReceiptKeys(storage).size).toBe(0);
  });
});
