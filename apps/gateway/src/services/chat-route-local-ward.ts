import {
  PolicyViolationError,
  type CitadelWard,
  type LlmProviderConfig,
  type LlmProviderSummary,
  type RoutingWardReasonCode,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { isLocalChatProviderUrl } from "./chat-provider-fallback-authority.js";
import { resolveWardEffectForExternalAction, type CitadelWardGateStorage } from "./citadel-ward-gate.js";
import type { LlmService } from "./llm-service.js";
import { inferRuntimeEngineKind } from "./llm-runtime-truth-service.js";
import type { ResolvedChatRouteDescriptor } from "./chat-route-resolution.js";

/**
 * Citadel Ward `route_local` enforcement for Chat model routing.
 *
 * Every Chat turn evaluates `model.chat.<providerId>` against the session's
 * workspace citadel (personal citadel when unbound). Only `deny` and
 * `route_local` wards apply at this boundary: `deny` blocks the turn, and
 * `route_local` keeps the turn on a strictly local backend or blocks it.
 * Other effects (`require_approval`, `require_dry_run`, `redact`) are not
 * enforced for model routing, so they are filtered out before the deny-wins
 * evaluation instead of hiding a matching `route_local` ward.
 *
 * `model.tool.<toolName>` is not wired here: there is no single model-backed
 * tool boundary to gate yet.
 */

type LlmRuntimeConfig = ReturnType<LlmService["getRuntimeConfig"]>;
type RuntimeProvider = LlmRuntimeConfig["providers"][number];
type ModelAvailability = ReturnType<LlmService["getCachedModelAvailability"]>;
type RouteLocalProviderShape = Pick<LlmProviderSummary | LlmProviderConfig, "providerId" | "baseUrl">;

export const ROUTE_LOCAL_UNAVAILABLE_MESSAGE =
  "A Citadel Ward requires this chat to stay on a local model, and no local model route is available.";
export const MODEL_CHAT_WARD_DENY_MESSAGE = "A Citadel Ward denies chat with this model provider.";

const BLOCKING_WARD_REASON_CODES: ReadonlySet<RoutingWardReasonCode> = new Set([
  "citadel_ward_route_local_unavailable",
  "citadel_ward_deny",
]);

export interface RouteLocalWardDependencies {
  readonly storage: Partial<Pick<Storage, "workspaces" | "citadels" | "chatSessionMeta">>;
  resolveSessionWorkspaceId?(sessionId: string): Promise<string | undefined>;
}

export function buildModelChatWardAction(providerId: string): string {
  return `model.chat.${providerId}`;
}

/** Strict loopback check: `localhost`, `127.0.0.0/8` or `[::1]` over http(s). */
export function isLoopbackUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * A provider is route-local only when it is an Ollama or llama.cpp engine on a
 * local URL, or a generic OpenAI-compatible endpoint on a loopback host. Named
 * proxy or hosted engines (LiteLLM, remote APIs) never count, even on loopback.
 */
export function isRouteLocalProvider(provider: RouteLocalProviderShape): boolean {
  const engineKind = inferRuntimeEngineKind(provider);
  if (engineKind === "ollama" || engineKind === "llama_cpp") {
    return isLocalChatProviderUrl(provider.baseUrl);
  }
  // Engine inference reports an unrecognized loopback host (127.0.0.2, [::1]) as
  // remote_api, so both kinds are the generic OpenAI-compatible case here.
  if (engineKind === "openai_compatible" || engineKind === "remote_api") {
    return isLoopbackUrl(provider.baseUrl);
  }
  return false;
}

export function selectRouteLocalProvider<TProvider extends RouteLocalProviderShape & { defaultModel?: string }>(input: {
  providers: readonly TProvider[];
  getModelAvailability?(providerId: string, model: string): ModelAvailability;
  isProviderDenied?(providerId: string): boolean;
}): { provider: TProvider; model: string } | undefined {
  for (const provider of input.providers) {
    const model = provider.defaultModel?.trim();
    if (!model || !isRouteLocalProvider(provider) || input.isProviderDenied?.(provider.providerId)) continue;
    const availability = input.getModelAvailability?.(provider.providerId, model);
    if (availability === "unavailable" || availability === "stale_unavailable") continue;
    return { provider, model };
  }
  return undefined;
}

/** Fails a turn closed when its route descriptor carries a blocking ward code. */
export function assertChatRouteWardAdmitsTurn(
  descriptor: Pick<ResolvedChatRouteDescriptor, "wardReasonCode" | "wardCitadelId" | "blockedReason"> | undefined,
): void {
  const reason = descriptor?.wardReasonCode;
  if (!reason || !BLOCKING_WARD_REASON_CODES.has(reason)) return;
  throw new PolicyViolationError({
    message: descriptor.blockedReason ?? ROUTE_LOCAL_UNAVAILABLE_MESSAGE,
    details: { reason, citadelId: descriptor.wardCitadelId },
  });
}

/** Diagnostic fields for each turn-entry `recordDevDiagnostic` context. */
export function describeChatRouteWard(
  descriptor: Pick<ResolvedChatRouteDescriptor, "wardReasonCode" | "wardCitadelId">,
): { wardReasonCode?: RoutingWardReasonCode; wardCitadelId?: string } {
  return { wardReasonCode: descriptor.wardReasonCode, wardCitadelId: descriptor.wardCitadelId };
}

/**
 * Applies the `model.chat.*` ward to a resolved descriptor. Returns the
 * descriptor unchanged when no ward storage is wired or no ward applies.
 */
export async function enforceRouteLocalWard(input: {
  deps: RouteLocalWardDependencies;
  sessionId: string;
  runtime: LlmRuntimeConfig;
  descriptor: ResolvedChatRouteDescriptor;
  getModelAvailability?(providerId: string, model: string): ModelAvailability;
}): Promise<ResolvedChatRouteDescriptor> {
  const { descriptor } = input;
  const requestedProviderId = descriptor.requestedProviderId;
  const wardStorage = buildModelChatWardStorage(input.deps.storage);
  if (!requestedProviderId || !wardStorage) return descriptor;
  const workspaceId = await resolveWorkspaceId(input.deps, input.sessionId);
  const evaluate = (providerId: string) =>
    resolveWardEffectForExternalAction({
      storage: wardStorage,
      workspaceId,
      action: buildModelChatWardAction(providerId),
    });
  const ward = await evaluate(requestedProviderId);
  if (ward.effect === "deny") {
    return blockDescriptor(descriptor, "citadel_ward_deny", ward.citadelId, MODEL_CHAT_WARD_DENY_MESSAGE);
  }
  if (ward.effect !== "route_local") return descriptor;

  const requestedProvider = descriptor.runtimeProvider;
  if (
    requestedProvider &&
    requestedProvider.providerId === requestedProviderId &&
    isRouteLocalProvider(requestedProvider)
  ) {
    return keepLocalDescriptor(input.runtime, descriptor, ward.citadelId);
  }
  const deniedProviderIds = new Set<string>();
  for (const provider of input.runtime.providers) {
    if ((await evaluate(provider.providerId)).effect === "deny") deniedProviderIds.add(provider.providerId);
  }
  const selected = selectRouteLocalProvider({
    providers: input.runtime.providers,
    getModelAvailability: input.getModelAvailability,
    isProviderDenied: (providerId) => deniedProviderIds.has(providerId),
  });
  if (!selected) {
    return blockDescriptor(
      descriptor,
      "citadel_ward_route_local_unavailable",
      ward.citadelId,
      ROUTE_LOCAL_UNAVAILABLE_MESSAGE,
    );
  }
  return switchToLocalDescriptor(descriptor, selected.provider, selected.model, ward.citadelId);
}

function buildModelChatWardStorage(storage: RouteLocalWardDependencies["storage"]): CitadelWardGateStorage | undefined {
  const citadels = storage.citadels;
  if (!citadels) return undefined;
  const wardsByCitadel = new Map<string, Promise<CitadelWard[]>>();
  const listEnforcedWards = (citadelId: string) => {
    const cached = wardsByCitadel.get(citadelId);
    if (cached) return cached;
    const loaded = Promise.resolve(citadels.listWards(citadelId)).then((wards) =>
      wards.filter((ward) => ward.effect === "deny" || ward.effect === "route_local"),
    );
    wardsByCitadel.set(citadelId, loaded);
    return loaded;
  };
  return { workspaces: storage.workspaces, citadels: { listWards: listEnforcedWards } };
}

async function resolveWorkspaceId(deps: RouteLocalWardDependencies, sessionId: string): Promise<string | undefined> {
  if (deps.resolveSessionWorkspaceId) return await deps.resolveSessionWorkspaceId(sessionId);
  return (await deps.storage.chatSessionMeta?.get(sessionId))?.workspaceId;
}

function withoutFallback(descriptor: ResolvedChatRouteDescriptor): ResolvedChatRouteDescriptor {
  return {
    ...descriptor,
    fallbackPolicy: "off",
    fallbackResult: "not_applicable",
    fallbackTarget: undefined,
    providerFallback: undefined,
  };
}

function keepLocalDescriptor(
  runtime: LlmRuntimeConfig,
  descriptor: ResolvedChatRouteDescriptor,
  citadelId: string,
): ResolvedChatRouteDescriptor {
  const fallbackProvider = descriptor.providerFallback
    ? runtime.providers.find((provider) => provider.providerId === descriptor.providerFallback?.providerId)
    : undefined;
  const base =
    descriptor.providerFallback && !(fallbackProvider && isRouteLocalProvider(fallbackProvider))
      ? withoutFallback(descriptor)
      : descriptor;
  return { ...base, wardReasonCode: "citadel_ward_route_local", wardCitadelId: citadelId };
}

function switchToLocalDescriptor(
  descriptor: ResolvedChatRouteDescriptor,
  provider: RuntimeProvider,
  model: string,
  citadelId: string,
): ResolvedChatRouteDescriptor {
  return {
    ...withoutFallback(descriptor),
    effectiveProviderId: provider.providerId,
    effectiveModel: model,
    selectionSource: "citadel_ward_route_local",
    normalizationReason: `A Citadel Ward keeps this chat on a local model, so it routes to ${provider.label} (${model}).`,
    runtimeClass: "local",
    runtimeProvider: provider,
    blockedReason: undefined,
    wardReasonCode: "citadel_ward_route_local",
    wardCitadelId: citadelId,
  };
}

function blockDescriptor(
  descriptor: ResolvedChatRouteDescriptor,
  wardReasonCode: RoutingWardReasonCode,
  citadelId: string,
  blockedReason: string,
): ResolvedChatRouteDescriptor {
  return {
    ...withoutFallback(descriptor),
    effectiveModel: undefined,
    blockedReason,
    wardReasonCode,
    wardCitadelId: citadelId,
  };
}
