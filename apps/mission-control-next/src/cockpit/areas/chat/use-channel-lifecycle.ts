import { useEffect, useRef, useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  deleteIntegrationConnection,
  fetchIntegrationConnection,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  beginIntegrationMutation,
  commitIntegrationConnectionUpdate,
  integrationConflictIsUncommitted,
  integrationConnectionReviewMatches,
  useIntegrationConnectionMutation,
} from "../../../features/native-routes/settings/integration-connection-mutation";
import {
  readChannelMutationState,
  useChannelMutationState,
} from "../../../features/native-routes/settings/sections/channel-setup-state";
import {
  verifyIntegrationDeleted,
  verifyIntegrationReadback,
} from "../../../features/native-routes/settings/sections/integration-editor-receipts";

/** The Settings pages' own note for a connection that changed, or was deleted, under a reviewed action. */
const CHANGED = "The connection changed or was deleted. Review its current saved state before retrying.";
const NOT_CHECKED = "Couldn't check this channel first, so nothing was removed. Try again.";

/** Raised before any write when the saved connection no longer matches the one reviewed. */
class ChangedUnderReview extends Error {}

/**
 * Turn a channel off or on, or remove it, through the same connection owners Settings uses: the change carries the
 * version the page showed, is read back afterwards, and a write whose answer is lost locks further changes until its
 * outcome is checked. Like Settings, it also waits on the installation-wide channel write lock: while a pairing answer
 * is in flight, or one whose outcome is unknown has not been checked, nothing here can be sent. Turning it off or on can
 * be undone; removing it cannot, so it is asked about first.
 */
export function useChannelLifecycle(connection: IntegrationConnection, reload: () => Promise<unknown>) {
  const mutation = useIntegrationConnectionMutation(connection.connectionId);
  const channel = useChannelMutationState();
  const [busy, setBusy] = useState<"toggle" | "remove" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Read live, so a pairing answer that started after the last render still holds this back. */
  const channelLocked = () => {
    const state = readChannelMutationState();
    return state.pending || Boolean(state.uncertain);
  };

  async function toggle() {
    if (busy || mutation.locked || channelLocked()) return;
    setBusy("toggle");
    setNote(null);
    const result = await commitIntegrationConnectionUpdate({
      reviewed: connection,
      input: { expectedRevision: connection.revision, enabled: !connection.enabled },
      isCurrent: () => mounted.current,
      verify: verifyIntegrationReadback,
    });
    if (!mounted.current) return;
    setBusy(null);
    if (result.status === "conflict" || result.status === "cancelled") setNote(result.message);
    await reload();
  }

  /** Settles before the page reads again; the caller closes its confirmation and the page says what happened. */
  async function remove(): Promise<void> {
    if (busy || channelLocked()) return;
    const operation = beginIntegrationMutation(connection.connectionId);
    if (!operation) return;
    setBusy("remove");
    setNote(null);
    let dispatched = false;
    try {
      const fresh = await fetchIntegrationConnection(connection.connectionId);
      if (!integrationConnectionReviewMatches(connection, fresh)) throw new ChangedUnderReview();
      await operation.write(
        () => {
          dispatched = true;
          return deleteIntegrationConnection(connection.connectionId, connection.revision);
        },
        (receipt) => verifyIntegrationDeleted(connection.connectionId, receipt),
        (cause) => integrationConflictIsUncommitted(cause, connection.connectionId, "DELETE"),
      );
    } catch (cause) {
      const rejected =
        cause instanceof ChangedUnderReview ||
        integrationConflictIsUncommitted(cause, connection.connectionId, "DELETE");
      // A write that was sent and not settled leaves the owner's own lock message; anything else says what happened.
      if (mounted.current) setNote(rejected ? CHANGED : dispatched ? null : NOT_CHECKED);
    } finally {
      operation.finish();
    }
    if (!mounted.current) return;
    setBusy(null);
    await reload();
  }

  const locked = busy !== null || mutation.locked || channel.pending || Boolean(channel.uncertain);
  return { toggle, remove, busy, locked, note };
}
