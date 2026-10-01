import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { useChannelSetupState } from "./use-channel-setup-state";
import { useChannelDraftActions } from "./use-channel-draft-actions";
import { useChannelSetupEntry } from "./use-channel-setup-entry";

export function useChannelSettings(workspaceId: string, onPlanReady: (plan: ChangePlanRecord) => void) {
  const state = useChannelSetupState(workspaceId);
  const actions = useChannelDraftActions(state, onPlanReady);
  const entry = useChannelSetupEntry(state);
  return { ...state, ...actions, ...entry };
}
export type ChannelSettingsOwner = ReturnType<typeof useChannelSettings>;
