import { describe, expect, it } from "vitest";
import { deriveSetupProgress } from "./setup-progress";

describe("deriveSetupProgress", () => {
  it("does not complete a later step while connection is stale", () => {
    expect(deriveSetupProgress({ providerReady: false, defaultPlanCompleted: false, firstResponseVerified: true })).toEqual({
      steps: ["active", "pending", "pending"],
      firstResponseLabel: "Verified before · recheck the connection",
      needsRecheck: true,
    });
  });

  it("walks through the three steps in order", () => {
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: false, firstResponseVerified: false }).steps).toEqual(["complete", "active", "pending"]);
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: true, firstResponseVerified: false })).toMatchObject({ steps: ["complete", "complete", "active"], firstResponseLabel: "Not yet" });
    expect(deriveSetupProgress({ providerReady: true, defaultPlanCompleted: true, firstResponseVerified: true })).toMatchObject({ steps: ["complete", "complete", "complete"], firstResponseLabel: "Verified", needsRecheck: false });
  });
});
