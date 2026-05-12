import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dedupeProviderModels,
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

function runtimeConfig(activeProviderId = "openai") {
  return {
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
      items: expect.arrayContaining(["fallback-model", "preview-remote"]),
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

  it("loads provider models with in-flight reuse, positive cache, force refresh, and empty-state metadata", async () => {
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

    apiMocks.fetchLlmModels.mockResolvedValueOnce({ source: "fallback", items: [] });
    await act(async () => {
      await expect(hook.result.loadModelsForProvider("openai", { force: true })).resolves.toEqual([]);
    });
    expect(hook.result.getCachedModelProbe("openai")).toMatchObject({
      state: "empty",
      source: "fallback",
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
      items: [],
    });

    vi.advanceTimersByTime(31_000);
    expect(hook.result.getCachedModels("custom")).toEqual([]);
    expect(hook.result.getCachedModelProbe("custom")).toBeUndefined();

    hook.renderer.unmount();
  });
});
