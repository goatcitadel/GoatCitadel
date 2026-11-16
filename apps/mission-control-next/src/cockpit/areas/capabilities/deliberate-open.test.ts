import { describe, expect, it } from "vitest";
import { PRESS_WINDOW_MS, takePress } from "./deliberate-open";

const press = { key: "skill:a", at: 1000 };

describe("a press that opens a panel", () => {
  it("is taken once by the panel it was for", () => {
    const first = takePress(press, "skill:a", 1500);
    expect(first.took).toBe(true);
    expect(takePress(first.press, "skill:a", 1600).took).toBe(false);
  });

  it("is not taken by another panel, and stays for its own", () => {
    const other = takePress(press, "skill:b", 1500);
    expect(other.took).toBe(false);
    expect(takePress(other.press, "skill:a", 1600).took).toBe(true);
  });

  it("is not taken after the window", () => {
    expect(takePress(press, "skill:a", 1000 + PRESS_WINDOW_MS).took).toBe(false);
  });

  it("is not taken when nothing was pressed (a declined move clears it)", () => {
    expect(takePress(null, "skill:a", 1500).took).toBe(false);
  });
});
