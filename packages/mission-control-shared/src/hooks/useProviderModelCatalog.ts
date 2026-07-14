import { useCallback, useEffect, useRef, useState } from "react";
import {
  findProviderTemplate,
  type LlmModelDiscoverySource,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse, RuntimeSettingsResponse } from "../api/client";
import { fetchLlmConfig, fetchLlmModels, previewLlmModels } from "../api/client";
import { useRefreshSubscription } from "./useRefreshSubscription";

const PROVIDER_MODELS_POSITIVE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_MODELS_NEGATIVE_TTL_MS = 30 * 1000;

const sharedProviderModelCache = new Map<string, ProviderModelCacheEntry>();
const sharedProviderModelRequests = new Map<string, Promise<ProviderModelLoadResult>>();

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

export interface ProviderModelPreviewResult {
  items: string[];
  source: "remote" | "fallback";
  warning?: string;
}

export type UniversalModelPickerAvailability = "ready" | "suggested" | "blocked" | "unknown";

export interface UniversalModelPickerOption {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
  label: string;
  searchText: string;
  availability: UniversalModelPickerAvailability;
  availabilityReason: string;
  endpointIdentity: string;
  credentialStatus: "configured" | "local_endpoint" | "missing" | "unknown";
  contextWindowTokens?: number;
  contextLimitSource?: ProviderModelCatalogOption["contextLimitSource"];
  fallbackReason?: string;
  policyReason?: string;
  probeState: ProviderModelProbeState;
  probeSource?: ProviderModelProbeSource;
  probeCheckedAt?: string;
}

export interface ProviderModelCacheEntry {
  items: string[];
  expiresAt: number;
  state: ProviderModelProbeState;
  source?: ProviderModelProbeSource;
  checkedAt?: string;
  warning?: string;
}

interface ProviderModelLoadResult {
  items: string[];
  source?: ProviderModelProbeSource;
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

export function buildUniversalModelPickerOptions(input: {
  providers: ProviderModelCatalogOption[];
  query?: string;
  activeProviderId?: string;
  activeModel?: string;
}): UniversalModelPickerOption[] {
  const query = normalizeSearchText(input.query ?? "");
  return input.providers
    .flatMap((provider) => buildUniversalModelPickerOptionsForProvider(provider, input))
    .filter((option) => !query || option.searchText.includes(query))
    .sort((left, right) => scoreUniversalModelOption(right, input) - scoreUniversalModelOption(left, input));
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
    cache.delete(providerId);
    return undefined;
  }
  return cached;
}

function buildUniversalModelPickerOptionsForProvider(
  provider: ProviderModelCatalogOption,
  input: { activeProviderId?: string; activeModel?: string },
): UniversalModelPickerOption[] {
  const models = provider.models.length ? provider.models : dedupeProviderModels([provider.defaultModel]);
  return models.map((model) => {
    const credentialStatus = resolveCredentialStatus(provider);
    const availability = resolveModelAvailability(provider, credentialStatus);
    const fallbackReason = resolveModelFallbackReason(provider);
    const policyReason = credentialStatus === "missing" ? "Provider credential is missing." : undefined;
    const availabilityReason = resolveModelAvailabilityReason({
      provider,
      credentialStatus,
      availability,
      fallbackReason,
      policyReason,
    });
    const active = provider.providerId === input.activeProviderId && model === input.activeModel;
    const label = active ? `${provider.label} / ${model} (active)` : `${provider.label} / ${model}`;
    return {
      id: `${provider.providerId}:${model}`,
      providerId: provider.providerId,
      providerLabel: provider.label,
      model,
      label,
      searchText: normalizeSearchText(
        [
          provider.providerId,
          provider.label,
          model,
          provider.apiStyle,
          provider.resolvedApiStyle,
          provider.sanitizedEndpointIdentity,
          provider.contextLimitSource,
          availability,
          fallbackReason,
          policyReason,
        ].join(" "),
      ),
      availability,
      availabilityReason,
      endpointIdentity: provider.sanitizedEndpointIdentity,
      credentialStatus,
      contextWindowTokens: provider.contextWindowTokens,
      contextLimitSource: provider.contextLimitSource,
      fallbackReason,
      policyReason,
      probeState: provider.modelProbeState ?? "not_checked",
      probeSource: provider.modelProbeSource,
      probeCheckedAt: provider.modelProbeCheckedAt,
    } satisfies UniversalModelPickerOption;
  });
}

function resolveCredentialStatus(provider: ProviderModelCatalogOption): UniversalModelPickerOption["credentialStatus"] {
  if (provider.hasApiKey) {
    return "configured";
  }
  if (provider.localCostPosture === "zero_cost_local_runtime") {
    return "local_endpoint";
  }
  return provider.hasApiKey === false ? "missing" : "unknown";
}

function resolveModelAvailability(
  provider: ProviderModelCatalogOption,
  credentialStatus: UniversalModelPickerOption["credentialStatus"],
): UniversalModelPickerAvailability {
  if (credentialStatus === "missing" || provider.modelProbeState === "error") {
    return "blocked";
  }
  if (provider.modelProbeState === "fallback" || provider.modelProbeSource === "template_fallback") {
    return "suggested";
  }
  if (provider.modelProbeState === "ready" && provider.modelProbeSource === "live") {
    return "ready";
  }
  return "unknown";
}

function resolveModelFallbackReason(provider: ProviderModelCatalogOption): string | undefined {
  if (provider.modelProbeSource === "error_fallback") {
    return provider.modelProbeWarning
      ? `Live discovery failed: ${provider.modelProbeWarning}`
      : "Live discovery failed.";
  }
  if (provider.modelProbeState === "fallback" || provider.modelProbeSource === "template_fallback") {
    return "Using template fallback models; availability is not account-verified.";
  }
  if (provider.modelProbeState === "empty") {
    return "Live discovery returned no models.";
  }
  return undefined;
}

function resolveModelAvailabilityReason(input: {
  provider: ProviderModelCatalogOption;
  credentialStatus: UniversalModelPickerOption["credentialStatus"];
  availability: UniversalModelPickerAvailability;
  fallbackReason?: string;
  policyReason?: string;
}): string {
  if (input.policyReason) {
    return input.policyReason;
  }
  if (input.fallbackReason) {
    return input.fallbackReason;
  }
  if (input.credentialStatus === "local_endpoint") {
    return "Local endpoint model; verify the runtime is reachable before send.";
  }
  if (input.availability === "ready") {
    return "Live model discovery verified this model for the configured provider.";
  }
  return "Model has not been live-checked yet.";
}

function scoreUniversalModelOption(
  option: UniversalModelPickerOption,
  input: { activeProviderId?: string; activeModel?: string },
): number {
  let score = 0;
  if (option.providerId === input.activeProviderId && option.model === input.activeModel) {
    score += 100;
  }
  if (option.availability === "ready") {
    score += 20;
  } else if (option.availability === "suggested") {
    score += 10;
  } else if (option.availability === "blocked") {
    score -= 20;
  }
  if (option.credentialStatus === "configured" || option.credentialStatus === "local_endpoint") {
    score += 5;
  }
  return score;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
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
      models: dedupeProviderModels([
        provider.defaultModel,
        provider.providerId === config.activeProviderId ? config.activeModel : undefined,
        ...(template?.knownModels ?? []),
        ...(cached?.items ?? []),
      ]),
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

export async function previewProviderModels(
  input: {
    providerId: string;
    baseUrl: string;
    apiStyle?: RuntimeSettingsResponse["llm"]["providers"][number]["apiStyle"];
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
    fallbackModel?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<ProviderModelPreviewResult> {
  const response = await previewLlmModels(
    {
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      apiStyle: input.apiStyle,
      apiKey: input.apiKey,
      apiKeyEnv: input.apiKeyEnv,
      request: input.request,
      headers: input.headers,
    },
    {
      signal: options?.signal,
    },
  );
  const template = findProviderTemplate(input.providerId);
  return {
    items: dedupeProviderModels([
      input.fallbackModel,
      ...(template?.knownModels ?? []),
      ...response.items.map((item) => item.id),
    ]),
    source: response.source === "live" ? "remote" : "fallback",
    warning: response.warning,
  };
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
        ? getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, now)
        : undefined;
      if (cached) {
        return cached.items;
      }

      const inFlight = sharedProviderModelRequests.get(normalized);
      if (inFlight) {
        return (await inFlight).items;
      }

      const request = (async () => {
        try {
          const response = await fetchLlmModels(normalized);
          const items = dedupeProviderModels(response.items.map((item) => item.id));
          const state: ProviderModelProbeState =
            items.length === 0 ? "empty" : response.source === "live" ? "ready" : "fallback";
          sharedProviderModelCache.set(normalized, {
            items,
            expiresAt: Date.now() + PROVIDER_MODELS_POSITIVE_TTL_MS,
            state,
            source: response.source,
            checkedAt: new Date().toISOString(),
            warning: response.warning,
          });
          return { items, source: response.source };
        } catch (err) {
          const fallbackSource: LlmModelDiscoverySource = "error_fallback";
          const warning = err instanceof Error && err.message ? err.message : "Model discovery failed.";
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
          sharedProviderModelRequests.delete(normalized);
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
    return getValidProviderModelCacheEntry(sharedProviderModelCache, normalized, Date.now());
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
    getCachedModelProbe,
  };
}

export function resetProviderModelCatalogCacheForTests(): void {
  sharedProviderModelCache.clear();
  sharedProviderModelRequests.clear();
}
