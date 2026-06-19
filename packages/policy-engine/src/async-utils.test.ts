import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./async-utils.js";

describe("mapWithConcurrency", () => {
  it("preserves result order while bounding concurrent work", async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([0, 2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
