import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ChatConversationsSheet } from "./ChatConversationsSheet";
import type { ConversationListMessaging } from "./ConversationListPanel";
import { ThreadList } from "./ThreadList";

/**
 * The conversation list in both of its places: the rail beside the transcript from 1280 px (1600 px while the
 * inspector is open), and the sheet the header's Conversations button opens below that.
 */
export function ChatConversationRail({
  rail,
  projectOptions,
  onOpenProjects,
  messaging,
  yieldToInspector,
  sheetOpen,
  onSheetOpenChange,
}: {
  rail: MissionThreadedRenderSurfaceInput["sessionRail"];
  projectOptions?: Parameters<typeof ThreadList>[0]["projectOptions"];
  onOpenProjects: () => void;
  messaging?: ConversationListMessaging;
  yieldToInspector: boolean;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <ThreadList
        rail={rail}
        projectOptions={projectOptions}
        onOpenProjects={onOpenProjects}
        messaging={messaging}
        yieldToInspector={yieldToInspector}
      />
      <ChatConversationsSheet
        open={sheetOpen}
        onOpenChange={onSheetOpenChange}
        rail={rail}
        projectOptions={projectOptions}
        onOpenProjects={onOpenProjects}
        messaging={messaging}
      />
    </>
  );
}
