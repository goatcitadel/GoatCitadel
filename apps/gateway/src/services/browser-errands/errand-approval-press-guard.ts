import { ConflictError, type DiscordPairingRecord, type RemoteActionTokenRecord } from "@goatcitadel/contracts";
import type { ApprovalRemoteActionContext } from "../approval-remote-action-service.js";
import { hashSensitiveToken } from "../device-access-helpers.js";
import { isSelfPolledApprovalKind } from "./errand-constants.js";
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

/** What a channel shows when an errand approval's token was already spent or expired, or the approval was answered. */
export const ERRAND_ALREADY_ANSWERED_COPY = "This was already answered.";

/**
 * An errand approval press that changes nothing because the approval was answered elsewhere or its token was spent or
 * expired. Its message carries no approval or token id, so a channel can show it as is.
 */
export class ErrandAlreadyAnsweredError extends ConflictError {
  public constructor() {
    super({ message: ERRAND_ALREADY_ANSWERED_COPY });
    this.name = "ErrandAlreadyAnsweredError";
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

type ErrandTokenStorage = Pick<ApprovalRemoteActionContext, "storage">;

async function isErrandApprovalToken(
  { storage }: ErrandTokenStorage,
  tokenRecord: Pick<RemoteActionTokenRecord, "approvalId" | "mutation">,
): Promise<boolean> {
  const approvalId = tokenRecord.approvalId ?? String(tokenRecord.mutation?.approvalId ?? "").trim();
  if (!approvalId) {
    return false;
  }
  // A failed read propagates: the token is never consumed on a kind that could not be established.
  const approval = await storage.approvals.get(approvalId);
  return isSelfPolledApprovalKind(approval.kind);
}

/**
 * Errand approvals only take an answer from the operator's own account; checked before the token is consumed.
 * Resolves true when the token belongs to an errand approval (and the presser is the owner).
 */
export async function assertErrandChannelPressMayAnswer(
  deps: Pick<ApprovalRemoteActionContext, "storage" | "assertErrandPressOwner">,
  tokenId: string,
  actorId: string | undefined,
): Promise<boolean> {
  const { storage, assertErrandPressOwner } = deps;
  const tokenRecord = await storage.remoteActionTokens.get(tokenId);
  if (!(await isErrandApprovalToken(deps, tokenRecord))) {
    return false;
  }
  if (!actorId?.trim() || !assertErrandPressOwner) {
    throw new ErrandOwnerOnlyError();
  }
  await assertErrandPressOwner({ connectorId: tokenRecord.connectorId, actorId });
  return true;
}

/**
 * A raw action token typed into a channel (`/approve <token>`) carries no owner check, so an errand approval never
 * takes an answer that way from a channel connection; checked before the token is consumed.
 */
export async function assertErrandRawTokenMayAnswer(
  deps: ErrandTokenStorage,
  token: string,
  connectorId: string,
): Promise<void> {
  const normalizedToken = token.trim();
  if (!normalizedToken || !connectorId.trim().startsWith(INTEGRATION_CONNECTOR_PREFIX)) {
    return;
  }
  const { storage } = deps;
  const tokenRecord = await storage.remoteActionTokens.findByTokenHash(hashSensitiveToken(normalizedToken));
  if (tokenRecord && (await isErrandApprovalToken(deps, tokenRecord))) {
    throw new ErrandOwnerOnlyError();
  }
}

/** An errand approval press that hit a spent token or an answered approval gets copy without any id in it. */
export function asErrandAlreadyAnswered(error: unknown): unknown {
  return error instanceof ConflictError && !(error instanceof ErrandAlreadyAnsweredError)
    ? new ErrandAlreadyAnsweredError()
    : error;
}
