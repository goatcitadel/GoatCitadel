import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Sheet } from "../../ui/Sheet";
import type { ChatProjectFilterOption } from "./ChatConversationFilters";
import { ConversationListPanel } from "./ConversationListPanel";

/**
 * Below the desktop rail, the header's Conversations button opens this sheet: the same list, filters and history
 * actions as the rail, as buttons rather than options of a native select. Choosing or starting a conversation closes it.
 */
export function ChatConversationsSheet({
  open,
  onOpenChange,
  rail,
  projectOptions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rail: MissionThreadedRenderSurfaceInput["sessionRail"];
  projectOptions?: readonly ChatProjectFilterOption[];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Conversations">
      <ConversationListPanel rail={rail} projectOptions={projectOptions} inSheet onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}
