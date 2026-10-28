/** Why a call is GoatCitadel's own: a reply on a channel, or something the operator did themselves. */
export type OwnDeliveryReason = "channel_reply" | "operator_action";

/**
 * Gateway-authored, process-local proof that a tool call is GoatCitadel's own delivery (a channel reply, the
 * operator's own send or a Library action) rather than the AI's. It lets that call past a switched-off tool group
 * and nothing else: deny rules, Wards, approvals and every other check still apply. Only markers minted here count,
 * so a look-alike object from a request body, tool argument, approval row or model output is ignored.
 */
export interface OwnDeliveryMarker {
  readonly kind: "own_delivery";
  readonly reason: OwnDeliveryReason;
}

const mintedMarkers = new WeakSet<OwnDeliveryMarker>();
const OWN_DELIVERY_REASONS: ReadonlySet<string> = new Set<OwnDeliveryReason>(["channel_reply", "operator_action"]);

/** A frozen marker registered in a module-private WeakSet; only registered objects count. */
export function createOwnDeliveryMarker(reason: OwnDeliveryReason): OwnDeliveryMarker {
  if (!OWN_DELIVERY_REASONS.has(reason)) {
    throw new Error("Invalid own-delivery reason");
  }
  const marker: OwnDeliveryMarker = Object.freeze({ kind: "own_delivery", reason });
  mintedMarkers.add(marker);
  return marker;
}

/** True only for a marker minted by createOwnDeliveryMarker; anything else, including a copy, is not one. */
export function isOwnDeliveryMarker(value: unknown): value is OwnDeliveryMarker {
  return typeof value === "object" && value !== null && mintedMarkers.has(value as OwnDeliveryMarker);
}

/*
 * An own call that asks first stays own once the operator approves it. The approval runtime later runs it knowing
 * only the approval id, so the policy engine records the fact on the approval's `pending_action_registered` event
 * (engine-authored, outside the stored request the approval checks match) and re-mints a marker from it at run time.
 * Both helpers are engine-internal: the package index doesn't re-export them, and a guard pins them to the engine.
 */
const REGISTRATION_EVENT_TYPE = "pending_action_registered";

/** The registration-payload field for a genuine marker, and nothing for anything else. */
export function ownDeliveryRegistrationFact(marker: unknown): { ownDelivery?: OwnDeliveryReason } {
  return isOwnDeliveryMarker(marker) ? { ownDelivery: marker.reason } : {};
}

/**
 * A fresh marker for an approved `tool.invoke` whose one registration event the engine wrote with the own fact. More
 * than one registration, another action type or tool, or an unknown reason gives none, so the switch still applies.
 */
export function mintOwnDeliveryFromRegistration(
  events: readonly { eventType: string; payload?: Record<string, unknown> }[],
  toolName: string,
): OwnDeliveryMarker | undefined {
  const registrations = events.filter((event) => event.eventType === REGISTRATION_EVENT_TYPE);
  const payload = registrations.length === 1 ? registrations[0]?.payload : undefined;
  const reason = payload?.ownDelivery;
  if (payload?.actionType !== "tool.invoke" || payload.toolName !== toolName || typeof reason !== "string") {
    return undefined;
  }
  return OWN_DELIVERY_REASONS.has(reason) ? createOwnDeliveryMarker(reason as OwnDeliveryReason) : undefined;
}
