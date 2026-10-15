import type { DraftLeaveDialogProps } from "../../../features/native-routes/library/DraftLeaveDialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";

export function ChannelDraftLeave(props: DraftLeaveDialogProps) {
  return <UnsavedChangesDialog {...props} />;
}
