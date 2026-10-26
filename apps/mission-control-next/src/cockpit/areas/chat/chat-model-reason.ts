import type { ChatThreadTurnRecord, RoutingPreflightResult } from "@goatcitadel/contracts";
import { presentErrorText } from "../../lib/present-error";

/** What to say when a routing value is missing or one this version does not know. Never the raw value. */
export const NEUTRAL_MODEL_REASON = "Selected by routing rules";

/** Plain words for where a route preflight's model came from. Unknown values read neutrally, never as the raw enum. */
export function presentSelectionSource(source: string | null | undefined): string {
  switch (source) {
    case "manual":
      return "You picked this model";
    case "session":
      return "Set for this conversation";
    case "global":
      return "Workspace default";
    case "citadel_ward_route_local":
      return "Kept on a local model by a Citadel Ward";
    default:
      return NEUTRAL_MODEL_REASON;
  }
}

type PreflightReasonInput = Pick<RoutingPreflightResult, "selectionSource" | "normalizationReason" | "degradedReason">;

/**
 * Why the next message will use its model: the selection source, plus a short note when the gateway adjusted the
 * model or is running degraded. The recorded sentences name ids, so they stay out of this line.
 */
export function presentPreflightReason(route: PreflightReasonInput): string {
  const base = presentSelectionSource(route.selectionSource);
  if (route.degradedReason) return `${base}; a fallback is in use because the first choice is unavailable`;
  if (route.normalizationReason) return `${base}; adjusted to a model the provider can run`;
  return base;
}

type TraceRouting = ChatThreadTurnRecord["trace"]["routing"];

/**
 * Why a finished turn used its model, from what the turn trace recorded. A turn does not record which setting chose
 * the model, so this names a fallback or adjustment when one is recorded and otherwise says the selected model ran.
 */
export function presentTurnModelReason(
  routing: TraceRouting | undefined,
  requestedLabel: string | null,
  recordedModel: boolean,
): string {
  if (!routing || !recordedModel) return NEUTRAL_MODEL_REASON;
  if (routing.fallbackUsed) {
    const from = requestedLabel ? `Fell back from ${requestedLabel}` : "Fell back from the model that was selected";
    const reason = routing.fallbackReason ? presentErrorText(routing.fallbackReason).summary : "";
    return reason ? `${from} because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`.replace(/\.$/u, "") : from;
  }
  if (routing.usedVisionFallback) return "Switched to a model that can read images";
  const changed =
    Boolean(routing.primaryModel) &&
    Boolean(routing.effectiveModel) &&
    (routing.primaryModel !== routing.effectiveModel ||
      (routing.primaryProviderId &&
        routing.effectiveProviderId &&
        routing.primaryProviderId !== routing.effectiveProviderId));
  if (changed) return "Adjusted by routing rules";
  return routing.primaryModel ? "The requested model; no fallback was needed" : NEUTRAL_MODEL_REASON;
}
