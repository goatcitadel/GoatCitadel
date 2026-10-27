import { Activity, lazy, Suspense, type ReactNode } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MessagingView } from "../../app/routes";
import { AreaErrorBoundary } from "../../ui/AreaErrorBoundary";
import { ChannelConversationScope } from "./channel-conversation-scope";

const LazyChannelPage = lazy(async () => ({ default: (await import("./ChannelPage")).ChannelPage }));
const LazyChannelPicker = lazy(async () => ({
  default: (await import("./channel-setup/ChannelPicker")).ChannelPicker,
}));
const LazyChannelSetupView = lazy(async () => ({
  default: (await import("./channel-setup/ChannelSetupView")).ChannelSetupView,
}));

/** What names the view, so a view that fails resets when the address changes to another one. */
function viewKey(view: MessagingView): string {
  switch (view.kind) {
    case "picker":
      return "picker";
    case "setup":
      // Another setup of the same channel is another page: what one showed must not carry over to the next.
      return `setup:${view.channelKey}:${view.draftId ?? ""}`;
    default:
      return `${view.kind}:${view.connectionId}`;
  }
}

function MessagingViewHost({ view }: { view: MessagingView }) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <AreaErrorBoundary label="Channel" resetKey={viewKey(view)}>
        <Suspense fallback={<p className="p-4 text-sm text-fg-muted">Loading channel…</p>}>
          {view.kind === "channel" ? (
            <LazyChannelPage connectionId={view.connectionId} workspaceId={workspaceId} />
          ) : view.kind === "picker" ? (
            <LazyChannelPicker workspaceId={workspaceId} />
          ) : (
            <LazyChannelSetupView view={view} workspaceId={workspaceId} />
          )}
        </Suspense>
      </AreaErrorBoundary>
    </div>
  );
}

/**
 * Chat's main column: the open conversation, or a Messaging view in its place (a channel's page, the add-channel
 * picker, a channel's setup). The conversation keeps its draft, scroll and selection, but is suspended while a view
 * shows, so it neither marks messages read nor claims the inspector for something nobody is looking at. The
 * conversation list beside it stays. Everything in the column knows whether the open conversation is a channel
 * conversation (`ChannelConversationScope`).
 */
export function ChatMainColumn({
  messaging,
  channelConversation = false,
  children,
}: {
  messaging: MessagingView | null;
  channelConversation?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {messaging ? <MessagingViewHost view={messaging} /> : null}
      <Activity mode={messaging ? "hidden" : "visible"}>
        <ChannelConversationScope.Provider value={channelConversation}>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </ChannelConversationScope.Provider>
      </Activity>
    </>
  );
}
