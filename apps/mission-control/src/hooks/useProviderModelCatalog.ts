import { useCallback, useEffect, useRef, useState } from "react";
import { findProviderTemplate } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "../api/client";
import { fetchLlmConfig, fetchLlmModels, previewLlmModels } from "../api/client";
import { useRefreshSubscription } from "./useRefreshSubscription";

const PROVIDER_MODELS_POSITIVE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_MODELS_NEGATIVE_TTL_MS = 30 * 1000;

const sharedProviderModelCache = new Map<string, ProviderModelCacheEntry>();
const sharedProviderModelRequests = new Map<string, Promise<string[]>>();

export interface ProviderModelCatalogOption {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyRef?: string;
  apiKeySource?: string;
  hasApiKey?: boolean;
  models: string[];
}

export interface ProviderModelPreviewResult {
  items: string[];
  source: "remote" | "fallback";
  warning?: string;
}

interface ProviderModelCacheEntry {
  items: string[];
  expiresAt: number;
}

export function dedupeProviderModels(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getValidProviderModelCacheEntry(
  cache: Map<string, ProviderModelCacheEntry>,
  providerId: string,
  now: number,
): ProviderModelCacheEntry | undefined {
  const cached = cache.get(providerId);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= now) {
    cache.delete(providerId);
    return undefined;
  }
  return cached;
}

function buildProviderCatalog(
  config: RuntimeSettingsResponse["llm"],
  cache: Map<string, ProviderModelCacheEntry>,
  now: number,
): ProviderModelCatalogOption[] {
  return config.providers.map((provider) => {
    const cached = getValidProviderModelCacheEntry(cache, provider.providerId, now);
    const template = findProviderTemplate(provider.providerId);
    return {
      providerId: provider.providerId,
      label: provider.label,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      apiKeyRef: provider.apiKeyRef,
      apiKeySource: provider.apiKeySource,
      hasApiKey: provider.hasApiKey,
      models: dedupeProviderModels([
        provider.defaultModel,
        provider.providerId === config.activeProviderId ? config.activeModel : undefined,
        ...(template?.knownModels ?? []),
        ...(cached?.items ?? []),
      ]),
    } satisfies ProviderModelCatalogOption;
  });
}

export async function previewProviderModels(input: {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  fallbackModel?: string;
}, options?: { signal?: AbortSignal }): Promise<ProviderModelPreviewResult> {
  const response = await previewLlmModels({
    providerId: input.providerId,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyEnv: input.apiKeyEnv,
    headers: input.headers,
  }, {
    signal: options?.signal,
  });
  return {
    items: dedupeProviderModels([
      input.fallbackModel,
      ...response.items.map((item) => item.id),
    ]),
    source: response.source,
    warning: response.warning,
  };
}

export function useProviderModelCatalog(refreshTopic: "chat" | "system" = "system") {
  const [config, setConfig] = useState<RuntimeSettingsResponse["llm"] | null>(null);
  const [providers, setProviders] = useState<ProviderModelCatalogOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<RuntimeSettingsResponse["llm"] | null>(null);

  const syncProviderState = useCallback((nextConfig?: RuntimeSettingsResponse["llm"] | null) => {
    const effectiveConfig = nextConfig ?? configRef.current;
    if (!effectiveConfig) {
      return;
    }
    const now = Date.now();
    configRef.current = effectiveConfig;
    setConfig(effectiveConfig);
    setProviders(buildProviderCatalog(effectiveConfig, sharedProviderModelCache, now));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const nextConfig = await fetchLlmConfig();
      syncProviderState(nextConfig);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [syncProviderState]);

  const loadModelsForProvider = useCallback(async (
    providerId: string,
    options: { force?: boolean } = {},
  ): Promise<string[]> => {
    const normalized = providerId.trim();
    if (!normalized) {
      return [];
    }

    const now = Date.now();
    const cached = !options.force
      ? getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, now)
      : undefined;
    if (cached) {
      return cached.items;
    }

    const inFlight = sharedProviderModelRequests.get(normalized);
    if (inFlight) {
      return inFlight;
    }

    const request = (async () => {
      try {
        const response = await fetchLlmModels(normalized);
        const items = dedupeProviderModels(response.items.map((item) => item.id));
        sharedProviderModelCache.set(normalized, {
          items,
          expiresAt: Date.now() + PROVIDER_MODELS_POSITIVE_TTL_MS,
        });
        return items;
      } catch {
        sharedProviderModelCache.set(normalized, {
          items: [],
          expiresAt: Date.now() + PROVIDER_MODELS_NEGATIVE_TTL_MS,
        });
        return [];
      } finally {
        sharedProviderModelRequests.delete(normalized);
        syncProviderState();
      }
    })();

    sharedProviderModelRequests.set(normalized, request);
    return request;
  }, [syncProviderState]);

  const getCachedModels = useCallback((providerId: string): string[] => {
    const normalized = providerId.trim();
    if (!normalized) {
      return [];
    }
    return getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, Date.now())?.items ?? [];
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRefreshSubscription(
    refreshTopic,
    async (signal) => {
      const haystack = `${signal.reason} ${signal.eventType ?? ""} ${signal.source ?? ""}`.toLowerCase();
      if (!/\b(llm|provider|model|onboarding|settings)\b/.test(haystack) && signal.eventType !== "fallback_poll") {
        return;
      }
      await reload();
    },
    {
      enabled: true,
      coalesceMs: 900,
      staleMs: 20000,
      pollIntervalMs: 20000,
    },
  );

  return {
    config,
    providers,
    loading,
    error,
    reload,
    loadModelsForProvider,
    getCachedModels,
  };
}

export function resetProviderModelCatalogCacheForTests(): void {
  sharedProviderModelCache.clear();
  sharedProviderModelRequests.clear();
}
