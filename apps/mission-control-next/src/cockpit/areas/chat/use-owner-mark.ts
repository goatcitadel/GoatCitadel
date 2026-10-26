import { useEffect, useRef, useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import {
  commitIntegrationConnectionUpdate,
  useIntegrationConnectionMutation,
} from "../../../features/native-routes/settings/integration-connection-mutation";
import { verifyIntegrationReadback } from "../../../features/native-routes/settings/sections/integration-editor-receipts";
import { ownerActorIdsWith } from "./channel-page-model";

/**
 * Saves which sender is you, as the connection's own accounts. The save carries the version the page was showing, so
 * a change made elsewhere is refused rather than overwritten; the page then reads the connection again and says so
 * with the Settings pages' own conflict note. A lost answer locks further saves until its outcome is checked.
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
    if (result.status !== "saved") setNote(result.message);
    await reload();
  }

  /** Settles a save whose answer was lost, from what the connection now holds. */
  async function checkSaved() {
    const settled = await mutation.checkOutcome(() => fetchIntegrationConnection(connection.connectionId));
    if (!mounted.current) return;
    setNote(settled ?? null);
    await reload();
  }

  return {
    mark,
    checkSaved,
    saving,
    busy,
    uncertain: mutation.phase === "uncertain",
    note: note ?? (mutation.phase === "uncertain" ? (mutation.message ?? null) : null),
    /** The note answers something done on this page just now, rather than a lock left from earlier. */
    fresh: note !== null,
  };
}
