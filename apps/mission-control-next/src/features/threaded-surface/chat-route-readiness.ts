import type { RoutingPreflightResult } from "@goatcitadel/contracts";

export type ChatRouteReadinessState = "checking" | "ready" | "no_provider" | "blocked";

export interface ChatRouteReadiness {
  state: ChatRouteReadinessState;
  title: string;
  message: string;
  /** Short reason shown beside a disabled Send; null when sending is not route-blocked. */
  sendHint: string | null;
  /** Raw Gateway wording, kept for technical details rather than the default view. */
  technicalReason?: string;
}

export interface ChatRouteReadinessInput {
  routePreflight?: RoutingPreflightResult | null;
  routePreflightError?: string | null;
  routePreflightLoading?: boolean;
  providerOptions?: ReadonlyArray<{ disabled?: boolean; models: readonly string[] }>;
}

const NO_PROVIDER_MESSAGE = "Sending a message needs a model. Connect a cloud provider or a local model in Settings.";

/** The Gateway blocks without naming any provider only when none is configured at all. */
function isNoProviderPreflight(routePreflight?: RoutingPreflightResult | null): boolean {
  return (
    Boolean(routePreflight?.blockedReason) &&
    !routePreflight?.requestedProviderId &&
    !routePreflight?.effectiveProviderId
  );
}

/** Blocked-route copy for detail surfaces; null when the preflight does not block. */
export function describeRouteBlockedReason(routePreflight?: RoutingPreflightResult | null): string | null {
  if (!routePreflight?.blockedReason) return null;
  return isNoProviderPreflight(routePreflight) ? NO_PROVIDER_MESSAGE : routePreflight.blockedReason;
}

/**
 * One projection of the Gateway route preflight for every Chat surface, so the
 * canvas, composer, and drawers agree. "No provider" is recognized from the
 * preflight shape (nothing was requested at all), never by parsing its copy.
 */
export function resolveChatRouteReadiness(input: ChatRouteReadinessInput): ChatRouteReadiness {
  const { routePreflight, routePreflightError } = input;
  const hasModelChoices = (input.providerOptions ?? []).some(
    (provider) => !provider.disabled && provider.models.length > 0,
  );
  if (input.routePreflightLoading || (!routePreflight && !routePreflightError && hasModelChoices)) {
    return {
      state: "checking",
      title: "Checking chat route",
      message: "Checking the available provider and model before the first send.",
      sendHint: null,
    };
  }
  if (isNoProviderPreflight(routePreflight) || (!routePreflight && !routePreflightError && !hasModelChoices)) {
    return {
      state: "no_provider",
      title: "No model connected yet",
      message: NO_PROVIDER_MESSAGE,
      sendHint: "No model is connected yet.",
      ...(routePreflight?.blockedReason ? { technicalReason: routePreflight.blockedReason } : {}),
    };
  }
  const blockedReason =
    routePreflight?.blockedReason ??
    routePreflightError ??
    (!routePreflight?.effectiveProviderId || !routePreflight?.effectiveModel
      ? "Choose a provider and model before sending."
      : null);
  if (blockedReason) {
    return { state: "blocked", title: "Chat sending is blocked", message: blockedReason, sendHint: blockedReason };
  }
  return {
    state: "ready",
    title: "Chat ready",
    message: "Runtime, policy, and context are visible before the first send.",
    sendHint: null,
  };
}
