import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { PanelRight } from "lucide-react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { useCockpitTitleDetail } from "../../app/cockpit-title-detail";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
import { useChatOutageRecovery } from "./use-chat-outage-recovery";
import { useModelLabel } from "../../data/use-model-label";
import { presentDelegationRunStatus } from "./chat-vocabulary";
import type { ChannelConversationContext } from "./channel-conversation";
import { ScopeLine } from "../../app/scope-line";
import { ChatHostStatus } from "./ChatHostStatus";

type ActiveSession = MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"];

/**
 * Title, conversations and session actions in one row. Below the desktop rail a Conversations button opens the list
 * in a sheet; Projects opens from the list's project filter. On a phone the row is only the title, Conversations and the actions menu, which also holds Projects and
 * New conversation, so the transcript keeps the screen; an open build editor keeps its visible way back.
 */
export function ChatSessionHeader(props: Parameters<typeof ChatSessionHeaderRow>[0]) {
  return (
    <>
      <ChatSessionHeaderRow {...props} />
      <ChatHostStatus status={props.input.hostStatus} />
    </>
  );
}

function ChatSessionHeaderRow({
  input,
  active,
  session,
  channel,
  selectedSessionId,
  buildEditor,
  onOpenProjects,
  onOpenConversations,
  conversationsOpen = false,
  inspecting = false,
  onInspect,
  onFork,
  railYields = false,
}: {
  input: MissionThreadedRenderSurfaceInput;
  active: ActiveSession;
  session?: ChatSessionRecord;
  /** Set when the open conversation is held through a channel (Telegram, Slack, …). */
  channel?: ChannelConversationContext;
  selectedSessionId?: string;
  buildEditor: { open: boolean; onToggle: () => void } | null;
  onOpenProjects: () => void;
  /** Opens the conversations sheet; the button shows only below the desktop rail. */
  onOpenConversations: () => void;
  conversationsOpen?: boolean;
  /** Whether the Chat inspector is showing; Inspect is a toggle, not navigation. */
  inspecting?: boolean;
  onInspect: () => void;
  onFork?: () => void;
  /** The conversation rail waits for the extra-wide layout while the inspector is open. */
  railYields?: boolean;
}) {
  // The "can't reach GoatCitadel" notice clears itself once the Gateway answers again.
  useChatOutageRecovery({
    streamError: active?.streamError,
    onDismissError: active?.onDismissError,
    onRefreshThread: active?.onRefreshThread,
  });
  useCockpitTitleDetail(active?.sessionTitle);
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const rail = input.sessionRail;
  const createConversation = () => void rail.onCreateSession();
  const title = (
    <ChatSessionTitle key={selectedSessionId} title={active?.sessionTitle ?? "Chat"} dock={input.contextDockProps} />
  );
  const conversations = (
    <Button
      size="sm"
      className={phone ? "h-11 shrink-0 px-3" : railYields ? "xl:hidden" : "lg:hidden"}
      aria-haspopup="dialog"
      aria-expanded={conversationsOpen}
      disabled={rail.loading}
      onClick={onOpenConversations}
    >
      Conversations
    </Button>
  );
  const newConversation = (
    <Button
      size="sm"
      className={railYields ? "xl:hidden" : "lg:hidden"}
      aria-label="New conversation"
      disabled={rail.creatingSession || rail.loading}
      onClick={createConversation}
    >
      New
    </Button>
  );
  // The build editor opens from the overflow menu; while it is open, the way back stays a visible button.
  const build = buildEditor?.open ? (
    <Button
      size="sm"
      className={phone ? "h-11 shrink-0 whitespace-nowrap px-3" : "whitespace-nowrap max-sm:h-11 max-sm:px-3"}
      aria-expanded
      aria-label="Back to conversation"
      onClick={buildEditor.onToggle}
    >
      <span className="max-sm:hidden">Back to conversation</span>
      <span aria-hidden="true" className="sm:hidden">
        Back
      </span>
    </Button>
  ) : null;
  // A channel conversation continues in a chat of its own, with its history copied. The action is the header's own
  // button above the phone width; the phone header keeps one row, so there it is the menu's fork item, renamed.
  const continueInNewChat =
    channel && onFork ? (
      <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={onFork}>
        Continue in a new chat
      </Button>
    ) : null;
  const overflow =
    active || buildEditor || phone ? (
      <ChatSessionOverflow
        key={selectedSessionId}
        dock={active ? input.contextDockProps : null}
        onFork={onFork}
        forkLabel={phone && channel ? "Continue in a new chat" : undefined}
        onInspect={onInspect}
        onOpenBuildEditor={buildEditor && !buildEditor.open ? buildEditor.onToggle : undefined}
        phoneActions={
          phone
            ? {
                onOpenProjects,
                onNewConversation: createConversation,
                newConversationDisabled: rail.creatingSession || rail.loading,
              }
            : undefined
        }
      />
    ) : null;

  if (phone)
    return (
      <header className="flex min-h-14 min-w-0 items-center gap-2 border-b border-line-subtle px-3 py-1">
        <div className="min-w-0 flex-1">
          {title}
          <ScopeLine />
          <SelectedThreadActivity session={session} active={active} />
        </div>
        {conversations}
        {build}
        {overflow}
      </header>
    );

  return (
    <header className="flex min-h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0">{title}</div>
          <SelectedThreadActivity session={session} active={active} />
        </div>
        <ScopeLine />
        <ChatHeaderSubtitle
          active={active}
          projectName={session?.projectName}
          channelLabel={channel?.channelLabel}
          loading={rail.loading}
        />
      </div>
      {/* Projects sits with the conversation list's project filter; a phone keeps it in the actions menu. */}
      {conversations}
      {newConversation}
      {continueInNewChat}
      {active ? (
        <IconButton
          label="Inspect"
          aria-pressed={inspecting}
          icon={<PanelRight aria-hidden="true" className="size-4" />}
          className="hidden border border-line aria-pressed:border-accent aria-pressed:bg-sunken aria-pressed:text-fg md:inline-flex"
          onClick={onInspect}
        />
      ) : null}
      {build}
      {overflow}
    </header>
  );
}

/** Project, personality, model and run status. Nothing is shown rather than an unearned "ready". */
export function ChatHeaderSubtitle({
  active,
  projectName,
  channelLabel,
  loading,
}: {
  active: ActiveSession;
  projectName?: string | null;
  /** The channel a conversation is held through, when it is one. */
  channelLabel?: string;
  loading?: boolean;
}) {
  const hasModel = Boolean(active?.selectedProviderId && active?.selectedModel);
  const modelLabel = useModelLabel(active?.selectedProviderId, active?.selectedModel ?? undefined, hasModel, {
    showIdWhenUnnamed: false,
  });
  const parts = [
    channelLabel ? `via ${channelLabel}` : null,
    projectName,
    active?.activePersonality?.name,
    hasModel ? modelLabel : null,
    active?.delegationRun?.status ? `Run · ${presentDelegationRunStatus(active.delegationRun.status).label}` : null,
  ].filter(Boolean);
  const text = parts.length ? parts.join(" · ") : loading ? "Loading conversations…" : null;
  return text ? <p className="hidden truncate text-xs text-fg-muted md:block">{text}</p> : null;
}
