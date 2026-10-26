import { useEffect, useRef, useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  commitIntegrationConnectionUpdate,
  useIntegrationConnectionMutation,
} from "../../../features/native-routes/settings/integration-connection-mutation";
import { verifyIntegrationReadback } from "../../../features/native-routes/settings/sections/integration-editor-receipts";
import { ownerActorIdsWith } from "./channel-page-model";

/**
 * Saves which sender is you, as the connection's own accounts. The save carries the version the page was showing, so
 * a change made elsewhere is refused rather than overwritten; the page then reads the connection again and says so
 * with the Settings pages' own conflict note. A lost answer locks further changes to this connection, which the page
 * shows once (see `ChannelLockNote`).
 */
export function useOwnerMark(connection: IntegrationConnection, reload: () => Promise<unknown>) {
  const mutation = useIntegrationConnectionMutation(connection.connectionId);
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy = saving !== null || mutation.locked;

  async function mark(actorId: string, isOwner: boolean) {
    if (busy) return;
    const reviewed = connection;
    setSaving(actorId);
    setNote(null);
    const result = await commitIntegrationConnectionUpdate({
      reviewed,
      input: {
        expectedRevision: reviewed.revision,
        config: { ...reviewed.config, ownerActorIds: ownerActorIdsWith(reviewed, actorId, isOwner) },
      },
      isCurrent: () => mounted.current,
      verify: verifyIntegrationReadback,
    });
    if (!mounted.current) return;
    setSaving(null);
    // A lost or locked answer is said once for the page by ChannelLockNote; only a refused save is said here.
    if (result.status === "conflict" || result.status === "cancelled") setNote(result.message);
    await reload();
  }

  return { mark, saving, busy, note };
}
