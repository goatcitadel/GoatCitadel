import type { DraftLeaveDialogProps } from "../../../features/native-routes/library/DraftLeaveDialog";
import { UnsavedChangesDialog } from "../../ui/UnsavedChangesDialog";

export function McpDraftLeave(props: DraftLeaveDialogProps) {
  return <UnsavedChangesDialog {...props} />;
}
