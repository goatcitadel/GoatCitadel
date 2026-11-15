import {
  useDraftLeaveDialogState,
  type DraftLeaveDialogProps,
} from "../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Dialog } from "./Dialog";

/**
 * The one unsaved-changes dialog in the cockpit. Fixed title, copy and order: the safe choice (save) comes first and
 * is primary, the destructive one (discard) is the only red button, and Cancel is always last.
 */
export function UnsavedChangesDialog(props: DraftLeaveDialogProps) {
  const state = useDraftLeaveDialogState(props);
  return (
    <Dialog
      open={props.open}
      title="Unsaved changes"
      description={state.description}
      onOpenChange={(open) => {
        if (!open && !state.saving) props.onCancel();
      }}
    >
      {state.error ? (
        <div className="mb-3">
          <Callout tone="error">{state.error}</Callout>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state.canSave ? (
          <Button
            variant="primary"
            loading={state.saving}
            loadingLabel="Saving…"
            onClick={() => void state.saveAndContinue()}
          >
            Save and continue
          </Button>
        ) : null}
        {state.canKeep ? (
          <Button disabled={state.saving} onClick={props.onContinue}>
            Keep draft and close
          </Button>
        ) : null}
        <Button variant="danger" disabled={state.saving} onClick={state.discard}>
          Discard changes
        </Button>
        <Button disabled={state.saving} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
