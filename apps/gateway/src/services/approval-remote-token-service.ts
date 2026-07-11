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

export interface RemoteActionTokenClaimOptions {
  /** Stable digest of the canonical approval-resolution request. */
  claimFingerprint?: string;
  /** Optional authenticated connector binding for opaque-id resolution. */
  expectedConnectorId?: string;
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
  options?: RemoteActionTokenClaimOptions,
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
  return consumeResolvedRemoteActionToken(host, current, expectedActionType, options);
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
  options?: RemoteActionTokenClaimOptions,
): RemoteActionTokenRecord {
  const normalizedTokenId = tokenId.trim();
  if (!normalizedTokenId) {
    throw new ValidationError({
      message: "Remote action token id is required.",
    });
  }
  const current = host.storage.remoteActionTokens.get(normalizedTokenId);
  return consumeResolvedRemoteActionToken(host, current, expectedActionType, options);
}

function consumeResolvedRemoteActionToken(
  host: ApprovalRemoteTokenHost,
  current: RemoteActionTokenRecord,
  expectedActionType: RemoteActionTokenRecord["actionType"],
  options: RemoteActionTokenClaimOptions | undefined,
): RemoteActionTokenRecord {
  if (current.actionType !== expectedActionType) {
    throw new ConflictError({
      message: `Remote action token is bound to ${current.actionType}, not ${expectedActionType}.`,
    });
  }
  const expectedConnectorId = options?.expectedConnectorId?.trim();
  if (expectedConnectorId && current.connectorId !== expectedConnectorId) {
    throw new ConflictError({
      message: `Remote action token is bound to connector ${current.connectorId}, not ${expectedConnectorId}.`,
    });
  }

  const claimFingerprint = normalizeClaimFingerprint(options?.claimFingerprint);
  if (current.state === "expired") {
    throwExpiredTokenConflict();
  }
  if (current.state === "consumed") {
    if (!claimFingerprint) {
      throwConsumedTokenConflict();
    }
    return resolveClaimResult(host, current.tokenId, {
      consumedAt: new Date().toISOString(),
      consumedBy: `connector:${current.connectorId}`,
      claimFingerprint,
    });
  }

  const expiresAt = Date.parse(current.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    const latest = host.storage.remoteActionTokens.expirePendingAtOrBefore(current.tokenId, new Date().toISOString());
    if (latest.state === "expired") {
      throwExpiredTokenConflict();
    }
    // A claimant may have won after the expiry read but before the CAS. Never
    // overwrite that winner; identical request retries can resume it.
    if (claimFingerprint) {
      return resolveClaimResult(host, current.tokenId, {
        consumedAt: new Date().toISOString(),
        consumedBy: `connector:${current.connectorId}`,
        claimFingerprint,
      });
    }
    throwConsumedTokenConflict();
  }

  const consumedAt = new Date().toISOString();
  const consumedBy = `connector:${current.connectorId}`;
  if (claimFingerprint) {
    return resolveClaimResult(host, current.tokenId, {
      consumedAt,
      consumedBy,
      claimFingerprint,
    });
  }

  const consumed = host.storage.remoteActionTokens.consumePending(current.tokenId, {
    consumedAt,
    consumedBy,
  });
  if (!consumed) {
    expireTokenAfterLostBoundaryRace(host, current.tokenId, consumedAt);
    throwConsumedTokenConflict();
  }
  return consumed;
}

function resolveClaimResult(
  host: ApprovalRemoteTokenHost,
  tokenId: string,
  input: {
    consumedAt: string;
    consumedBy: string;
    claimFingerprint: string;
  },
): RemoteActionTokenRecord {
  const result = host.storage.remoteActionTokens.claimPending(tokenId, input);
  if ((result.outcome === "claimed" || result.outcome === "resumed") && result.record) {
    return result.record;
  }
  if (result.outcome === "fingerprint_mismatch") {
    throw new ConflictError({
      message: "Remote action token was claimed by a different request.",
    });
  }
  if (result.record?.state === "expired") {
    throwExpiredTokenConflict();
  }
  if (result.record?.state === "pending") {
    expireTokenAfterLostBoundaryRace(host, tokenId, input.consumedAt);
  }
  throwConsumedTokenConflict();
}

function expireTokenAfterLostBoundaryRace(host: ApprovalRemoteTokenHost, tokenId: string, claimedAt: string): void {
  const latest = host.storage.remoteActionTokens.expirePendingAtOrBefore(tokenId, claimedAt);
  if (latest.state === "expired") {
    throwExpiredTokenConflict();
  }
}

function normalizeClaimFingerprint(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "claimFingerprint" });
  }
  return normalized;
}

function throwConsumedTokenConflict(): never {
  throw new ConflictError({
    message: "Remote action token has already been consumed.",
  });
}

function throwExpiredTokenConflict(): never {
  throw new ConflictError({
    message: "Remote action token has expired.",
  });
}
