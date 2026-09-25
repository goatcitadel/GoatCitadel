import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildUniversalModelPickerOptions,
  dedupeProviderModels,
  isModelMissingFromStaleCatalog,
  isModelUnavailableInFreshCatalog,
  previewProviderModels,
  resetProviderModelCatalogCacheForTests,
  useProviderModelCatalog,
} from "./useProviderModelCatalog";

const apiMocks = vi.hoisted(() => ({
  fetchLlmConfig: vi.fn(),
  fetchLlmModels: vi.fn(),
  previewLlmModels: vi.fn(),
}));

const refreshMocks = vi.hoisted(() => ({
  useRefreshSubscription: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchLlmConfig: apiMocks.fetchLlmConfig,
  fetchLlmModels: apiMocks.fetchLlmModels,
  previewLlmModels: apiMocks.previewLlmModels,
}));

vi.mock("./useRefreshSubscription", () => ({
  useRefreshSubscription: refreshMocks.useRefreshSubscription,
}));

type CatalogResult = ReturnType<typeof useProviderModelCatalog>;

function runtimeConfig(activeProviderId = "openai", revision = 1) {
  return {
    revision,
    activeProviderId,
    activeModel: "gpt-active",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-default",
        apiStyle: "responses",
        resolvedApiStyle: "responses",
        apiKeyRef: "OPENAI_API_KEY",
        apiKeySource: "env",
        hasApiKey: true,
        capabilities: { imageInput: true },
      },
      {
        providerId: "custom",
        label: "Custom",
        baseUrl: "http://localhost:11434",
        defaultModel: "custom-default",
        apiStyle: "openai-compatible",
        resolvedApiStyle: "openai-compatible",
        hasApiKey: false,
      },
    ],
  } as never;
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderCatalog() {
  let latest!: CatalogResult;
  const Harness = () => {
    latest = useProviderModelCatalog("chat");
    return null;
  };
  const renderer = create(<Harness />);
  await flushAsync();
  await flushAsync();
  return {
    renderer,
    get result() {
      return latest;
    },
  };
}

describe("useProviderModelCatalog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    resetProviderModelCatalogCacheForTests();
    vi.clearAllMocks();
    apiMocks.fetchLlmConfig.mockResolvedValue(runtimeConfig());
    apiMocks.fetchLlmModels.mockResolvedValue({
      source: "live",
      warning: "remote warning",
      items: [{ id: "gpt-remote" }, { id: "gpt-remote" }, { id: "gpt-extra" }],
    });
    apiMocks.previewLlmModels.mockResolvedValue({
      source: "live",
      warning: "preview warning",
      items: [{ id: "preview-remote" }, { id: "preview-remote" }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes models and previews provider models through the gateway", async () => {
    const abortController = new AbortController();

    expect(dedupeProviderModels([" a ", "a", "", null, undefined, "b"])).toEqual(["a", "b"]);
    await expect(
      previewProviderModels(
        {
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "responses",
          apiKey: "key",
          apiKeyEnv: "OPENAI_API_KEY",
          request: { path: "/models" } as never,
          headers: { "x-test": "yes" },
          fallbackModel: "fallback-model",
        },
        { signal: abortController.signal },
      ),
    ).resolves.toMatchObject({
      source: "remote",
      warning: "preview warning",
      items: ["preview-remote"],
    });
    expect(apiMocks.previewLlmModels).toHaveBeenCalledWith(
      {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "responses",
        apiKey: "key",
        apiKeyEnv: "OPENAI_API_KEY",
        request: { path: "/models" },
        headers: { "x-test": "yes" },
      },
      { signal: abortController.signal },
    );

    apiMocks.previewLlmModels.mockResolvedValueOnce({ source: "fallback", items: [] });
    await expect(previewProviderModels({ providerId: "custom", baseUrl: "http://local" })).resolves.toMatchObject({
      source: "fallback",
    });
  });

  it("builds searchable universal model picker options with availability and fallback evidence", () => {
    const options = buildUniversalModelPickerOptions({
      activeProviderId: "openai",
      activeModel: "gpt-live",
      query: "fallback",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-default",
          apiStyle: "openai-responses",
          resolvedApiStyle: "openai-responses",
          hasApiKey: true,
          models: ["gpt-live", "gpt-fallback"],
          sanitizedEndpointIdentity: "https://api.openai.com",
          modelProbeState: "fallback",
          modelProbeSource: "template_fallback",
          contextWindowTokens: 128000,
          contextLimitSource: "provider_config",
        },
        {
          providerId: "local",
          label: "Local",
          baseUrl: "http://127.0.0.1:11434/v1",
          defaultModel: "local-model",
          apiStyle: "openai-chat-completions",
          hasApiKey: false,
          models: ["local-model"],
          sanitizedEndpointIdentity: "http://127.0.0.1:11434",
          localCostPosture: "zero_cost_local_runtime",
          modelProbeState: "not_checked",
        },
        {
          providerId: "remote",
          label: "Remote missing key",
          baseUrl: "https://remote.example/v1",
          defaultModel: "remote-model",
          apiStyle: "openai-responses",
          hasApiKey: false,
          models: ["remote-model"],
          sanitizedEndpointIdentity: "https://remote.example",
          modelProbeState: "error",
          modelProbeSource: "error_fallback",
          modelProbeWarning: "401",
        },
      ] as never,
    });

    expect(options.map((item) => item.model)).toEqual(["gpt-live", "gpt-fallback"]);
    expect(options[0]).toMatchObject({
      providerId: "openai",
      model: "gpt-live",
      availability: "suggested",
      credentialStatus: "configured",
      fallbackReason: "Using template fallback models; availability is not account-verified.",
      contextWindowTokens: 128000,
      contextLimitSource: "provider_config",
    });

    const allOptions = buildUniversalModelPickerOptions({
      providers: optionsFixtureProviders(),
      activeProviderId: "openai",
      activeModel: "gpt-live",
    });
    expect(allOptions.find((item) => item.providerId === "local")).toMatchObject({
      availability: "unknown",
      credentialStatus: "local_endpoint",
      availabilityReason: "Local endpoint model; verify the runtime is reachable before send.",
    });
    expect(allOptions.find((item) => item.providerId === "remote")).toMatchObject({
      availability: "blocked",
      credentialStatus: "missing",
      policyReason: "Provider credential is missing.",
    });
  });

  it("asks for a replacement only when a fresh live catalog omits the selected model", () => {
    const provider = {
      ...optionsFixtureProviders()[0],
      models: ["gpt-new"],
      modelRefreshStatus: "fresh",
    } as never;
    expect(isModelUnavailableInFreshCatalog(provider, "gpt-old")).toBe(true);
    expect(isModelUnavailableInFreshCatalog(provider, "gpt-new")).toBe(false);
    expect(isModelUnavailableInFreshCatalog({ ...provider, modelRefreshStatus: "stale" }, "gpt-old")).toBe(false);
    expect(isModelUnavailableInFreshCatalog({ ...provider, modelProbeSource: "error_fallback" }, "gpt-old")).toBe(
      false,
    );
    expect(isModelMissingFromStaleCatalog({ ...provider, modelRefreshStatus: "stale" }, "gpt-old")).toBe(true);
    const options = buildUniversalModelPickerOptions({
      providers: [provider],
      activeProviderId: "openai",
      activeModel: "gpt-old",
    });
    expect(options.find((item) => item.model === "gpt-old")).toMatchObject({
      availability: "blocked",
      availabilityReason: expect.stringContaining("no longer listed"),
    });
    expect(options.find((item) => item.model === "gpt-new")?.availability).toBe("ready");
    const staleOptions = buildUniversalModelPickerOptions({
      providers: [{ ...provider, modelRefreshStatus: "stale" }],
      activeProviderId: "openai",
      activeModel: "gpt-old",
    });
    expect(staleOptions.find((item) => item.model === "gpt-old")?.availabilityReason).toContain("Refresh to verify");
  });

  it("loads runtime config and builds provider options with defaults, active models, and cache state", async () => {
    const hook = await renderCatalog();

    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toBeNull();
    expect(hook.result.providers[0]).toMatchObject({
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-default",
      apiStyle: "responses",
      resolvedApiStyle: "responses",
      apiKeyRef: "OPENAI_API_KEY",
      apiKeySource: "env",
      hasApiKey: true,
      modelProbeState: "not_checked",
      sanitizedEndpointIdentity: "https://api.openai.com",
      modelRefreshStatus: "not_checked",
    });
    expect(hook.result.providers[1]).toMatchObject({
      providerId: "custom",
      sanitizedEndpointIdentity: "http://localhost:11434",
      localCostPosture: "zero_cost_local_runtime",
      contextLimitSource: "unknown",
    });
    expect(hook.result.providers[0]?.models).toEqual(expect.arrayContaining(["gpt-default", "gpt-active"]));
    expect(refreshMocks.useRefreshSubscription).toHaveBeenCalledWith("chat", expect.any(Function), {
      enabled: true,
      coalesceMs: 900,
      staleMs: 20000,
      pollIntervalMs: 20000,
    });

    const refreshCallback = refreshMocks.useRefreshSubscription.mock.calls.at(-1)?.[1];
    await act(async () => {
      await refreshCallback({ topic: "chat", timestamp: Date.now(), reason: "unrelated", source: "test" });
      await refreshCallback({
        topic: "chat",
        timestamp: Date.now(),
        reason: "provider settings changed",
        eventType: "settings.updated",
        source: "test",
      });
      await refreshCallback({
        topic: "chat",
        timestamp: Date.now(),
        reason: "poll",
        eventType: "fallback_poll",
        source: "test",
      });
    });
    expect(apiMocks.fetchLlmConfig).toHaveBeenCalledTimes(3);

    hook.renderer.unmount();
  });

  it("uses live models without template additions and retains them as stale after a failed refresh", async () => {
    const hook = await renderCatalog();

    await expect(hook.result.loadModelsForProvider("   ")).resolves.toEqual([]);

    let first: Promise<string[]>;
    let second: Promise<string[]>;
    await act(async () => {
      first = hook.result.loadModelsForProvider(" openai ");
      second = hook.result.loadModelsForProvider("openai");
      await expect(first).resolves.toEqual(["gpt-remote", "gpt-extra"]);
      await expect(second).resolves.toEqual(["gpt-remote", "gpt-extra"]);
    });
    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);
    expect(hook.result.getCachedModels("openai")).toEqual(["gpt-remote", "gpt-extra"]);
    expect(hook.result.providers[0]?.models).toEqual(["gpt-remote", "gpt-extra"]);
    expect(hook.result.getCachedModelProbe("openai")).toMatchObject({
      state: "ready",
      source: "live",
      warning: "remote warning",
    });
    expect(hook.result.getCachedModels(" ")).toEqual([]);
    expect(hook.result.getCachedModelProbe(" ")).toBeUndefined();

    await act(async () => {
      await expect(hook.result.loadModelsForProvider("openai")).resolves.toEqual(["gpt-remote", "gpt-extra"]);
    });
    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);

    apiMocks.fetchLlmModels.mockResolvedValueOnce({
      source: "error_fallback",
      items: [{ id: "gpt-default" }],
      warning: "503",
    });
    await act(async () => {
      await expect(hook.result.loadModelsForProvider("openai", { force: true })).resolves.toEqual([
        "gpt-remote",
        "gpt-extra",
      ]);
    });
    expect(hook.result.providers[0]).toMatchObject({
      models: ["gpt-remote", "gpt-extra"],
      modelRefreshStatus: "stale",
      modelProbeState: "fallback",
      modelProbeSource: "live",
      modelProbeWarning: "503",
    });

    hook.renderer.unmount();
  });

  it("uses the live OAuth catalog as the picker authority and retains reasoning levels", async () => {
    apiMocks.fetchLlmConfig.mockResolvedValue({
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.4",
      providers: [
        {
          providerId: "openai-codex",
          label: "OpenAI Codex",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "gpt-5.4",
          apiStyle: "openai-codex-responses",
          hasApiKey: true,
        },
      ],
    });
    apiMocks.fetchLlmModels.mockResolvedValue({
      source: "live",
      items: [{ id: "gpt-6-astra", reasoningEfforts: ["low", "medium", "max"], fastModeAvailable: false }],
    });
    const hook = await renderCatalog();
    await act(async () => {
      await hook.result.loadModelsForProvider("openai-codex");
    });
    expect(hook.result.providers[0]).toMatchObject({
      models: ["gpt-6-astra"],
      reasoningEffortsByModel: { "gpt-6-astra": ["low", "medium", "max"] },
      fastModeByModel: { "gpt-6-astra": false },
      modelProbeSource: "live",
    });
    hook.renderer.unmount();
  });

  it("keeps expired model catalog entries visible as stale evidence until refreshed", async () => {
    const hook = await renderCatalog();

    await act(async () => {
      await expect(hook.result.loadModelsForProvider("openai")).resolves.toEqual(["gpt-remote", "gpt-extra"]);
    });
    expect(hook.result.providers.find((item) => item.providerId === "openai")).toMatchObject({
      modelRefreshStatus: "fresh",
      modelProbeState: "ready",
    });

    vi.advanceTimersByTime(60 * 1000 + 1);
    await act(async () => {
      await hook.result.reload();
    });

    expect(hook.result.providers.find((item) => item.providerId === "openai")).toMatchObject({
      modelRefreshStatus: "stale",
      modelProbeState: "ready",
      models: expect.arrayContaining(["gpt-remote", "gpt-extra"]),
    });
    expect(hook.result.getCachedModels("openai")).toEqual([]);

    hook.renderer.unmount();
  });

  it("does not present a Gateway stale live catalog as freshly verified", async () => {
    apiMocks.fetchLlmModels.mockResolvedValueOnce({
      source: "live",
      catalogStatus: "stale",
      items: [{ id: "last-known-model" }],
    });
    const hook = await renderCatalog();
    await act(async () => {
      await hook.result.loadModelsForProvider("openai");
    });
    expect(hook.result.providers[0]).toMatchObject({
      models: ["last-known-model"],
      modelRefreshStatus: "stale",
      modelProbeSource: "live",
    });
    expect(hook.result.getCachedModelProbe("openai")).toMatchObject({
      items: ["last-known-model"],
      state: "fallback",
      source: "live",
    });
    hook.renderer.unmount();
  });

  it("drops account model evidence when the provider configuration revision changes", async () => {
    const hook = await renderCatalog();
    await act(async () => {
      await hook.result.loadModelsForProvider("openai");
    });
    expect(hook.result.providers[0]?.modelProbeSource).toBe("live");

    apiMocks.fetchLlmConfig.mockResolvedValueOnce(runtimeConfig("openai", 2));
    await act(async () => {
      await hook.result.reload();
    });
    expect(hook.result.providers[0]).toMatchObject({
      modelProbeState: "not_checked",
      models: expect.arrayContaining(["gpt-default", "gpt-active"]),
    });
    hook.renderer.unmount();
  });

  it("records negative cache entries on model load failures and reload errors", async () => {
    apiMocks.fetchLlmConfig.mockRejectedValueOnce(new Error("config failed"));
    const hook = await renderCatalog();

    expect(hook.result.loading).toBe(false);
    expect(hook.result.error).toBe("config failed");

    await act(async () => {
      await hook.result.reload();
    });
    expect(hook.result.error).toBeNull();

    apiMocks.fetchLlmModels.mockRejectedValueOnce(new Error("models failed"));
    await act(async () => {
      await expect(hook.result.loadModelsForProvider("custom", { force: true })).resolves.toEqual([]);
    });
    expect(hook.result.getCachedModelProbe("custom")).toMatchObject({
      state: "error",
      source: "error_fallback",
      warning: "models failed",
      items: [],
    });

    vi.advanceTimersByTime(31_000);
    expect(hook.result.getCachedModels("custom")).toEqual([]);
    expect(hook.result.getCachedModelProbe("custom")).toMatchObject({ state: "error", source: "error_fallback" });

    hook.renderer.unmount();
  });
});

function optionsFixtureProviders() {
  return [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-live",
      apiStyle: "openai-responses",
      hasApiKey: true,
      models: ["gpt-live"],
      sanitizedEndpointIdentity: "https://api.openai.com",
      modelProbeState: "ready",
      modelProbeSource: "live",
    },
    {
      providerId: "local",
      label: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "local-model",
      apiStyle: "openai-chat-completions",
      hasApiKey: false,
      models: ["local-model"],
      sanitizedEndpointIdentity: "http://127.0.0.1:11434",
      localCostPosture: "zero_cost_local_runtime",
      modelProbeState: "not_checked",
    },
    {
      providerId: "remote",
      label: "Remote missing key",
      baseUrl: "https://remote.example/v1",
      defaultModel: "remote-model",
      apiStyle: "openai-responses",
      hasApiKey: false,
      models: ["remote-model"],
      sanitizedEndpointIdentity: "https://remote.example",
      modelProbeState: "error",
      modelProbeSource: "error_fallback",
      modelProbeWarning: "401",
    },
  ] as never;
}
