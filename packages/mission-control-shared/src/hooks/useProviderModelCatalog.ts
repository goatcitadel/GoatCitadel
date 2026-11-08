import { useCallback, useEffect, useRef, useState } from "react";
import {
  findProviderTemplate,
  type ChatCompletionReasoningEffort,
  type LlmModelDiscoverySource,
} from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse, RuntimeSettingsResponse } from "../api/client";
import { fetchLlmConfig, fetchLlmModels } from "../api/client";
import { useRefreshSubscription } from "./useRefreshSubscription";
import { dedupeProviderModels } from "./provider-model-values.js";

export {
  dedupeProviderModels,
  isModelMissingFromStaleCatalog,
  isModelUnavailableInFreshCatalog,
} from "./provider-model-values.js";
export {
  buildUniversalModelPickerOptions,
  type UniversalModelPickerAvailability,
  type UniversalModelPickerOption,
} from "./provider-model-picker-options.js";
export { previewProviderModels, type ProviderModelPreviewResult } from "./provider-model-preview.js";

const PROVIDER_MODELS_POSITIVE_TTL_MS = 60 * 1000;
const PROVIDER_MODELS_NEGATIVE_TTL_MS = 30 * 1000;

const sharedProviderModelCache = new Map<string, ProviderModelCacheEntry>();
const sharedProviderModelRequests = new Map<string, Promise<ProviderModelLoadResult>>();
let sharedProviderModelCacheGeneration = 0;

export type ProviderModelProbeState = "not_checked" | "ready" | "fallback" | "empty" | "error";
export type ProviderModelProbeSource = LlmModelDiscoverySource;

export interface ProviderModelCatalogOption {
  providerId: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiStyle: RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];
  resolvedApiStyle?: RuntimeSettingsResponse["llm"]["providers"][number]["resolvedApiStyle"];
  authMode?: RuntimeSettingsResponse["llm"]["providers"][number]["authMode"];
  googleCloud?: RuntimeSettingsResponse["llm"]["providers"][number]["googleCloud"];
  authReadiness?: RuntimeSettingsResponse["llm"]["providers"][number]["authReadiness"];
  apiKeyRef?: string;
  apiKeySource?: string;
  hasApiKey?: boolean;
  capabilities?: RuntimeSettingsResponse["llm"]["providers"][number]["capabilities"];
  models: string[];
  reasoningEffortsByModel?: Record<string, ChatCompletionReasoningEffort[]>;
  fastModeByModel?: Record<string, boolean>;
  sanitizedEndpointIdentity: string;
  localCostPosture?: "zero_cost_local_runtime" | "unknown";
  contextLimitSource?: "provider_config" | "runtime_active_model" | "template_fallback" | "unknown";
  contextWindowTokens?: number;
  contextWindowMismatch?: boolean;
  modelRefreshStatus?: "fresh" | "stale" | "not_checked" | "error";
  modelProbeState?: ProviderModelProbeState;
  modelProbeSource?: ProviderModelProbeSource;
  modelProbeCheckedAt?: string;
  modelProbeWarning?: string;
}

export interface ProviderModelCacheEntry {
  items: string[];
  reasoningEffortsByModel?: Record<string, ChatCompletionReasoningEffort[]>;
  fastModeByModel?: Record<string, boolean>;
  expiresAt: number;
  retryAfter?: number;
  state: ProviderModelProbeState;
  source?: ProviderModelProbeSource;
  checkedAt?: string;
  warning?: string;
}

interface ProviderModelLoadResult {
  items: string[];
  source?: ProviderModelProbeSource;
}

function getValidProviderModelCacheEntry(
  cache: Map<string, ProviderModelCacheEntry>,
  providerId: string,
  now: number,
  options: { allowStale?: boolean } = {},
): ProviderModelCacheEntry | undefined {
  const cached = cache.get(providerId);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= now) {
    if (options.allowStale) {
      return cached;
    }
    return undefined;
  }
  return cached;
}

function preserveLiveCatalogAfterRefreshFailure(providerId: string, warning?: string): string[] | undefined {
  const previous = sharedProviderModelCache.get(providerId);
  if (previous?.source !== "live") return undefined;
  sharedProviderModelCache.set(providerId, {
    ...previous,
    expiresAt: Date.now() - 1,
    retryAfter: Date.now() + PROVIDER_MODELS_NEGATIVE_TTL_MS,
    state: "fallback",
    checkedAt: new Date().toISOString(),
    warning: warning ?? "Live model refresh failed; showing the last known catalog.",
  });
  return previous.items;
}

function buildProviderCatalog(
  config: RuntimeSettingsResponse["llm"],
  cache: Map<string, ProviderModelCacheEntry>,
  now: number,
): ProviderModelCatalogOption[] {
  return config.providers.map((provider) => {
    const cached = getValidProviderModelCacheEntry(cache, provider.providerId, now, { allowStale: true });
    const template = findProviderTemplate(provider.providerId);
    const activeContext =
      provider.providerId === config.activeProviderId
        ? readOptionalNumber(config, "activeModelContextWindow")
        : undefined;
    const providerContext = readOptionalNumber(provider, "activeModelContextWindow");
    const contextWindowTokens = providerContext ?? activeContext;
    const isLocal = isLocalProvider(provider.providerId, provider.baseUrl);
    return {
      providerId: provider.providerId,
      label: provider.label,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      apiStyle: provider.apiStyle,
      resolvedApiStyle: provider.resolvedApiStyle,
      authMode: provider.authMode,
      googleCloud: provider.googleCloud,
      authReadiness: provider.authReadiness,
      apiKeyRef: provider.apiKeyRef,
      apiKeySource: provider.apiKeySource,
      hasApiKey: provider.hasApiKey,
      capabilities: provider.capabilities,
      models:
        cached?.source === "live"
          ? cached.items
          : dedupeProviderModels([
              provider.defaultModel,
              provider.providerId === config.activeProviderId ? config.activeModel : undefined,
              ...(template?.knownModels ?? []),
              ...(cached?.items ?? []),
            ]),
      reasoningEffortsByModel: cached?.reasoningEffortsByModel,
      fastModeByModel: cached?.fastModeByModel,
      sanitizedEndpointIdentity: sanitizeProviderEndpointIdentity(provider.baseUrl),
      localCostPosture: isLocal ? "zero_cost_local_runtime" : undefined,
      contextLimitSource: providerContext ? "provider_config" : activeContext ? "runtime_active_model" : "unknown",
      contextWindowTokens,
      contextWindowMismatch:
        typeof providerContext === "number" &&
        typeof activeContext === "number" &&
        provider.providerId === config.activeProviderId &&
        providerContext !== activeContext,
      modelRefreshStatus: cached
        ? cached.state === "error"
          ? "error"
          : cached.expiresAt > now
            ? "fresh"
            : "stale"
        : "not_checked",
      modelProbeState: cached?.state ?? "not_checked",
      modelProbeSource: cached?.source,
      modelProbeCheckedAt: cached?.checkedAt,
      modelProbeWarning: cached?.warning,
    } satisfies ProviderModelCatalogOption;
  });
}

function isLocalProvider(providerId: string, baseUrl: string): boolean {
  const normalizedProvider = providerId.toLowerCase();
  if (normalizedProvider.includes("local") || normalizedProvider === "ollama" || normalizedProvider === "lmstudio") {
    return true;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function sanitizeProviderEndpointIdentity(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "custom endpoint";
  }
}

function readOptionalNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function useProviderModelCatalog(refreshTopic: "chat" | "system" = "system") {
  const [config, setConfig] = useState<LlmRuntimeConfigResponse | null>(null);
  const [providers, setProviders] = useState<ProviderModelCatalogOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<LlmRuntimeConfigResponse | null>(null);

  const syncProviderState = useCallback((nextConfig?: LlmRuntimeConfigResponse | null) => {
    const effectiveConfig = nextConfig ?? configRef.current;
    if (!effectiveConfig) {
      return;
    }
    const previousRevision = configRef.current ? readOptionalNumber(configRef.current, "revision") : undefined;
    const nextRevision = nextConfig ? readOptionalNumber(nextConfig, "revision") : undefined;
    if (previousRevision !== undefined && nextRevision !== undefined && previousRevision !== nextRevision) {
      sharedProviderModelCache.clear();
      sharedProviderModelRequests.clear();
      sharedProviderModelCacheGeneration += 1;
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

  const loadModelsForProvider = useCallback(
    async (providerId: string, options: { force?: boolean } = {}): Promise<string[]> => {
      const normalized = providerId.trim();
      if (!normalized) {
        return [];
      }

      const now = Date.now();
      const cached = !options.force
        ? getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, now, { allowStale: true })
        : undefined;
      // Evidence freshness and retry eligibility are separate: a stale result
      // must stay stale without immediately triggering another render-driven read.
      if (cached && (cached.expiresAt > now || (cached.retryAfter ?? 0) > now)) {
        return cached.items;
      }

      const currentConfig = configRef.current;
      const provider = currentConfig?.providers.find((item) => item.providerId === normalized);
      const authStatus = provider?.authReadiness?.status;
      if (
        !options.force &&
        currentConfig &&
        provider &&
        (authStatus === "missing" ||
          authStatus === "invalid" ||
          authStatus === "unavailable" ||
          (provider.hasApiKey === false &&
            !isLocalProvider(provider.providerId, provider.baseUrl) &&
            authStatus !== "ready" &&
            authStatus !== "configured"))
      ) {
        // Automatic picker reads cannot resolve missing credentials. Explicit
        // probes remain available, and keyless local endpoints still get checked.
        return (
          buildProviderCatalog(currentConfig, sharedProviderModelCache, now).find(
            (item) => item.providerId === normalized,
          )?.models ?? []
        );
      }

      const inFlight = sharedProviderModelRequests.get(normalized);
      if (inFlight) {
        return (await inFlight).items;
      }

      const generation = sharedProviderModelCacheGeneration;
      const request = (async () => {
        try {
          const response = await fetchLlmModels(normalized);
          if (generation !== sharedProviderModelCacheGeneration) return { items: [], source: response.source };
          const items = dedupeProviderModels(response.items.map((item) => item.id));
          if (response.source !== "live") {
            const previousItems = preserveLiveCatalogAfterRefreshFailure(normalized, response.warning);
            if (previousItems) return { items: previousItems, source: response.source };
          }
          const state: ProviderModelProbeState =
            items.length === 0
              ? "empty"
              : response.source === "live" && response.catalogStatus !== "stale"
                ? "ready"
                : "fallback";
          sharedProviderModelCache.set(normalized, {
            items,
            reasoningEffortsByModel: Object.fromEntries(
              response.items
                .filter((item) => item.reasoningEfforts?.length)
                .map((item) => [item.id, item.reasoningEfforts!]),
            ),
            fastModeByModel: Object.fromEntries(
              response.items
                .filter((item) => item.fastModeAvailable !== undefined)
                .map((item) => [item.id, item.fastModeAvailable!]),
            ),
            expiresAt:
              response.catalogStatus === "stale" ? Date.now() - 1 : Date.now() + PROVIDER_MODELS_POSITIVE_TTL_MS,
            retryAfter: response.catalogStatus === "stale" ? Date.now() + PROVIDER_MODELS_NEGATIVE_TTL_MS : undefined,
            state,
            source: response.source,
            checkedAt: new Date().toISOString(),
            warning: response.warning,
          });
          return { items, source: response.source };
        } catch (err) {
          if (generation !== sharedProviderModelCacheGeneration)
            return { items: [], source: "error_fallback" as const };
          const fallbackSource: LlmModelDiscoverySource = "error_fallback";
          const warning = err instanceof Error && err.message ? err.message : "Model discovery failed.";
          const previousItems = preserveLiveCatalogAfterRefreshFailure(normalized, warning);
          if (previousItems) return { items: previousItems, source: fallbackSource };
          sharedProviderModelCache.set(normalized, {
            items: [],
            expiresAt: Date.now() + PROVIDER_MODELS_NEGATIVE_TTL_MS,
            state: "error",
            source: fallbackSource,
            checkedAt: new Date().toISOString(),
            warning,
          });
          return { items: [], source: fallbackSource };
        } finally {
          if (generation === sharedProviderModelCacheGeneration) sharedProviderModelRequests.delete(normalized);
          syncProviderState();
        }
      })();

      sharedProviderModelRequests.set(normalized, request);
      return (await request).items;
    },
    [syncProviderState],
  );

  const getCachedModels = useCallback((providerId: string): string[] => {
    const normalized = providerId.trim();
    if (!normalized) {
      return [];
    }
    return getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, Date.now())?.items ?? [];
  }, []);

  const getCachedModelProbe = useCallback((providerId: string): ProviderModelCacheEntry | undefined => {
    const normalized = providerId.trim();
    if (!normalized) {
      return undefined;
    }
    return getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, Date.now(), { allowStale: true });
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
      if (signal.eventType === "fallback_poll" && configRef.current?.activeProviderId) {
        await loadModelsForProvider(configRef.current.activeProviderId);
      }
    },
    {
      enabled: true,
      coalesceMs: 900,
      staleMs: 120_000,
      pollIntervalMs: 60_000,
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
    getCachedModelProbe,
  };
}

export function resetProviderModelCatalogCacheForTests(): void {
  sharedProviderModelCache.clear();
  sharedProviderModelRequests.clear();
  sharedProviderModelCacheGeneration = 0;
}
