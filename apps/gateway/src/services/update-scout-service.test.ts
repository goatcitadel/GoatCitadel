import { describe, expect, it } from "vitest";
import { UpdateScoutService } from "./update-scout-service.js";

describe("UpdateScoutService", () => {
  it("normalizes update sources into read-only advisory reports", () => {
    const service = new UpdateScoutService();

    const report = service.scout({
      workspaceId: "goatcitadel",
      sources: [
        { sourceRef: "https://clawhub.ai/maximeprades/auto-updater", currentVersion: "old" },
        { sourceRef: "https://github.com/example/repo" },
        { sourceRef: "@scope/package" },
      ],
      createImprovementCandidate: true,
    });

    expect(report).toMatchObject({
      workspaceId: "goatcitadel",
      appliedUpdates: false,
    });
    expect(report.items).toEqual([
      expect.objectContaining({
        sourceType: "skill",
        currentVersion: "old",
        status: "degraded",
        recommendedProofLanes: expect.arrayContaining(["skill import review policy test"]),
      }),
      expect.objectContaining({
        sourceType: "repo",
        recommendedProofLanes: expect.arrayContaining(["pnpm typecheck"]),
      }),
      expect.objectContaining({
        sourceType: "package",
        recommendedProofLanes: expect.arrayContaining(["dependency audit review"]),
      }),
    ]);
    expect(report.warnings.join(" ")).toContain("did not apply any updates");
  });
});
