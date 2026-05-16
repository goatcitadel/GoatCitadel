import { describe, expect, it } from "vitest";
import { computeChildDepth, enforceMaxDepth, runWithChildTimeout } from "./subagent-budget-enforcer.js";

describe("computeChildDepth", () => {
  it("returns 1 when no parent depth is provided", () => {
    expect(computeChildDepth(undefined)).toBe(1);
  });
  it("returns parentDepth + 1", () => {
    expect(computeChildDepth(3)).toBe(4);
  });
});

describe("enforceMaxDepth", () => {
  it("returns nothing when depth is within budget", () => {
    expect(() => enforceMaxDepth({ depth: 2, maxDepth: 4 })).not.toThrow();
  });
  it("throws max_depth_exceeded when depth equals or exceeds maxDepth", () => {
    expect(() => enforceMaxDepth({ depth: 4, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
    expect(() => enforceMaxDepth({ depth: 5, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
  });
});

describe("runWithChildTimeout", () => {
  it("returns the operation result when it resolves before the timeout", async () => {
    const result = await runWithChildTimeout({
      timeoutSeconds: 1,
      run: async () => "ok",
    });
    expect(result).toBe("ok");
  });
  it("rejects with timeout_exceeded when the operation runs past the timeout", async () => {
    await expect(
      runWithChildTimeout({
        timeoutSeconds: 0.05,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "late";
        },
      }),
    ).rejects.toThrowError(/timeout_exceeded/);
  });
});
