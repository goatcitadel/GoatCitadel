import {
  applyChatModePresetToPatch,
  inferProviderForModelId,
  providerAllowsForeignModelIds,
  providerRecognizesModelId,
  type RoutingDecisionSnapshot,
  type RoutingPreflightRequest,
  type RoutingPreflightResult,
  type ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import { splitChatPrefsPatch, shouldAllowCrossProviderFallback } from "./chat-session-utils.js";

type LlmRuntimeConfig = ReturnType<LlmService["getRuntimeConfig"]>;
type RuntimeProvider = LlmRuntimeConfig["providers"][number];
const ROUTING_DECISION_TTL_MS = 30_000;

export interface ChatRouteResolutionDependencies {
  readonly storage: Pick<Storage, "chatSessionPrefs">;
  readonly llmService: Pick<LlmService, "getRuntimeConfig">;
  resolveFallbackTargets(
    runtime: LlmRuntimeConfig,
    primaryProviderId: string,
    primaryModel: string,
  ): Array<{ providerId: string; model: string }>;
  listLlmModels?(providerId: string): Promise<Array<{ id: string }>>;
  requireChatTurnContext?(
    sessionId: string,
    turnId: string,
  ): Promise<{
    trace: {
      sessionId: string;
    };
  }>;
  resolveCapabilityPreflight?(
    sessionId: string,
    input: RoutingPreflightRequest,
    route: ResolvedChatRouteDescriptor,
  ): Promise<NonNullable<RoutingPreflightResult["capabilityProfile"]>>;
}

export interface ResolvedChatRouteDescriptor {
  requestedProviderId?: string;
  requestedModel?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  selectionSource: RoutingPreflightResult["selectionSource"];
  normalizationReason?: string;
  fallbackPolicy: RoutingPreflightResult["fallbackPolicy"];
  fallbackResult: RoutingPreflightResult["fallbackResult"];
  runtimeClass: RoutingPreflightResult["runtimeClass"];
  blockedReason?: string;
  degradedReason?: string;
  runtimeProvider?: RuntimeProvider;
  fallbackTarget?: { providerId: string; model: string };
}

function isLikelyLocalProviderUrl(baseUrl: string | undefined): boolean {
  const normalized = (baseUrl ?? "").trim().toLowerCase();
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(
    normalized,
  );
}

function normalizeRequestedModel(providerId: string, model: string): string {
  const trimmed = model.trim();
  if (providerId !== "google") {
    return trimmed;
  }
  if (!trimmed || trimmed.startsWith("models/")) {
    return trimmed;
  }
  if (/^(gemini|gemma)-/i.test(trimmed)) {
    return `models/${trimmed}`;
  }
  return trimmed;
}

export function buildPreviewPrefs(
  sessionPrefs: ChatSessionPrefsRecord,
  input: RoutingPreflightRequest,
): ChatSessionPrefsRecord {
  const prefsOverride = applyChatModePresetToPatch({
    ...(input.prefsOverride ?? {}),
    mode: input.mode ?? input.prefsOverride?.mode,
    providerId: input.providerId ?? input.prefsOverride?.providerId,
    model: input.model ?? input.prefsOverride?.model,
    webMode: input.webMode ?? input.prefsOverride?.webMode,
    thinkingLevel: input.thinkingLevel ?? input.prefsOverride?.thinkingLevel,
    speedMode: input.speedMode ?? input.prefsOverride?.speedMode,
    subagentPolicy: input.subagentPolicy ?? input.prefsOverride?.subagentPolicy,
  });
  const splitPrefs = splitChatPrefsPatch(prefsOverride);
  return {
    ...sessionPrefs,
    ...splitPrefs.basePatch,
  };
}

function describeSelectionSource(
  sessionPrefs: ChatSessionPrefsRecord,
  input: RoutingPreflightRequest,
): RoutingPreflightResult["selectionSource"] {
  if (input.providerId || input.model) {
    return "manual";
  }
  if (input.prefsOverride?.providerId || input.prefsOverride?.model || sessionPrefs.providerId || sessionPrefs.model) {
    return "session";
  }
  return "global";
}

function resolveRequestedProvider(
  runtime: LlmRuntimeConfig,
  prefs: ChatSessionPrefsRecord,
  input: RoutingPreflightRequest,
): RuntimeProvider | undefined {
  const providerId = input.providerId ?? prefs.providerId ?? runtime.activeProviderId;
  if (!providerId) {
    return undefined;
  }
  return runtime.providers.find((provider) => provider.providerId === providerId);
}

function resolveEffectiveModel(input: {
  runtime: LlmRuntimeConfig;
  provider: RuntimeProvider;
  requestedModel?: string;
}): {
  model?: string;
  normalizationReason?: string;
  blockedReason?: string;
} {
  const fallbackModel =
    input.provider.providerId === input.runtime.activeProviderId
      ? input.runtime.activeModel || input.provider.defaultModel
      : input.provider.defaultModel;
  const normalizedRequested = input.requestedModel?.trim();
  if (!normalizedRequested) {
    const model = fallbackModel ? normalizeRequestedModel(input.provider.providerId, fallbackModel) : undefined;
    if (!model) {
      return {
        blockedReason: `No model is configured for ${input.provider.label}. Select a model first.`,
      };
    }
    return { model };
  }

  if (
    !providerAllowsForeignModelIds(input.provider.providerId) &&
    !providerRecognizesModelId(input.provider.providerId, normalizedRequested)
  ) {
    const ownerProviderId = inferProviderForModelId(normalizedRequested);
    if (ownerProviderId && ownerProviderId !== input.provider.providerId) {
      const normalizedFallback = fallbackModel
        ? normalizeRequestedModel(input.provider.providerId, fallbackModel)
        : undefined;
      if (!normalizedFallback) {
        return {
          blockedReason: `Model ${normalizedRequested} belongs to ${ownerProviderId}; choose a ${input.provider.providerId} model first.`,
        };
      }
      return {
        model: normalizedFallback,
        normalizationReason: `Model changed from ${normalizedRequested} to ${normalizedFallback} because provider ${input.provider.label} cannot run ${normalizedRequested}.`,
      };
    }
  }

  return {
    model: normalizeRequestedModel(input.provider.providerId, normalizedRequested),
  };
}

function classifyRuntime(provider: RuntimeProvider | undefined): RoutingPreflightResult["runtimeClass"] {
  if (!provider) {
    return "unknown";
  }
  return isLikelyLocalProviderUrl(provider.baseUrl) ? "local" : "cloud";
}

export async function resolveChatRouteDescriptor(
  deps: ChatRouteResolutionDependencies,
  sessionId: string,
  input: RoutingPreflightRequest,
): Promise<ResolvedChatRouteDescriptor> {
  const sessionPrefs = await deps.storage.chatSessionPrefs.ensure(sessionId);
  const previewPrefs = buildPreviewPrefs(sessionPrefs, input);
  const runtime = deps.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
  const selectionSource = describeSelectionSource(sessionPrefs, input);
  const requestedProvider = resolveRequestedProvider(runtime, previewPrefs, input);
  const requestedProviderId =
    requestedProvider?.providerId ?? input.providerId ?? previewPrefs.providerId ?? runtime.activeProviderId;
  const requestedModel = input.model ?? previewPrefs.model ?? (requestedProvider ? undefined : runtime.activeModel);

  if (!requestedProviderId) {
    return {
      requestedProviderId: undefined,
      requestedModel,
      effectiveProviderId: undefined,
      effectiveModel: undefined,
      selectionSource,
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeClass: "unknown",
      blockedReason: "No model provider is configured yet. Open Configure and connect a provider first.",
    };
  }

  if (!requestedProvider) {
    return {
      requestedProviderId,
      requestedModel,
      effectiveProviderId: requestedProviderId,
      effectiveModel: undefined,
      selectionSource,
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeClass: "unknown",
      blockedReason: `Unknown model provider: ${requestedProviderId}.`,
    };
  }

  const runtimeClass = classifyRuntime(requestedProvider);
  if (!requestedProvider.hasApiKey && runtimeClass !== "local") {
    return {
      requestedProviderId,
      requestedModel,
      effectiveProviderId: requestedProvider.providerId,
      effectiveModel: undefined,
      selectionSource,
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeClass,
      runtimeProvider: requestedProvider,
      blockedReason: `${requestedProvider.label} is not configured yet. Add an API key before using it.`,
    };
  }

  const effectiveModelResolution = resolveEffectiveModel({
    runtime,
    provider: requestedProvider,
    requestedModel,
  });
  const effectiveProviderId = requestedProvider.providerId;
  const effectiveModel = effectiveModelResolution.model;
  const requestShape = {
    providerId:
      selectionSource === "manual"
        ? input.providerId
        : selectionSource === "session"
          ? previewPrefs.providerId
          : undefined,
    model: selectionSource === "manual" ? input.model : selectionSource === "session" ? previewPrefs.model : undefined,
  };
  const fallbackPolicy =
    !effectiveProviderId || !effectiveModel
      ? "off"
      : shouldAllowCrossProviderFallback(requestShape) &&
          deps.resolveFallbackTargets(runtime, effectiveProviderId, effectiveModel).length > 0
        ? "armed"
        : "off";
  const fallbackTarget =
    fallbackPolicy === "armed" && effectiveProviderId && effectiveModel
      ? deps.resolveFallbackTargets(runtime, effectiveProviderId, effectiveModel)[0]
      : undefined;
  const fallbackResult = !fallbackTarget
    ? "not_applicable"
    : classifyRuntime(requestedProvider) ===
        classifyRuntime(runtime.providers.find((provider) => provider.providerId === fallbackTarget.providerId))
      ? "same_boundary"
      : runtimeClass === "local"
        ? "local_to_cloud"
        : "cloud_to_local";
  const degradedReason =
    fallbackPolicy === "armed"
      ? fallbackResult === "same_boundary"
        ? "Fallback is armed if the primary route fails."
        : fallbackResult === "local_to_cloud"
          ? "Fallback may move this run from local to cloud if the primary route fails."
          : fallbackResult === "cloud_to_local"
            ? "Fallback may move this run from cloud to local if the primary route fails."
            : undefined
      : undefined;

  return {
    requestedProviderId,
    requestedModel,
    effectiveProviderId,
    effectiveModel,
    selectionSource,
    normalizationReason: effectiveModelResolution.normalizationReason,
    fallbackPolicy,
    fallbackResult,
    runtimeClass,
    blockedReason: effectiveModelResolution.blockedReason,
    degradedReason,
    runtimeProvider: requestedProvider,
    fallbackTarget,
  };
}

export async function preflightChatRoute(
  deps: ChatRouteResolutionDependencies,
  sessionId: string,
  input: RoutingPreflightRequest,
): Promise<RoutingPreflightResult> {
  if ((input.action === "retry" || input.action === "edit") && input.turnId && deps.requireChatTurnContext) {
    await deps.requireChatTurnContext(sessionId, input.turnId);
  }

  const descriptor = await resolveChatRouteDescriptor(deps, sessionId, input);
  let runtimeReachability: RoutingPreflightResult["runtimeReachability"] = "not_checked";
  let blockedReason = descriptor.blockedReason;

  if (
    !blockedReason &&
    descriptor.runtimeClass === "local" &&
    descriptor.runtimeProvider?.providerId &&
    deps.listLlmModels
  ) {
    try {
      const models = await deps.listLlmModels(descriptor.runtimeProvider.providerId);
      runtimeReachability = models.length > 0 ? "reachable" : "models_unavailable";
      if (models.length === 0) {
        blockedReason = `No models are currently available for ${descriptor.runtimeProvider.label}.`;
      }
    } catch {
      runtimeReachability = "unreachable";
      blockedReason = `The ${descriptor.runtimeProvider.label} runtime could not be reached.`;
    }
  } else if (!blockedReason && descriptor.runtimeClass === "cloud" && descriptor.runtimeProvider?.hasApiKey) {
    runtimeReachability = "not_checked";
  }

  const capabilityProfile =
    input.content?.trim() && deps.resolveCapabilityPreflight
      ? await deps.resolveCapabilityPreflight(sessionId, input, {
          ...descriptor,
          blockedReason,
        })
      : undefined;
  const frozenFallbackPolicy = capabilityProfile ? "off" : descriptor.fallbackPolicy;
  const frozenFallbackResult = capabilityProfile ? "not_applicable" : descriptor.fallbackResult;

  const resultWithoutDecision = {
    requestedProviderId: descriptor.requestedProviderId,
    requestedModel: descriptor.requestedModel,
    effectiveProviderId: descriptor.effectiveProviderId,
    effectiveModel: descriptor.effectiveModel,
    selectionSource: descriptor.selectionSource,
    normalizationReason: descriptor.normalizationReason,
    fallbackPolicy: frozenFallbackPolicy,
    fallbackResult: frozenFallbackResult,
    runtimeReachability,
    runtimeClass: descriptor.runtimeClass,
    blockedReason,
    degradedReason: descriptor.degradedReason,
    ...(capabilityProfile ? { capabilityProfile } : {}),
  } satisfies Omit<RoutingPreflightResult, "decision">;

  return {
    ...resultWithoutDecision,
    decision: createRoutingDecisionSnapshot(input, resultWithoutDecision),
  };
}

export function createRoutingDecisionSnapshot(
  input: RoutingPreflightRequest,
  result: Omit<RoutingPreflightResult, "decision">,
  now = new Date(),
): RoutingDecisionSnapshot {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ROUTING_DECISION_TTL_MS).toISOString();
  const snapshotWithoutFingerprint = {
    action: input.action,
    turnId: input.turnId,
    issuedAt,
    expiresAt,
    requestedProviderId: result.requestedProviderId,
    requestedModel: result.requestedModel,
    effectiveProviderId: result.effectiveProviderId,
    effectiveModel: result.effectiveModel,
    selectionSource: result.selectionSource,
    normalizationReason: result.normalizationReason,
    fallbackPolicy: result.fallbackPolicy,
    fallbackResult: result.fallbackResult,
    runtimeReachability: result.runtimeReachability,
    runtimeClass: result.runtimeClass,
    blockedReason: result.blockedReason,
    degradedReason: result.degradedReason,
    capabilityFingerprint: result.capabilityProfile?.fingerprint,
    capabilityContentHash: result.capabilityProfile?.contentHash,
    capabilityProfileSchemaVersion: result.capabilityProfile?.schemaVersion,
    capabilityCompactionDimensionHash: result.capabilityProfile?.compactionDimensionHash,
  };
  return {
    ...snapshotWithoutFingerprint,
    fingerprint: createRoutingDecisionFingerprint(snapshotWithoutFingerprint),
  };
}

export function createRoutingDecisionFingerprint(
  input: Omit<RoutingDecisionSnapshot, "fingerprint" | "issuedAt" | "expiresAt" | "selectionSource"> & {
    selectionSource?: RoutingDecisionSnapshot["selectionSource"];
    issuedAt?: string;
    expiresAt?: string;
  },
): string {
  const payload = {
    action: input.action,
    turnId: input.turnId,
    requestedProviderId: input.requestedProviderId,
    requestedModel: input.requestedModel,
    effectiveProviderId: input.effectiveProviderId,
    effectiveModel: input.effectiveModel,
    selectionSource: input.selectionSource,
    normalizationReason: input.normalizationReason,
    fallbackPolicy: input.fallbackPolicy,
    fallbackResult: input.fallbackResult,
    runtimeReachability: input.runtimeReachability,
    runtimeClass: input.runtimeClass,
    blockedReason: input.blockedReason,
    degradedReason: input.degradedReason,
    capabilityFingerprint: input.capabilityFingerprint,
    capabilityContentHash: input.capabilityContentHash,
    capabilityProfileSchemaVersion: input.capabilityProfileSchemaVersion,
    capabilityCompactionDimensionHash: input.capabilityCompactionDimensionHash,
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}
