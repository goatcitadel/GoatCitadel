import {
  useDraftLeaveDialogState,
  type DraftLeaveDialogProps,
} from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function McpDraftLeave(props: DraftLeaveDialogProps) {
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
      <p className="mb-3 text-sm text-fg-secondary">
        To save, cancel this dialog and review the exact fields in the editor.
      </p>
      {state.error ? (
        <p role="alert" className="mb-3 text-sm text-status-failed">
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
