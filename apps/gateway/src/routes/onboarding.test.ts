import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
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
        mesh: {
          enabled: false,
          mode: "lan",
          nodeId: "",
          mdns: true,
          staticPeers: [],
          requireMtls: false,
          tailnetEnabled: false,
        },
        defaultToolProfile: "standard",
        budgetMode: "balanced",
        networkAllowlist: [],
      },
    }));
    app = Fastify();
    app.decorate("services", { onboarding: { getOnboardingState } } as never);
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
    app.decorate("services", { onboarding: { getOnboardingStartupState } } as never);
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
    app.decorate("services", { onboarding: { bootstrapOnboarding } } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        expectedRevision: 6,
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

  it("rejects invalid TLS combinations in bootstrap payloads", async () => {
    const bootstrapOnboarding = vi.fn();
    app = Fastify();
    app.decorate("services", { onboarding: { bootstrapOnboarding } } as never);
    await app.register(onboardingRoutes);

    const mismatchedClientCert = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        expectedRevision: 6,
        llm: {
          upsertProvider: {
            providerId: "local",
            request: {
              tls: {
                clientCertPath: "client.crt",
              },
            },
          },
        },
      },
    });
    const conflictingCaMode = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        expectedRevision: 6,
        llm: {
          upsertProvider: {
            providerId: "local",
            request: {
              tls: {
                caCertPath: "ca.crt",
                insecureSkipVerify: true,
              },
            },
          },
        },
      },
    });

    expect(mismatchedClientCert.statusCode).toBe(400);
    expect(conflictingCaMode.statusCode).toBe(400);
    expect(bootstrapOnboarding).not.toHaveBeenCalled();
  });

  it("accepts explicit env-backed provider persistence in bootstrap payloads", async () => {
    const bootstrapOnboarding = vi.fn((input) => input);
    app = Fastify();
    app.decorate("services", { onboarding: { bootstrapOnboarding } } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        expectedRevision: 6,
        llm: {
          upsertProvider: {
            providerId: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test-value",
            apiKeyEnv: "OPENAI_API_KEY",
            persistSecretToSecureStore: false,
            request: {
              proxy: {
                url: "http://proxy.internal:8080",
                auth: { type: "bearer", tokenEnv: "PROXY_TOKEN" },
                tls: { serverName: "proxy.internal" },
              },
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(bootstrapOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        llm: expect.objectContaining({
          upsertProvider: expect.objectContaining({
            persistSecretToSecureStore: false,
            request: expect.objectContaining({
              proxy: expect.objectContaining({
                url: "http://proxy.internal:8080",
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("maps bootstrap service failures to bad requests", async () => {
    const bootstrapOnboarding = vi.fn(() => {
      throw new ValidationError({ message: "bootstrap rejected" });
    });
    app = Fastify();
    app.decorate("services", { onboarding: { bootstrapOnboarding } } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: {
        expectedRevision: 6,
        budgetMode: "balanced",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "bootstrap rejected", code: "FIELD_INVALID" });
  });

  it("returns 409 and does not enter bootstrap mutation for a stale revision", async () => {
    const runtimeMutation = vi.fn();
    const bootstrapOnboarding = vi.fn(() => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Settings changed after this client loaded them.",
        details: { expectedRevision: 4, currentRevision: 5 },
      });
    });
    app = Fastify();
    app.decorate("services", { onboarding: { bootstrapOnboarding } } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/bootstrap",
      payload: { expectedRevision: 4, budgetMode: "power" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "STATE_CONFLICT",
      details: { expectedRevision: 4, currentRevision: 5 },
    });
    expect(bootstrapOnboarding).toHaveBeenCalledOnce();
    expect(runtimeMutation).not.toHaveBeenCalled();
  });

  it("marks onboarding complete", async () => {
    const markOnboardingComplete = vi.fn(() => ({ completed: true }));
    app = Fastify();
    app.decorate("services", { onboarding: { markOnboardingComplete } } as never);
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

  it("validates onboarding completion payloads", async () => {
    const markOnboardingComplete = vi.fn();
    app = Fastify();
    app.decorate("services", { onboarding: { markOnboardingComplete } } as never);
    await app.register(onboardingRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      payload: {
        completedBy: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(markOnboardingComplete).not.toHaveBeenCalled();
  });
});
