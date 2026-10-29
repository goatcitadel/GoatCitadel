import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import {
  createChannelRotateSecretDraft,
  fetchChannelSetupDrafts,
} from "@goatcitadel/mission-control-shared/api/client";

/**
 * The newest draft for changing this channel's key that still matches the channel, or a new one. A draft made
 * against an older version of the channel is no use: the gateway refuses to check it. A draft for editing or
 * repairing the channel is not this change and could carry other unsaved edits, so it is never taken.
 */
export async function draftForKeyChange(
  connection: Pick<IntegrationConnection, "connectionId" | "revision">,
  catalogId: string,
): Promise<ChannelSetupDraft> {
  const { items } = await fetchChannelSetupDrafts({ connectionId: connection.connectionId });
  const updated = (draft: ChannelSetupDraft) => Date.parse(draft.updatedAt) || 0;
  const newest = items
    .filter(
      (draft) =>
        draft.catalogId === catalogId &&
        draft.connectionId === connection.connectionId &&
        draft.lifecycleMode === "rotate_secret" &&
        draft.connectionRevision === connection.revision,
    )
    .reduce<ChannelSetupDraft | null>((best, draft) => (!best || updated(draft) > updated(best) ? draft : best), null);
  return newest ?? createChannelRotateSecretDraft(connection.connectionId);
}
