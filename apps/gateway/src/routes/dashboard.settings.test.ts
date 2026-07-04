import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { dashboardRoutes } from "./dashboard.js";

describe("dashboard settings routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes llama.cpp modelsRootPath through the settings patch schema", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        llamaCpp: {
          modelsRootPath: "C:\\Models\\",
          modelPath: "C:\\Models\\Gemma\\model.gguf",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      llamaCpp: {
        modelsRootPath: "C:\\Models\\",
        modelPath: "C:\\Models\\Gemma\\model.gguf",
      },
    });
  });

  it("passes provider request transport overrides through the settings patch schema", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        llm: {
          upsertProvider: {
            providerId: "openai-compatible",
            baseUrl: "https://llm.example.test/v1",
            request: {
              headers: {
                "X-Trace": "1",
              },
              proxy: {
                url: "http://proxy.internal:8080",
              },
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      llm: {
        upsertProvider: {
          providerId: "openai-compatible",
          baseUrl: "https://llm.example.test/v1",
          request: {
            headers: {
              "X-Trace": "1",
            },
            proxy: {
              url: "http://proxy.internal:8080",
            },
          },
        },
      },
    });
  });

  it("passes agentic kill-switch feature flags through the settings patch schema", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        features: {
          coworkRuntimeQualityV1Disabled: true,
          orchestrationFinalStreamingV1Disabled: true,
          autonomyV1Disabled: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      features: {
        coworkRuntimeQualityV1Disabled: true,
        orchestrationFinalStreamingV1Disabled: true,
        autonomyV1Disabled: true,
      },
    });
  });

  it("returns settings hardening errors for remote hardened approval bypass", async () => {
    const updateSettings = vi.fn(() => {
      throw new Error("remote_hardened disables approval bypass.");
    });

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "bypass",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "remote_hardened disables approval bypass." });
    expect(updateSettings).toHaveBeenCalledWith({
      deploymentProfile: "remote_hardened",
      toolApprovalMode: "bypass",
    });
  });

  it("rejects dangerous settings payload keys before runtime mutation", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { "content-type": "application/json" },
      payload: '{"features":{"prototype":{"polluted":true}}}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unsafe config key is not allowed: features.prototype" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("rejects dangerous auth settings payload keys before runtime mutation", async () => {
    const updateSettings = vi.fn((input: Record<string, unknown>) => input);

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/settings",
      headers: { "content-type": "application/json" },
      payload: '{"prototype":{"mode":"none"}}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unsafe config key is not allowed: prototype" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("routes canonical personality catalog APIs to settings services", async () => {
    const catalog = {
      defaultPersonalityId: "operator",
      items: [
        {
          id: "operator",
          label: "Operator",
          category: "core",
          description: "Crisp mission-control style.",
          tone: "Composed",
          style: "Operational",
          systemOverlay: "Use crisp language.",
          soulFile: "docs/personalities/core/operator.md",
          safetyNotes: ["Tone only."],
          visibility: "builtin",
          builtin: true,
          editable: true,
          modified: false,
        },
      ],
    };
    const settings = {
      getPersonalityCatalog: vi.fn(() => catalog),
      createPersonality: vi.fn((input: Record<string, unknown>) => ({ ...catalog, created: input })),
      updatePersonality: vi.fn((id: string, input: Record<string, unknown>) => ({
        ...catalog,
        updated: { id, input },
      })),
      deletePersonality: vi.fn((id: string) => ({ ...catalog, deleted: id })),
      setDefaultPersonality: vi.fn((id: string) => ({ ...catalog, defaultPersonalityId: id })),
    };

    app = Fastify();
    app.decorate("services", { settings } as never);
    await app.register(dashboardRoutes);

    let response = await app.inject({ method: "GET", url: "/api/v1/personalities" });
    expect(response.statusCode).toBe(200);
    expect(settings.getPersonalityCatalog).toHaveBeenCalled();

    response = await app.inject({
      method: "POST",
      url: "/api/v1/personalities",
      payload: {
        id: "direct-custom",
        label: "Direct Custom",
        category: "execution",
        systemOverlay: "Be direct.",
        safetyNotes: ["Tone only."],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(settings.createPersonality).toHaveBeenCalledWith({
      id: "direct-custom",
      label: "Direct Custom",
      category: "execution",
      systemOverlay: "Be direct.",
      safetyNotes: ["Tone only."],
    });

    response = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/operator",
      payload: { label: "Operator Prime", style: "Compact" },
    });
    expect(response.statusCode).toBe(200);
    expect(settings.updatePersonality).toHaveBeenCalledWith("operator", {
      label: "Operator Prime",
      style: "Compact",
    });

    response = await app.inject({
      method: "PATCH",
      url: "/api/v1/personalities/default",
      payload: { personalityId: "none" },
    });
    expect(response.statusCode).toBe(200);
    expect(settings.setDefaultPersonality).toHaveBeenCalledWith("none");

    response = await app.inject({ method: "DELETE", url: "/api/v1/personalities/operator" });
    expect(response.statusCode).toBe(200);
    expect(settings.deletePersonality).toHaveBeenCalledWith("operator");
  });
});
