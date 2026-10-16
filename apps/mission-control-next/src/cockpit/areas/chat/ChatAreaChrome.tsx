import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { PanelRight } from "lucide-react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
import { useModelLabel } from "../../data/use-model-label";
import { presentDelegationRunStatus } from "./chat-vocabulary";

type ActiveSession = MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"];

/**
 * Title, conversations and session actions in one row. Below the desktop rail a Conversations button opens the list
 * in a sheet. On a phone the row is only the title, Conversations and the actions menu, which also holds Projects and
 * New conversation, so the transcript keeps the screen; an open build editor keeps its visible way back.
 */
export function ChatSessionHeader({
  input,
  active,
  session,
  selectedSessionId,
  buildEditor,
  onOpenProjects,
  onOpenConversations,
  conversationsOpen = false,
  inspecting = false,
  onInspect,
  onFork,
}: {
  input: MissionThreadedRenderSurfaceInput;
  active: ActiveSession;
  session?: ChatSessionRecord;
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
}) {
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const rail = input.sessionRail;
  const title = (
    <ChatSessionTitle key={selectedSessionId} title={active?.sessionTitle ?? "Chat"} dock={input.contextDockProps} />
  );
  const conversations = (
    <Button
      size="sm"
      className={phone ? "h-11 shrink-0 px-3" : "md:hidden"}
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
      className="md:hidden"
      aria-label="New conversation"
      disabled={rail.creatingSession || rail.loading}
      onClick={() => void rail.onCreateSession()}
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
  const overflow =
    active || buildEditor || phone ? (
      <ChatSessionOverflow
        key={selectedSessionId}
        dock={active ? input.contextDockProps : null}
        onFork={onFork}
        onInspect={onInspect}
        onOpenBuildEditor={buildEditor && !buildEditor.open ? buildEditor.onToggle : undefined}
        phoneActions={
          phone
            ? {
                onOpenProjects,
                onNewConversation: () => void rail.onCreateSession(),
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
          <div className="truncate [&>p]:truncate">
            <SelectedThreadActivity session={session} />
          </div>
        </div>
        {conversations}
        {build}
        {overflow}
      </header>
    );

  return (
    <header className="flex min-h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
      <div className="min-w-0 flex-1">
        {title}
        <ChatHeaderSubtitle active={active} projectName={session?.projectName} loading={rail.loading} />
      </div>
      <Button size="sm" onClick={onOpenProjects}>
        Projects
      </Button>
      {conversations}
      <SelectedThreadActivity session={session} />
      {newConversation}
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
  loading,
}: {
  active: ActiveSession;
  projectName?: string | null;
  loading?: boolean;
}) {
  const hasModel = Boolean(active?.selectedProviderId && active?.selectedModel);
  const modelLabel = useModelLabel(active?.selectedProviderId, active?.selectedModel ?? undefined, hasModel);
  const parts = [
    projectName,
    active?.activePersonality?.name,
    hasModel ? modelLabel : null,
    active?.delegationRun?.status ? `Run · ${presentDelegationRunStatus(active.delegationRun.status).label}` : null,
  ].filter(Boolean);
  const text = parts.length ? parts.join(" · ") : loading ? "Loading conversations…" : null;
  return text ? <p className="hidden truncate text-xs text-fg-muted md:block">{text}</p> : null;
}

/** Advisory only: sending works before setup is finished, so the copy must not read as a block. */
export function ChatSetupBanner({ onReturnToSetup }: { onReturnToSetup: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle bg-sunken px-3 py-2 text-sm text-fg-secondary">
      <p>You can chat now. Finish setup to verify your first answer.</p>
      <Button size="sm" onClick={onReturnToSetup}>
        Return to setup
      </Button>
    </div>
  );
}

export function ChatEmptyState({
  rail,
  onOpenConversations,
}: {
  rail: MissionThreadedRenderSurfaceInput["sessionRail"];
  /** Below the desktop rail the list is behind the header's Conversations button; the empty state offers it too. */
  onOpenConversations?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
      {rail.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading conversations…
        </p>
      ) : (
        <>
          <p className="text-lg font-semibold text-fg">Choose a conversation</p>
          <p className="max-w-sm text-sm text-fg-secondary">Pick one from the list, or start a new conversation.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {onOpenConversations ? (
              <Button className="max-sm:h-11 md:hidden" onClick={onOpenConversations}>
                Show conversations
              </Button>
            ) : null}
            <Button onClick={() => void rail.onCreateSession()} disabled={rail.creatingSession}>
              {rail.creatingSession ? "Creating…" : "New conversation"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
