import type { DiscordPairingRecord } from "@goatcitadel/contracts";
import { approvedDiscordActorIds, createErrandOriginDeps, type ErrandOriginSources } from "./errand-origin.js";
import { isErrandOwner } from "./errand-owner.js";

/** What a channel shows someone who presses an errand approval button without being the operator's own account. */
export const ERRAND_OWNER_ONLY_COPY = "Only the owner can answer this.";

/** Thrown before the action token is consumed, so the approval stays pending for its owner. */
export class ErrandOwnerOnlyError extends Error {
  public constructor() {
    super(ERRAND_OWNER_ONLY_COPY);
    this.name = "ErrandOwnerOnlyError";
  }
}

export interface ErrandPressGuardDeps {
  connection(connectionId: string): Promise<{ key: string; config: Record<string, unknown> } | undefined>;
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
}

export interface ErrandPressInput {
  /** The connector the action token is bound to, "integration:<connectionId>" for a channel connection. */
  connectorId: string;
  /** The provider user id that pressed the button. */
  actorId: string;
}

const INTEGRATION_CONNECTOR_PREFIX = "integration:";

/**
 * Builds the check that only the operator's own account answers an errand approval from a channel. Anything it
 * cannot establish (no connection, a connector that is not a channel connection) counts as not the owner.
 */
export function createErrandPressGuard(deps: ErrandPressGuardDeps): (input: ErrandPressInput) => Promise<void> {
  return async ({ connectorId, actorId }) => {
    const connectionId = connectorId.startsWith(INTEGRATION_CONNECTOR_PREFIX)
      ? connectorId.slice(INTEGRATION_CONNECTOR_PREFIX.length)
      : "";
    const connection = connectionId ? await deps.connection(connectionId).catch(() => undefined) : undefined;
    if (!connection) {
      throw new ErrandOwnerOnlyError();
    }
    const discordApprovedActorIds =
      connection.key === "discord"
        ? approvedDiscordActorIds(await deps.readDiscordPairings().catch(() => []), connectionId)
        : undefined;
    const owner = isErrandOwner({
      channelKey: connection.key,
      config: connection.config,
      actorId,
      ...(discordApprovedActorIds ? { discordApprovedActorIds } : {}),
    });
    if (!owner) {
      throw new ErrandOwnerOnlyError();
    }
  };
}

/** The press guard over Gateway storage and the Gateway's Discord pairing reader. */
export function createGatewayErrandPressGuard(
  sources: ErrandOriginSources,
): (input: ErrandPressInput) => Promise<void> {
  return createErrandPressGuard(createErrandOriginDeps(sources));
}
