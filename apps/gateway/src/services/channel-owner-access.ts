import { evaluateChannelInboundAccess, resolveChannelOwnerActorIds } from "@goatcitadel/contracts";

/**
 * The operator's own accounts that a connection lets in without pairing: owners (`ownerActorIds`) who are also on the
 * sender allowlist, on a connection that lets only allowlisted senders in (`inboundAccessMode: "allowlist"`).
 *
 * Being marked as an owner is not enough on its own. Chat's "This is you" mark saves `ownerActorIds` for a pairing the
 * operator already approved, and revoking that pairing does not unmark them, so the allowlist is what stops a taken-off
 * account being recognized. Connections that are open or have no access mode set are left to pairing, as before.
 * The ids come back trimmed and lowercased, as `resolveChannelOwnerActorIds` returns them.
 */
export function resolveAllowlistedOwnerActorIds(config: Record<string, unknown>): string[] {
  if (config.inboundAccessMode !== "allowlist") {
    return [];
  }
  return resolveChannelOwnerActorIds(config).filter((actorId) => {
    const access = evaluateChannelInboundAccess({ config, actorId });
    return access.mode === "allowlist" && access.allowed;
  });
}

/** Whether this sender is one of the connection's owners who are also allowlisted (see `resolveAllowlistedOwnerActorIds`). */
export function isAllowlistedChannelOwner(config: Record<string, unknown>, actorId: string): boolean {
  return resolveAllowlistedOwnerActorIds(config).includes(actorId.trim().toLowerCase());
}
