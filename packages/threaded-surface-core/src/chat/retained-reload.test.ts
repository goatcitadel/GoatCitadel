import { describe, expect, it } from "vitest";
import { RETAINED_RELOAD_WINDOW_MS, retainedReloadMode } from "./retained-reload";

describe("retainedReloadMode", () => {
  const load = () => undefined;
  it("loads fresh for new inputs", () => {
    expect(retainedReloadMode(null, ["a", load], 1_000)).toBe("fresh");
    expect(retainedReloadMode({ key: ["a", load], at: 1_000 }, ["b", load], 1_000)).toBe("fresh");
    expect(retainedReloadMode({ key: ["a", load], at: 1_000 }, ["a", () => undefined], 1_000)).toBe("fresh");
  });
  it("skips inside the window and re-reads in the background after it", () => {
    const last = { key: ["a", load], at: 1_000 };
    expect(retainedReloadMode(last, ["a", load], 1_000 + RETAINED_RELOAD_WINDOW_MS - 1)).toBe("skip");
    expect(retainedReloadMode(last, ["a", load], 1_000 + RETAINED_RELOAD_WINDOW_MS)).toBe("background");
  });
});
