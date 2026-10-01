import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { useDraftLeaveDialogState } from "../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
export function useCockpitShellSwitch(sessionId?: string | null) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const owner = useShellHandoff([activeCitadelId, activeWorkspaceId, sessionId]);
  return {
    request: () => owner.request("classic", { sessionId }),
    feedback: <ShellSwitchFeedback owner={owner} />,
  };
}
export function ShellSwitchFeedback({ owner }: { owner: ReturnType<typeof useShellHandoff> }) {
  const state = useDraftLeaveDialogState(owner.dialogProps);
  return (
    <>
      {owner.opening ? (
        <span role="status" className="block text-sm text-fg-muted">
          Opening view…
        </span>
      ) : null}
      {owner.error ? (
        <span role="alert" className="block text-sm text-status-failed">
          {owner.error}
        </span>
      ) : null}
      <Dialog
        open={owner.dialogProps.open}
        title="Unsaved changes"
        description={state.description}
        onOpenChange={(open) => {
          if (!open && !state.saving) owner.dialogProps.onCancel();
        }}
      >
        {state.error ? (
          <p role="alert" className="text-sm text-status-failed">
            {state.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {state.canSave ? (
            <Button disabled={state.saving} onClick={() => void state.saveAndContinue()}>
              Save and continue
            </Button>
          ) : null}
          {state.canKeep ? (
            <Button disabled={state.saving} onClick={owner.dialogProps.onContinue}>
              Keep draft and close
            </Button>
          ) : null}
          <Button variant="danger" disabled={state.saving} onClick={state.discard}>
            Discard changes
          </Button>
          <Button disabled={state.saving} onClick={owner.dialogProps.onCancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
