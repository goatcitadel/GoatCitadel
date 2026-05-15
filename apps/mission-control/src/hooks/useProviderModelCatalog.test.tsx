import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsResponse } from "../api/client";

const apiMocks = vi.hoisted(() => ({
  fetchLlmConfig: vi.fn(),
  fetchLlmModels: vi.fn(),
  previewLlmModels: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchLlmConfig: apiMocks.fetchLlmConfig,
  fetchLlmModels: apiMocks.fetchLlmModels,
  previewLlmModels: apiMocks.previewLlmModels,
}));

vi.mock("./useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn(),
}));

import {
  previewProviderModels,
  resetProviderModelCatalogCacheForTests,
  useProviderModelCatalog,
} from "./useProviderModelCatalog";
import { useRefreshSubscription } from "./useRefreshSubscription";

const baseConfig: RuntimeSettingsResponse["llm"] = {
  activeProviderId: "openai",
  activeModel: "gpt-4.1-mini",
  providers: [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiStyle: "openai-chat-completions",
      defaultModel: "gpt-4.1-mini",
      hasApiKey: false,
      apiKeySource: "none",
      hasKeychainSecret: false,
      apiKeyRef: "OPENAI_API_KEY",
      capabilities: {
        vision: true,
        audio: false,
        video: false,
        toolCalling: true,
        jsonMode: true,
      },
    },
    {
      providerId: "glm",
      label: "GLM (Z.AI)",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiStyle: "openai-chat-completions",
      defaultModel: "glm-5",
      hasApiKey: true,
      apiKeySource: "env",
      hasKeychainSecret: false,
      apiKeyRef: "GLM_API_KEY",
      capabilities: {
        vision: true,
        audio: false,
        video: false,
        toolCalling: true,
        jsonMode: true,
      },
    },
    {
      providerId: "google",
      label: "Google (compatible endpoint)",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiStyle: "openai-chat-completions",
      defaultModel: "models/gemini-2.5-flash",
      hasApiKey: false,
      apiKeySource: "none",
      hasKeychainSecret: false,
      apiKeyRef: "GOOGLE_API_KEY",
      capabilities: {
        vision: true,
        audio: false,
        video: false,
        toolCalling: true,
        jsonMode: true,
      },
    },
  ],
};

type HarnessValue = ReturnType<typeof useProviderModelCatalog>;

function Harness({ onValue }: { onValue: (value: HarnessValue) => void }) {
  const value = useProviderModelCatalog("system");
  onValue(value);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useProviderModelCatalog", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HarnessValue | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetProviderModelCatalogCacheForTests();
    apiMocks.fetchLlmConfig.mockResolvedValue(baseConfig);
    apiMocks.fetchLlmModels.mockImplementation(async (providerId?: string) => ({
      items:
        providerId === "glm" ? [{ id: "glm-5" }, { id: "glm-5-air" }] : [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
      source: "live",
    }));
    latest = null;
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.useRealTimers();
  });

  it("loads runtime config without eagerly fetching models for every provider", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    expect(apiMocks.fetchLlmConfig).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchLlmModels).not.toHaveBeenCalled();
    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.models).toEqual([
      "glm-5",
      "glm-5-air",
      "glm-5-flash",
      "glm-5-turbo",
      "glm-5v-turbo",
    ]);
    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.modelProbeState).toBe("not_checked");
    expect(latest?.providers.find((provider) => provider.providerId === "google")?.models).toEqual([
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-lite",
      "models/gemini-2.5-pro",
      "models/gemini-flash-latest",
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-flash-image",
    ]);
  });

  it("loads selected provider models lazily and reuses cached results", async () => {
    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    await act(async () => {
      await latest?.loadModelsForProvider("glm");
    });
    await flush();

    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchLlmModels).toHaveBeenCalledWith("glm");
    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.models).toEqual([
      "glm-5",
      "glm-5-air",
      "glm-5-flash",
      "glm-5-turbo",
      "glm-5v-turbo",
    ]);
    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.modelProbeState).toBe("ready");

    await act(async () => {
      await latest?.loadModelsForProvider("glm");
    });

    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);
    expect(latest?.getCachedModels("glm")).toEqual(["glm-5", "glm-5-air"]);
  });

  it("caches failed provider lookups briefly to avoid repeated hammering", async () => {
    apiMocks.fetchLlmModels.mockRejectedValueOnce(new Error("provider offline"));

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();

    await act(async () => {
      await latest?.loadModelsForProvider("glm");
    });
    await flush();

    await act(async () => {
      await latest?.loadModelsForProvider("glm");
    });

    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);
    expect(latest?.getCachedModels("glm")).toEqual([]);
    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.modelProbeState).toBe("error");
  });

  it("merges known Google fallback models into preview results", async () => {
    apiMocks.previewLlmModels.mockResolvedValue({
      items: [{ id: "models/gemini-2.5-flash" }],
      source: "error_fallback",
      warning: "preview unavailable",
    });

    await expect(
      previewProviderModels({
        providerId: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        fallbackModel: "models/gemini-2.5-flash",
      }),
    ).resolves.toEqual({
      items: [
        "models/gemini-2.5-flash",
        "models/gemini-2.5-flash-lite",
        "models/gemini-2.5-pro",
        "models/gemini-flash-latest",
        "gemini-3.1-flash-image-preview",
        "gemini-3-pro-image-preview",
        "gemini-2.5-flash-image",
      ],
      source: "fallback",
      warning: "preview unavailable",
    });
  });

  it("merges known MiniMax fallback models into preview results", async () => {
    apiMocks.previewLlmModels.mockResolvedValue({
      items: [{ id: "MiniMax-M2.7" }],
      source: "error_fallback",
      warning: "preview unavailable",
    });

    await expect(
      previewProviderModels({
        providerId: "minimax",
        baseUrl: "https://api.minimax.io/v1",
        fallbackModel: "MiniMax-M2.7",
      }),
    ).resolves.toEqual({
      items: [
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
      ],
      source: "fallback",
      warning: "preview unavailable",
    });
  });

  it("handles config errors, blank provider ids, and refresh subscription filtering", async () => {
    apiMocks.fetchLlmConfig.mockRejectedValueOnce(new Error("settings unavailable")).mockResolvedValue(baseConfig);

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latest?.error).toBe("settings unavailable");
    await expect(latest?.loadModelsForProvider("   ")).resolves.toEqual([]);
    expect(latest?.getCachedModels("   ")).toEqual([]);

    const refreshHandler = vi.mocked(useRefreshSubscription).mock.calls.at(-1)?.[1];
    expect(refreshHandler).toBeTypeOf("function");

    await act(async () => {
      await refreshHandler?.({ reason: "other event", source: "test" } as never);
    });
    expect(apiMocks.fetchLlmConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await refreshHandler?.({ reason: "model settings changed", source: "test" } as never);
      await Promise.resolve();
    });
    expect(apiMocks.fetchLlmConfig).toHaveBeenCalledTimes(2);

    await act(async () => {
      await refreshHandler?.({ reason: "poll", eventType: "fallback_poll", source: "test" } as never);
      await Promise.resolve();
    });
    expect(apiMocks.fetchLlmConfig).toHaveBeenCalledTimes(3);
  });

  it("coalesces in-flight model loads, supports force refresh, and expires cached results", async () => {
    vi.setSystemTime(new Date("2026-05-04T00:00:00.000Z"));
    let resolveModels!: (value: { items: Array<{ id: string }>; source: "live"; warning?: string }) => void;
    apiMocks.fetchLlmModels.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveModels = resolve;
      }),
    );

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    const firstLoad = latest!.loadModelsForProvider("glm");
    const secondLoad = latest!.loadModelsForProvider("glm");
    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveModels({ items: [{ id: "glm-5-air" }, { id: "glm-5-air" }], source: "live" });
      await Promise.all([firstLoad, secondLoad]);
    });

    expect(await firstLoad).toEqual(["glm-5-air"]);
    expect(await secondLoad).toEqual(["glm-5-air"]);
    expect(latest?.getCachedModels("glm")).toEqual(["glm-5-air"]);

    apiMocks.fetchLlmModels.mockResolvedValueOnce({
      items: [{ id: "glm-5-flash" }],
      source: "live",
    });
    await act(async () => {
      await latest?.loadModelsForProvider("glm", { force: true });
    });
    expect(apiMocks.fetchLlmModels).toHaveBeenCalledTimes(2);
    expect(latest?.getCachedModels("glm")).toEqual(["glm-5-flash"]);

    vi.setSystemTime(new Date("2026-05-04T00:06:00.000Z"));
    expect(latest?.getCachedModels("glm")).toEqual([]);
  });

  it("can load a provider before config has hydrated", async () => {
    let resolveConfig!: (value: typeof baseConfig) => void;
    apiMocks.fetchLlmConfig.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    apiMocks.fetchLlmModels.mockResolvedValueOnce({
      items: [],
      source: "live",
      warning: "No models returned",
    });

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });

    await act(async () => {
      await latest?.loadModelsForProvider("glm");
    });

    expect(latest?.providers).toEqual([]);

    await act(async () => {
      resolveConfig(baseConfig);
      await Promise.resolve();
    });

    expect(latest?.providers.find((provider) => provider.providerId === "glm")?.modelProbeState).toBe("empty");
  });
});
