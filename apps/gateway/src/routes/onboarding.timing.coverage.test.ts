import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

describe("onboarding route timing diagnostics", () => {
  const originalTiming = process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (originalTiming === undefined) {
      delete process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING;
    } else {
      process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING = originalTiming;
    }
    vi.resetModules();
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("logs route timing when the module-load debug flag is enabled", async () => {
    process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING = "1";
    vi.resetModules();
    const { onboardingRoutes } = await import("./onboarding.js");
    const getOnboardingState = vi.fn(() => ({ completed: false }));
    app = Fastify();
    app.decorate("services", { onboarding: { getOnboardingState } } as never);
    app.addHook("onRequest", async (request) => {
      request.log.info = vi.fn();
    });
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/onboarding/state",
    });

    expect(response.statusCode).toBe(200);
    expect(getOnboardingState).toHaveBeenCalled();
  });
});
