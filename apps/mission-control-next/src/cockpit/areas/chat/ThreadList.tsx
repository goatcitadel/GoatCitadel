import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import type { ChatProjectFilterOption } from "./ChatConversationFilters";
import { ConversationListPanel, type ConversationListMessaging } from "./ConversationListPanel";

/** The desktop conversation rail; phones open the same list from the header's Conversations sheet. */
export function ThreadList({
  rail,
  projectOptions,
  onOpenProjects,
  messaging,
}: {
  rail: MissionThreadedSessionRailData;
  projectOptions?: readonly ChatProjectFilterOption[];
  onOpenProjects?: () => void;
  messaging?: ConversationListMessaging;
}) {
  return (
    <aside
      aria-label="Conversations"
      className="hidden w-60 shrink-0 flex-col border-r border-line-subtle bg-raised md:flex"
    >
      <ConversationListPanel
        rail={rail}
        projectOptions={projectOptions}
        onOpenProjects={onOpenProjects}
        messaging={messaging}
      />
    </aside>
  );
}
