import { useCallback, useEffect, useRef, useState } from "react";
import {
  findProviderTemplate,
  type ChatCompletionReasoningEffort,
  type LlmModelDiscoverySource,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse, RuntimeSettingsResponse } from "../api/client";
import { fetchLlmConfig, fetchLlmModels, previewLlmModels } from "../api/client";
import { useRefreshSubscription } from "./useRefreshSubscription";

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
  reasoningEffortsByModel?: Record<string, ChatCompletionReasoningEffort[]>;
  fastModeByModel?: Record<string, boolean>;
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

export function isModelUnavailableInFreshCatalog(provider: ProviderModelCatalogOption | null, model: string): boolean {
  return Boolean(
    model &&
    provider?.modelProbeSource === "live" &&
    provider.modelRefreshStatus === "fresh" &&
    !provider.models.includes(model),
  );
}

export function isModelMissingFromStaleCatalog(provider: ProviderModelCatalogOption | null, model: string): boolean {
  return Boolean(
    model &&
    provider?.modelProbeSource === "live" &&
    provider.modelRefreshStatus === "stale" &&
    !provider.models.includes(model),
  );
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
    state: "fallback",
    checkedAt: new Date().toISOString(),
    warning: warning ?? "Live model refresh failed; showing the last known catalog.",
  });
  return previous.items;
}

function buildUniversalModelPickerOptionsForProvider(
  provider: ProviderModelCatalogOption,
  input: { activeProviderId?: string; activeModel?: string },
): UniversalModelPickerOption[] {
  const models = provider.models.length || provider.modelProbeSource === "live"
    ? [...provider.models]
    : dedupeProviderModels([provider.defaultModel]);
  const missingActiveModel = provider.providerId === input.activeProviderId && input.activeModel &&
    (isModelUnavailableInFreshCatalog(provider, input.activeModel) ||
      isModelMissingFromStaleCatalog(provider, input.activeModel))
    ? input.activeModel
    : undefined;
  if (missingActiveModel) models.push(missingActiveModel);
  return models.map((model) => {
    const credentialStatus = resolveCredentialStatus(provider);
    const removed = model === missingActiveModel;
    const needsRefresh = removed && provider.modelRefreshStatus === "stale";
    const availability = removed ? "blocked" : resolveModelAvailability(provider, credentialStatus);
    const fallbackReason = removed
      ? needsRefresh
        ? "This model was not in the last known account catalog. Refresh to verify before using it."
        : "This model is no longer listed in the provider's live account catalog. Choose an available model."
      : resolveModelFallbackReason(provider);
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
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "stale") {
    return "suggested";
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
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "stale") {
    return provider.modelProbeWarning
      ? `Showing the last known account catalog; refresh has not verified it: ${provider.modelProbeWarning}`
      : "Showing the last known account catalog; refresh has not verified it.";
  }
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
      models: cached?.source === "live"
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
    items: response.source === "live"
      ? dedupeProviderModels(response.items.map((item) => item.id))
      : dedupeProviderModels([
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
      if (cached && cached.expiresAt > now) {
        return cached.items;
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
            items.length === 0 ? "empty" : response.source === "live" && response.catalogStatus !== "stale" ? "ready" : "fallback";
          sharedProviderModelCache.set(normalized, {
            items,
            reasoningEffortsByModel: Object.fromEntries(response.items
              .filter((item) => item.reasoningEfforts?.length)
              .map((item) => [item.id, item.reasoningEfforts!])),
            fastModeByModel: Object.fromEntries(response.items
              .filter((item) => item.fastModeAvailable !== undefined)
              .map((item) => [item.id, item.fastModeAvailable!])),
            expiresAt: response.catalogStatus === "stale" ? Date.now() - 1 : Date.now() + PROVIDER_MODELS_POSITIVE_TTL_MS,
            state,
            source: response.source,
            checkedAt: new Date().toISOString(),
            warning: response.warning,
          });
          return { items, source: response.source };
        } catch (err) {
          if (generation !== sharedProviderModelCacheGeneration) return { items: [], source: "error_fallback" as const };
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
      if (signal.eventType === "fallback_poll" && configRef.current?.activeProviderId) {
        await loadModelsForProvider(configRef.current.activeProviderId);
      }
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
  sharedProviderModelCacheGeneration = 0;
}
