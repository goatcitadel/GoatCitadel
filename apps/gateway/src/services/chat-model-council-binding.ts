import { createHash } from "node:crypto";
import { canonicalJsonString, type ModelUsageAttributionContext } from "@goatcitadel/contracts";
import type { ModelCouncilBinding, ModelCouncilProviderCandidate } from "./assembly-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { LlmService } from "./llm-service.js";

export type ModelCouncilCandidateLlm = Pick<
  LlmService,
  | "getRuntimeConfig"
  | "getModelContextWindow"
  | "getProviderRouteConfigFingerprint"
  | "resolveExecutionApiStyle"
  | "admitsDispatchWard"
>;

type CouncilRoute = { providerId: string; model: string };

/** The primary route a council runs under: the historical profile's, or the admitted feature route. */
export function resolveModelCouncilPrimaryRoute(prepared: PreparedAgentChatTurn): CouncilRoute | undefined {
  const profile = prepared.capabilityProfile;
  if (profile) {
    const providerId = profile.selection.effectiveProviderId;
    const model = profile.selection.effectiveModel;
    return providerId && model ? { providerId, model } : undefined;
  }
  return prepared.featureAdmission?.references.providerRoute?.primary;
}

/**
 * Rechecks every council member route against current authority at selection
 * time: provider configured (or local), trusted context-window metadata, a
 * current route-config fingerprint, the xAI/Grok exclusion, and the Citadel
 * Ward `model.chat.<providerId>` decision for an Assembly participant. Members
 * are tool-free, so no tool catalog is involved. Dispatch still rechecks the ward.
 */
export async function selectModelCouncilCandidates(
  llm: ModelCouncilCandidateLlm,
  prepared: PreparedAgentChatTurn,
  primary: CouncilRoute,
): Promise<ModelCouncilProviderCandidate[]> {
  const runtime = llm.getRuntimeConfig({ includeKeychainForActiveProvider: true, useCache: true });
  const attribution: ModelUsageAttributionContext = {
    callKind: "assembly_participant",
    workspaceId: prepared.workspaceId,
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    // A route_local ward on the requested provider still binds every member.
    ...(prepared.routeWardActions?.length ? { wardActions: [...prepared.routeWardActions] } : {}),
  };
  const candidates: ModelCouncilProviderCandidate[] = [];
  for (const provider of runtime.providers) {
    const model = provider.providerId === primary.providerId ? primary.model : provider.defaultModel;
    if (!model || /(?:^|[-_./:\s])(x-?ai|grok)(?:$|[-_./:\s])/i.test(`${provider.providerId} ${model}`)) continue;
    const local = isLocalProviderUrl(provider.baseUrl);
    const contextWindowTokens = llm.getModelContextWindow(provider.providerId, model);
    const routeConfigFingerprint = llm.getProviderRouteConfigFingerprint(provider.providerId, model);
    if ((!provider.hasApiKey && !local) || !contextWindowTokens || !routeConfigFingerprint) continue;
    if (!(await llm.admitsDispatchWard(attribution, provider.providerId))) continue;
    candidates.push({
      providerId: provider.providerId,
      model,
      apiStyle: llm.resolveExecutionApiStyle(provider.providerId, model),
      contextWindowTokens,
      routeConfigFingerprint,
    });
  }
  return candidates.sort((left, right) =>
    `${left.providerId}:${left.model}`.localeCompare(`${right.providerId}:${right.model}`),
  );
}

/**
 * Profile-free council binding for a new turn: the turn's immutable feature
 * admission (id and reference hash) and its admitted primary route. The primary
 * is ready only when it survived the live member recheck.
 */
export function resolveLiveModelCouncilBinding(
  prepared: PreparedAgentChatTurn,
  candidates: readonly ModelCouncilProviderCandidate[],
): ModelCouncilBinding {
  const admission = prepared.featureAdmission;
  const identity = prepared.turnAdmission?.identity;
  const primary = admission?.references.providerRoute?.primary;
  if (!admission?.references.modelCouncil || !identity || !primary) {
    throw new Error("Model council requires an admitted council request with a pinned provider route.");
  }
  const thinkingLevel = prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel;
  return {
    bindingId: `feature-admission:${identity.admissionId}`,
    // The admission hash plus the effective thinking level, so recovery under a
    // different synthesis reasoning budget is refused like any other drift.
    bindingHash: createHash("sha256")
      .update(canonicalJsonString({ referenceSha256: admission.referenceSha256, thinkingLevel: thinkingLevel ?? null }))
      .digest("hex"),
    turnId: prepared.turnId,
    sessionId: prepared.session.sessionId,
    workspaceId: prepared.workspaceId,
    primaryProviderId: primary.providerId,
    primaryModel: primary.model,
    thinkingLevel,
    primaryReady: candidates.some(
      (candidate) => candidate.providerId === primary.providerId && candidate.model === primary.model,
    ),
  };
}

function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  try {
    const hostname = new URL((baseUrl ?? "").trim()).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(hostname)
    );
  } catch {
    return false;
  }
}
