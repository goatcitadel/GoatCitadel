import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { useChannelSetupState } from "./use-channel-setup-state";
import { useChannelDraftActions } from "./use-channel-draft-actions";
import { useChannelSetupEntry } from "./use-channel-setup-entry";
import { useChannelDraftEvidence } from "./use-channel-draft-evidence";

export function useChannelSettings(workspaceId: string, onPlanReady: (plan: ChangePlanRecord) => void) {
  const state = useChannelSetupState(workspaceId);
  const actions = useChannelDraftActions(state, onPlanReady);
  const entry = useChannelSetupEntry(state, actions.handleSaveReceipt);
  const evidence = useChannelDraftEvidence(state);
  return { ...state, ...actions, ...entry, ...evidence };
}
export type ChannelSettingsOwner = ReturnType<typeof useChannelSettings>;
