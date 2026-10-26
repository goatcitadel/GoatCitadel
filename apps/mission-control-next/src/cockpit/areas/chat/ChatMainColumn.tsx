import { Activity, lazy, Suspense, type ReactNode } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { AreaErrorBoundary } from "../../ui/AreaErrorBoundary";
import { ChannelConversationScope } from "./channel-conversation-scope";

const LazyChannelPage = lazy(async () => ({ default: (await import("./ChannelPage")).ChannelPage }));

function ChannelPageHost({ connectionId }: { connectionId: string }) {
  const { activeWorkspaceId } = useUiPreferences();
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <AreaErrorBoundary label="Channel" resetKey={connectionId}>
        <Suspense fallback={<p className="p-4 text-sm text-fg-muted">Loading channel…</p>}>
          <LazyChannelPage connectionId={connectionId} workspaceId={activeWorkspaceId ?? "default"} />
        </Suspense>
      </AreaErrorBoundary>
    </div>
  );
}

/**
 * Chat's main column: the open conversation, or a channel page in its place. The conversation keeps its draft, scroll
 * and selection, but is suspended while the page shows, so it neither marks messages read nor claims the inspector
 * for something nobody is looking at. The conversation list beside it stays. Everything in the column knows whether
 * the open conversation is a channel conversation (`ChannelConversationScope`).
 */
export function ChatMainColumn({
  channelPageId,
  channelConversation = false,
  children,
}: {
  channelPageId: string | null;
  channelConversation?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {channelPageId ? <ChannelPageHost connectionId={channelPageId} /> : null}
      <Activity mode={channelPageId ? "hidden" : "visible"}>
        <ChannelConversationScope.Provider value={channelConversation}>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </ChannelConversationScope.Provider>
      </Activity>
    </>
  );
}
