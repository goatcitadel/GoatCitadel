import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
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
        expectedRevision: 7,
        llamaCpp: {
          modelsRootPath: "C:\\Models\\",
          modelPath: "C:\\Models\\Gemma\\model.gguf",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
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
        expectedRevision: 7,
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
      expectedRevision: 7,
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
        expectedRevision: 7,
        features: {
          coworkRuntimeQualityV1Disabled: true,
          orchestrationFinalStreamingV1Disabled: true,
          autonomyV1Disabled: true,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      features: {
        coworkRuntimeQualityV1Disabled: true,
        orchestrationFinalStreamingV1Disabled: true,
        autonomyV1Disabled: true,
      },
    });
  });

  it("returns settings hardening errors for remote hardened approval bypass", async () => {
    const updateSettings = vi.fn(() => {
      throw new ValidationError({ message: "remote_hardened disables approval bypass." });
    });

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        expectedRevision: 7,
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "bypass",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "remote_hardened disables approval bypass.",
      code: "FIELD_INVALID",
    });
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      deploymentProfile: "remote_hardened",
      toolApprovalMode: "bypass",
    });
  });

  it("returns a revision conflict without retrying a stale settings mutation", async () => {
    const updateSettings = vi.fn(() => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Settings changed after this client loaded them.",
        details: { expectedRevision: 4, currentRevision: 5 },
      });
    });

    app = Fastify();
    app.decorate("services", { settings: { updateSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { expectedRevision: 4, budgetMode: "saver" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Settings changed after this client loaded them.",
      code: "STATE_CONFLICT",
      details: { expectedRevision: 4, currentRevision: 5 },
    });
    expect(updateSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ["/api/v1/settings", "getSettings"],
    ["/api/v1/auth/settings", "getSettings"],
    ["/api/v1/auth/settings", "getAuthRuntimeSettings"],
  ] as const)("maps the %s config-generation read fence on %s to a retryable conflict", async (url, method) => {
    const fence = () => {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
        details: { currentRevision: 3, transactionState: "committed" },
      });
    };
    const settings: Record<string, unknown> = {
      getSettings: vi.fn(() => ({ revision: 3 })),
      getAuthRuntimeSettings: vi.fn(() => ({})),
    };
    settings[method] = vi.fn(fence);

    app = Fastify();
    app.decorate("services", { settings } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "STATE_CONFLICT",
      error: "Settings are temporarily unavailable while runtime owners reconcile a config generation.",
      details: { currentRevision: 3, transactionState: "committed" },
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

  it("projects executable settings and runtime diagnostics while preserving auth readiness metadata", async () => {
    const rawSettings = {
      revision: 11,
      deploymentProfile: "trusted_local",
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        tokenConfigured: true,
        basicConfigured: false,
        plan: {
          mode: "token",
          warnings: [],
          token: { configured: true, source: "env" },
          basicUsername: { configured: false, source: "none" },
          basicPassword: { configured: false, source: "none" },
        },
      },
      llm: {
        activeProviderId: "custom-provider",
        activeModel: "custom-model",
        providers: [
          {
            providerId: "custom-provider",
            label: "Custom Provider",
            baseUrl: "https://provider.example.test/token/settings-path?token=settings-query",
            apiStyle: "openai-chat-completions",
            defaultModel: "custom-model",
            hasApiKey: true,
            apiKeySource: "env",
          },
        ],
      },
      llamaCpp: {
        enabled: true,
        autoStart: true,
        baseUrl: "http://127.0.0.1:8080/v1",
        command: "llama-server",
        extraArgs: ["--api-key", "llama-inline-short", "--threads", "8"],
        status: {
          healthy: false,
          lastError: "Authorization: Bearer llama-status-short",
          launchCommandPreview: "llama-server --api-key llama-preview-short --threads 8",
        },
      },
      npu: {
        enabled: true,
        autoStart: false,
        sidecarUrl: "https://npu.example.test/access-token/npu-path?token=npu-query",
        status: {
          healthy: false,
          lastError: "NPU failed with Bearer npu-status-short",
        },
      },
      requestCount: 23,
    };
    const getSettings = vi.fn(() => rawSettings);

    app = Fastify();
    app.decorate("services", { settings: { getSettings } } as never);
    await app.register(dashboardRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deploymentProfile: "trusted_local",
      auth: {
        mode: "token",
        tokenConfigured: true,
        basicConfigured: false,
        plan: {
          mode: "token",
          token: { configured: true, source: "env" },
          basicUsername: { configured: false, source: "none" },
          basicPassword: { configured: false, source: "none" },
        },
      },
      llm: {
        providers: [
          expect.objectContaining({
            providerId: "custom-provider",
            baseUrl: "https://provider.example.test/token/[REDACTED]?token=[REDACTED]",
            hasApiKey: true,
            apiKeySource: "env",
          }),
        ],
      },
      llamaCpp: {
        extraArgs: ["--api-key", "[REDACTED]", "--threads", "8"],
        status: {
          lastError: "Authorization: [REDACTED]",
          launchCommandPreview: "llama-server --api-key [REDACTED] --threads 8",
        },
      },
      npu: {
        sidecarUrl: "https://npu.example.test/access-token/[REDACTED]?token=[REDACTED]",
        status: { lastError: "NPU failed with Bearer [REDACTED]" },
      },
      requestCount: 23,
    });
    expect(rawSettings.llamaCpp.extraArgs[1]).toBe("llama-inline-short");
    expect(rawSettings.llamaCpp.status.launchCommandPreview).toContain("llama-preview-short");
    expect(rawSettings.auth.plan.token).toEqual({ configured: true, source: "env" });
  });

  it("accepts a GET-projected settings payload for the editable secret-bearing runtime fields", async () => {
    const rawSettings = {
      revision: 17,
      web: {
        firecrawl: {
          baseUrl: "https://firecrawl.example.test/token/firecrawl-secret?token=firecrawl-query",
        },
      },
      mesh: {
        staticPeers: ["https://peer.example.test/password/peer-secret?token=peer-query"],
      },
      npu: {
        sidecarUrl: "https://npu.example.test/access-token/npu-secret?token=npu-query",
      },
      llamaCpp: {
        baseUrl: "https://llama.example.test/access-token/llama-secret?token=llama-query",
        command: "llama-server --api-key command-secret",
        extraArgs: ["--api-key", "argument-secret"],
      },
    };
    const getSettings = vi.fn(() => rawSettings);
    const updateSettings = vi.fn(() => rawSettings);

    app = Fastify();
    app.decorate("services", { settings: { getSettings, updateSettings } } as never);
    await app.register(dashboardRoutes);

    const getResponse = await app.inject({ method: "GET", url: "/api/v1/settings" });
    const displayed = getResponse.json();
    const patch = {
      expectedRevision: displayed.revision,
      web: { firecrawl: { baseUrl: displayed.web.firecrawl.baseUrl, timeoutMs: 21_000 } },
      mesh: { staticPeers: displayed.mesh.staticPeers, mdns: false },
      npu: { sidecarUrl: displayed.npu.sidecarUrl, autoStart: true },
      llamaCpp: {
        baseUrl: displayed.llamaCpp.baseUrl,
        command: displayed.llamaCpp.command,
        extraArgs: displayed.llamaCpp.extraArgs,
        threads: 8,
      },
    };
    const patchResponse = await app.inject({ method: "PATCH", url: "/api/v1/settings", payload: patch });

    expect(getResponse.statusCode).toBe(200);
    expect(patchResponse.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(patch);
    expect(JSON.stringify(patchResponse.json())).not.toContain("firecrawl-secret");
    expect(JSON.stringify(patchResponse.json())).not.toContain("peer-secret");
    expect(JSON.stringify(patchResponse.json())).not.toContain("npu-secret");
    expect(JSON.stringify(patchResponse.json())).not.toContain("llama-secret");
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
