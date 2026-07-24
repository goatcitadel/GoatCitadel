import { describe, expect, it } from "vitest";
import {
  DURABLE_RETRY_POLICY_DEFAULT,
  assertDurableRetryPolicyMatchesRun,
  isExactDurableRetryPolicy,
  normalizeDurableRetryPolicy,
} from "./durable-retry-policy.js";

describe("durable retry policy", () => {
  it("normalizes the shared default and clamps every supported bound", () => {
    expect(normalizeDurableRetryPolicy(undefined)).toEqual(DURABLE_RETRY_POLICY_DEFAULT);
    expect(
      normalizeDurableRetryPolicy({
        maxAttempts: 99,
        baseDelayMs: 1,
        maxDelayMs: 1_000_000,
        backoffMultiplier: 0,
      }),
    ).toEqual({
      maxAttempts: 20,
      baseDelayMs: 100,
      maxDelayMs: 900_000,
      backoffMultiplier: 1,
    });
  });

  it("requires an exact policy object and the same run max-attempt authority", () => {
    const expected = normalizeDurableRetryPolicy({ maxAttempts: 5 });
    expect(isExactDurableRetryPolicy({ ...expected }, expected)).toBe(true);
    expect(isExactDurableRetryPolicy({ ...expected, hiddenRetry: true }, expected)).toBe(false);
    expect(() => assertDurableRetryPolicyMatchesRun({ ...expected }, 5, expected)).not.toThrow();
    expect(() => assertDurableRetryPolicyMatchesRun({ ...expected }, 4, expected)).toThrow(
      "does not match its normalized retry authority",
    );
  });
});
