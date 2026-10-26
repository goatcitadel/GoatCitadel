import { useEffect, useRef, useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  approveDiscordPairing,
  fetchDiscordPairings,
  revokeDiscordPairing,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  approveTelegramChannelPairing,
  fetchTelegramChannelPairings,
  revokeTelegramChannelPairing,
} from "@goatcitadel/mission-control-shared/api/channel-setup-operations";
import {
  beginChannelOperation,
  useChannelMutationState,
} from "../../../features/native-routes/settings/sections/channel-setup-state";
import type { PendingRequest } from "./channel-page-model";

export type PairingDecision = "approve" | "deny";

/** Thrown before any write when the request is no longer the one the operator was shown. */
class RequestChanged extends Error {}

const CHANGED = "That request changed, so nothing was sent. Review the people asking below.";
const failedNote = (decision: PairingDecision) =>
  `Couldn't ${decision === "approve" ? "approve" : "deny"} that request. Check who is listed below before trying again.`;
const MISMATCH = "The answer did not match the request you chose.";

type Operation = NonNullable<ReturnType<typeof beginChannelOperation>>;

async function decideTelegram(
  connectionId: string,
  request: Extract<PendingRequest, { kind: "telegram" }>,
  decision: PairingDecision,
  operation: Operation,
) {
  // Read the list again first: the request must still be pending with the same code, and its version is the one to act on.
  const fresh = await fetchTelegramChannelPairings(connectionId);
  const current = fresh.items.find(
    (item) => item.actorId === request.actorId && item.status === "pending" && item.code === request.code,
  );
  if (fresh.connectionId !== connectionId || !current) throw new RequestChanged();
  const expectedConnectionRevision = fresh.connectionRevision;
  if (decision === "approve") {
    await operation.write(
      () => approveTelegramChannelPairing(connectionId, { code: current.code!, expectedConnectionRevision }),
      (value) => {
        if (
          value.connectionId !== connectionId ||
          !value.items.some((item) => item.actorId === request.actorId && item.status === "approved")
        )
          throw new Error(MISMATCH);
      },
    );
    return;
  }
  await operation.write(
    () => revokeTelegramChannelPairing(connectionId, request.actorId, { expectedConnectionRevision }),
    (value) => {
      if (value.connectionId !== connectionId || value.items.some((item) => item.actorId === request.actorId))
        throw new Error(MISMATCH);
    },
  );
}

async function decideDiscord(
  connectionId: string,
  request: Extract<PendingRequest, { kind: "discord" }>,
  decision: PairingDecision,
  operation: Operation,
) {
  const fresh = await fetchDiscordPairings(connectionId);
  const current = fresh.items.find((item) => item.pairingId === request.pairingId);
  if (
    !current ||
    current.connectionId !== connectionId ||
    current.userId !== request.userId ||
    current.status !== "pending"
  )
    throw new RequestChanged();
  await operation.write(
    () =>
      decision === "approve"
        ? approveDiscordPairing(connectionId, request.pairingId)
        : revokeDiscordPairing(connectionId, request.pairingId),
    (value) => {
      if (
        value.connectionId !== connectionId ||
        value.pairingId !== request.pairingId ||
        value.userId !== request.userId ||
        value.status !== (decision === "approve" ? "approved" : "revoked")
      )
        throw new Error(MISMATCH);
    },
  );
}

/**
 * Approve or deny one request to message the channel, through the same installation-wide channel write admission the
 * Settings pairing panels use. The request is read again first; after the answer the page reads its people again, so
 * Discord's approval (which does not change the connection) shows up in the approved list too. A write whose outcome is
 * unknown locks channel changes until it is checked, here and in Settings.
 */
export function usePairingDecision(connection: IntegrationConnection, reload: () => Promise<unknown>) {
  const mutation = useChannelMutationState();
  const [busy, setBusy] = useState<{ key: string; decision: PairingDecision } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function decide(request: PendingRequest, decision: PairingDecision) {
    const operation = beginChannelOperation();
    if (!operation) return;
    setBusy({ key: request.key, decision });
    setNote(null);
    try {
      if (request.kind === "telegram") await decideTelegram(connection.connectionId, request, decision, operation);
      else await decideDiscord(connection.connectionId, request, decision, operation);
    } catch (cause) {
      if (mounted.current) setNote(cause instanceof RequestChanged ? CHANGED : failedNote(decision));
    } finally {
      operation.finish();
      if (mounted.current) setBusy(null);
    }
    if (mounted.current) await reload();
  }

  return {
    decide,
    busy,
    /** Another channel write is running or its outcome is unknown, here or in Settings. */
    locked: busy !== null || mutation.pending || Boolean(mutation.uncertain),
    uncertain: mutation.uncertain ?? null,
    note,
  };
}
