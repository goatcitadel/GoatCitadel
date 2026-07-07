/**
 * Approval remote-action-token consumption service.
 *
 * Owns the single-use consumption of server-minted remote action tokens behind
 * an explicit, narrow host contract. These functions enforce the security
 * invariants of the public `/remote-resolve` surface: tokens must be present,
 * known, bound to the expected action type, unexpired, and not previously
 * consumed.
 *
 * ApprovalRemoteTokenHost documents exactly which capabilities remote-token
 * consumption requires. GatewayService satisfies this interface, but it is not
 * the only possible implementation.
 */

import { type RemoteActionTokenRecord, ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { hashSensitiveToken } from "./device-access-helpers.js";

/**
 * Narrow interface describing exactly what remote-action-token consumption
 * needs from its host. GatewayService satisfies this interface, but the
 * explicit contract keeps the dependency surface auditable and testable.
 */
export interface ApprovalRemoteTokenHost {
  readonly storage: Pick<Storage, "remoteActionTokens">;
}

/**
 * Consume a remote action token by its raw (unhashed) value. Validates that the
 * token is present, resolvable, bound to `expectedActionType`, unexpired, and
 * still pending, then atomically marks it consumed.
 */
export function consumeRemoteActionToken(
  host: ApprovalRemoteTokenHost,
  token: string,
  expectedActionType: RemoteActionTokenRecord["actionType"],
): RemoteActionTokenRecord {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new ValidationError({
      message: "Remote action token is required.",
    });
  }
  const current = host.storage.remoteActionTokens.findByTokenHash(hashSensitiveToken(normalizedToken));
  if (!current) {
    throw new NotFoundError({
      entity: "Remote action token",
      id: "unknown",
    });
  }
  if (current.actionType !== expectedActionType) {
    throw new ConflictError({
      message: `Remote action token is bound to ${current.actionType}, not ${expectedActionType}.`,
    });
  }
  if (current.state !== "pending") {
    throw new ConflictError({
      message: "Remote action token has already been consumed.",
    });
  }
  const expiresAt = Date.parse(current.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    host.storage.remoteActionTokens.updateState(current.tokenId, "expired");
    throw new ConflictError({
      message: "Remote action token has expired.",
    });
  }
  const consumed = host.storage.remoteActionTokens.consumePending(current.tokenId, {
    consumedAt: new Date().toISOString(),
    consumedBy: `connector:${current.connectorId}`,
  });
  if (!consumed) {
    throw new ConflictError({
      message: "Remote action token has already been consumed.",
    });
  }
  return consumed;
}

/**
 * Consume a remote action token by its opaque token id. Same invariants as
 * {@link consumeRemoteActionToken}, but resolves the record by id rather than by
 * hashing a raw token value.
 */
export function consumeRemoteActionTokenById(
  host: ApprovalRemoteTokenHost,
  tokenId: string,
  expectedActionType: RemoteActionTokenRecord["actionType"],
): RemoteActionTokenRecord {
  const normalizedTokenId = tokenId.trim();
  if (!normalizedTokenId) {
    throw new ValidationError({
      message: "Remote action token id is required.",
    });
  }
  const current = host.storage.remoteActionTokens.get(normalizedTokenId);
  if (current.actionType !== expectedActionType) {
    throw new ConflictError({
      message: `Remote action token is bound to ${current.actionType}, not ${expectedActionType}.`,
    });
  }
  if (current.state !== "pending") {
    throw new ConflictError({
      message: "Remote action token has already been consumed.",
    });
  }
  const expiresAt = Date.parse(current.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    host.storage.remoteActionTokens.updateState(current.tokenId, "expired");
    throw new ConflictError({
      message: "Remote action token has expired.",
    });
  }
  const consumed = host.storage.remoteActionTokens.consumePending(current.tokenId, {
    consumedAt: new Date().toISOString(),
    consumedBy: `connector:${current.connectorId}`,
  });
  if (!consumed) {
    throw new ConflictError({
      message: "Remote action token has already been consumed.",
    });
  }
  return consumed;
}
