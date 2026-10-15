import type { DraftLeaveDialogProps } from "../../../features/native-routes/library/DraftLeaveDialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";

export function ProviderDraftLeave(props: DraftLeaveDialogProps) {
  return <UnsavedChangesDialog {...props} />;
}
