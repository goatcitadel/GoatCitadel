import type { MissionThreadedSessionRailData } from "@goatcitadel/threaded-surface-core";
import type { ChatProjectFilterOption } from "./ChatConversationFilters";
import { ConversationListPanel, type ConversationListMessaging } from "./ConversationListPanel";

/** The desktop conversation rail; phones open the same list from the header's Conversations sheet. */
export function ThreadList({
  rail,
  projectOptions,
  onOpenProjects,
  messaging,
  yieldToInspector = false,
}: {
  rail: MissionThreadedSessionRailData;
  projectOptions?: readonly ChatProjectFilterOption[];
  onOpenProjects?: () => void;
  messaging?: ConversationListMessaging;
  /** While the inspector is open the rail waits for the extra-wide layout, so the transcript keeps its room. */
  yieldToInspector?: boolean;
}) {
  return (
    <aside
      aria-label="Conversations"
      className={
        yieldToInspector
          ? "hidden w-60 shrink-0 flex-col border-r border-line-subtle bg-raised xl:flex"
          : "hidden w-60 shrink-0 flex-col border-r border-line-subtle bg-raised lg:flex"
      }
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
