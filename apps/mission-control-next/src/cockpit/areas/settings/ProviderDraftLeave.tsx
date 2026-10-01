import {
  useDraftLeaveDialogState,
  type DraftLeaveDialogProps,
} from "../../../features/native-routes/library/DraftLeaveDialog";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";

export function ProviderDraftLeave(props: DraftLeaveDialogProps) {
  const state = useDraftLeaveDialogState(props);
  return (
    <Dialog
      open={props.open}
      title="Unsaved provider draft"
      description={state.description}
      onOpenChange={(open) => {
        if (!open && !state.saving) props.onCancel();
      }}
    >
      {state.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state.canKeep ? (
          <Button disabled={state.saving} onClick={props.onContinue}>
            Keep draft and close
          </Button>
        ) : null}
        <Button variant="danger" disabled={state.saving} onClick={state.discard}>
          Discard draft
        </Button>
        <Button disabled={state.saving} onClick={props.onCancel}>
          Keep editing
        </Button>
      </div>
    </Dialog>
  );
}
