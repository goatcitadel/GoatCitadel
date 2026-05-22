import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { updateScoutRoutes } from "./update-scout.js";

describe("update scout routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns read-only advisory update scout reports", async () => {
    const scout = vi.fn(() => ({
      generatedAt: "2026-05-22T00:00:00.000Z",
      workspaceId: "default",
      appliedUpdates: false,
      items: [
        {
          sourceRef: "https://clawhub.ai/maximeprades/auto-updater",
          sourceType: "skill",
          compatibilityNotes: ["Review before adoption."],
          risk: "medium",
          recommendedProofLanes: ["skill import review policy test"],
          status: "degraded",
          message: "No update probe or install action was performed.",
        },
      ],
      warnings: ["Update Scout is read-only and did not apply any updates."],
    }));
    app = Fastify();
    app.decorate("services", { updateScout: { scout } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(updateScoutRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/update-scout/reports",
      payload: {
        sources: [{ sourceRef: "https://clawhub.ai/maximeprades/auto-updater", currentVersion: "1.0.0" }],
        workspaceId: "default",
        createImprovementCandidate: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(scout).toHaveBeenCalledWith({
      sources: [{ sourceRef: "https://clawhub.ai/maximeprades/auto-updater", currentVersion: "1.0.0" }],
      workspaceId: "default",
      createImprovementCandidate: true,
    });
    expect(response.json()).toMatchObject({
      appliedUpdates: false,
      warnings: [expect.stringContaining("did not apply")],
    });
  });
});
