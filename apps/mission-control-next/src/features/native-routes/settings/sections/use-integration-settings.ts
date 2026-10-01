import { useIntegrationSettingsState } from "./use-integration-settings-state";
import { useIntegrationEditorActions } from "./use-integration-editor-actions";
import { useIntegrationOperatorActions } from "./use-integration-operator-actions";
import { useIntegrationExternalActions } from "./use-integration-external-actions";
import { useIntegrationMeetActions } from "./use-integration-meet-actions";
import { useIntegrationReplayActions } from "./use-integration-replay-actions";
export function useIntegrationSettings(workspaceId: string) {
  const state = useIntegrationSettingsState(workspaceId);
  const editor = useIntegrationEditorActions(state);
  const operator = useIntegrationOperatorActions(state);
  const external = useIntegrationExternalActions(state);
  const meet = useIntegrationMeetActions(state);
  const replay = useIntegrationReplayActions(state);
  return { ...state, ...editor, ...operator, ...external, ...meet, ...replay };
}
export type IntegrationSettingsOwner = ReturnType<typeof useIntegrationSettings>;
