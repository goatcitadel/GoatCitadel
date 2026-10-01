import { describe, expect, it } from "vitest";
import { isChangePlanResult, isProviderProfileCheckpoint } from "./change-plan.js";

describe("provider profile checkpoint wire shape", () => {
  const checkpoint = {
    version: "provider_profile_checkpoint.v1",
    providerId: "fixture",
    originalRevision: 7,
    appliedRevision: 8,
    intentHash: "a".repeat(64),
  };
  it("accepts a bounded public commit witness and existing result shapes", () => {
    expect(
      isChangePlanResult({ summary: "Profile committed", appliedRevision: 8, providerProfileCheckpoint: checkpoint }),
    ).toBe(true);
    expect(isChangePlanResult({ summary: "Legacy result" })).toBe(true);
  });
  it("rejects credentials, unrelated fields, invalid hashes and nonmonotonic revisions", () => {
    for (const invalid of [
      { ...checkpoint, apiKey: "not-a-real-credential" },
      { ...checkpoint, appliedRevision: 7 },
      { ...checkpoint, originalRevision: 0 },
      { ...checkpoint, providerId: "" },
      { ...checkpoint, intentHash: "wrong" },
      { ...checkpoint, version: "unsupported" },
    ]) {
      expect(isProviderProfileCheckpoint(invalid)).toBe(false);
      expect(isChangePlanResult({ summary: "Invalid", providerProfileCheckpoint: invalid })).toBe(false);
    }
  });
});
