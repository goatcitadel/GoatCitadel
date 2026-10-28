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
