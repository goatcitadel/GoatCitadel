import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { ChatMobileConversationSelect } from "./ChatMobileConversationSelect";
import { ChatSessionOverflow, ChatSessionTitle } from "./ChatSessionControls";
import { SelectedThreadActivity } from "./SelectedThreadActivity";
import { useModelLabel } from "../../data/use-model-label";
import { presentDelegationRunStatus } from "./chat-vocabulary";

type ActiveSession = MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"];

/**
 * Title, conversation picker and session actions. Above phone width everything shares one row; on a
 * phone the title and status take the first row and the picker stretches across the second with the
 * primary actions, so neither the labels nor the select collapse into each other.
 */
export function ChatSessionHeader({
  input,
  active,
  session,
  selectedSessionId,
  buildEditor,
  onOpenProjects,
  onOpenFilters,
  onInspect,
  onFork,
}: {
  input: MissionThreadedRenderSurfaceInput;
  active: ActiveSession;
  session?: ChatSessionRecord;
  selectedSessionId?: string;
  buildEditor: { open: boolean; onToggle: () => void } | null;
  onOpenProjects: () => void;
  onOpenFilters: () => void;
  onInspect: () => void;
  onFork?: () => void;
}) {
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const rail = input.sessionRail;
  const title = (
    <ChatSessionTitle key={selectedSessionId} title={active?.sessionTitle ?? "Chat"} dock={input.contextDockProps} />
  );
  const projects = (
    <Button size="sm" className={phone ? "h-11 shrink-0 px-3" : undefined} onClick={onOpenProjects}>
      Projects
    </Button>
  );
  const newConversation = (
    <Button
      size="sm"
      className={phone ? "h-11 shrink-0 px-4" : "md:hidden max-sm:h-11 max-sm:px-4"}
      aria-label="New conversation"
      disabled={rail.creatingSession || rail.loading}
      onClick={() => void rail.onCreateSession()}
    >
      New
    </Button>
  );
  const build = buildEditor ? (
    <Button
      size="sm"
      className={phone ? "h-11 shrink-0 whitespace-nowrap px-3" : "whitespace-nowrap max-sm:h-11 max-sm:px-3"}
      aria-expanded={buildEditor.open}
      aria-label={buildEditor.open ? "Back to conversation" : "Build editor"}
      onClick={buildEditor.onToggle}
    >
      <span className="max-sm:hidden">{buildEditor.open ? "Back to conversation" : "Build editor"}</span>
      <span aria-hidden="true" className="sm:hidden">
        {buildEditor.open ? "Back" : "Build"}
      </span>
    </Button>
  ) : null;
  const overflow = active ? (
    <ChatSessionOverflow key={selectedSessionId} dock={input.contextDockProps} onFork={onFork} onInspect={onInspect} />
  ) : null;

  if (phone)
    return (
      <header className="flex flex-col gap-2 border-b border-line-subtle px-3 py-2">
        <div className="flex min-h-10 min-w-0 items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {title}
            <div className="truncate [&>p]:truncate">
              <SelectedThreadActivity session={session} />
            </div>
          </div>
          {projects}
          {overflow}
        </div>
        <div className="flex min-w-0 items-end gap-2">
          <div className="min-w-0 flex-1 [&>label]:block [&>label]:max-w-none">
            <ChatMobileConversationSelect rail={rail} onOpenFilters={onOpenFilters} />
          </div>
          {newConversation}
          {build}
        </div>
      </header>
    );

  return (
    <header className="flex min-h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
      <div className="min-w-0 flex-1">
        {title}
        <ChatHeaderSubtitle active={active} projectName={session?.projectName} loading={rail.loading} />
      </div>
      {projects}
      <ChatMobileConversationSelect rail={rail} onOpenFilters={onOpenFilters} />
      <SelectedThreadActivity session={session} />
      {newConversation}
      {active ? (
        <Button size="sm" className="hidden md:inline-flex" onClick={onInspect}>
          Inspect
        </Button>
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

export function ChatEmptyState({ rail }: { rail: MissionThreadedRenderSurfaceInput["sessionRail"] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
      {rail.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading conversations…
        </p>
      ) : (
        <>
          <p className="font-display text-lg font-medium text-fg">Choose a conversation</p>
          <p className="max-w-sm text-sm text-fg-secondary">Choose a thread or start a new conversation.</p>
          <Button onClick={() => void rail.onCreateSession()} disabled={rail.creatingSession}>
            {rail.creatingSession ? "Creating…" : "New conversation"}
          </Button>
        </>
      )}
    </div>
  );
}
