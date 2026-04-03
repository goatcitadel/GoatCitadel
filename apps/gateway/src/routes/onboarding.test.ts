import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardingRoutes } from "./onboarding.js";

describe("onboarding routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns onboarding state", async () => {
    const getOnboardingState = vi.fn(() => ({
      completed: false,
      checklist: [],
      settings: {
        llm: { providers: [], activeProviderId: "", activeModel: "" },
        auth: { allowLoopbackBypass: true },
        mesh: { enabled: false, mode: "lan", nodeId: "", mdns: true, staticPeers: [], requireMtls: false, tailnetEnabled: false },
        defaultToolProfile: "standard",
        budgetMode: "balanced",
        networkAllowlist: [],
      },
    }));
    app = Fastify();
    app.decorate("gateway", { getOnboardingState } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/onboarding/state",
    });

    expect(response.statusCode).toBe(200);
    expect(getOnboardingState).toHaveBeenCalledTimes(1);
  });

  it("returns lightweight onboarding startup state", async () => {
    const getOnboardingStartupState = vi.fn(() => ({
      completed: true,
      completedAt: "2026-04-03T00:00:00.000Z",
      completedBy: "mission-control",
    }));
    app = Fastify();
    app.decorate("gateway", { getOnboardingStartupState } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/onboarding/startup",
    });

    expect(response.statusCode).toBe(200);
    expect(getOnboardingStartupState).toHaveBeenCalledTimes(1);
  });

  it("validates bootstrap payloads", async () => {
    const bootstrapOnboarding = vi.fn();
    app = Fastify();
    app.decorate("gateway", { bootstrapOnboarding } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        llm: {
          upsertProvider: {
            providerId: "glm",
            baseUrl: "not-a-url",
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(bootstrapOnboarding).not.toHaveBeenCalled();
  });

  it("marks onboarding complete", async () => {
    const markOnboardingComplete = vi.fn(() => ({ completed: true }));
    app = Fastify();
    app.decorate("gateway", { markOnboardingComplete } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      payload: {
        completedBy: "operator",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(markOnboardingComplete).toHaveBeenCalledWith("operator");
  });
});
