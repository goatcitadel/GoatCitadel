import type { ChannelSetupDraft } from "@goatcitadel/contracts";

/**
 * The newest unfinished new setup for a channel: a create draft that is not tied to a saved connection. Coming back
 * to the channel continues it instead of saving another draft beside it.
 */
export function unfinishedCreateDraft(
  drafts: readonly ChannelSetupDraft[] | undefined,
  catalogId: string,
): ChannelSetupDraft | undefined {
  let newest: ChannelSetupDraft | undefined;
  for (const draft of drafts ?? []) {
    if (draft.catalogId !== catalogId || draft.lifecycleMode !== "create" || draft.connectionId) continue;
    if (!newest || Date.parse(draft.updatedAt) > Date.parse(newest.updatedAt)) newest = draft;
  }
  return newest;
}
