import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { ChatContextActions } from "./ChatContextActions";
import { ChatFeatureSettings } from "./ChatFeatureSettings";
export function ChatConversationSettings({ dock }: { dock: MissionThreadedContextDockProps }) {
  return (
    <>
      <ChatFeatureSettings key={dock.selectedSessionId} dock={dock} />
      <ChatContextActions
        key={JSON.stringify([dock.selectedSession.workspaceId, dock.selectedSessionId])}
        dock={dock}
      />
    </>
  );
}
