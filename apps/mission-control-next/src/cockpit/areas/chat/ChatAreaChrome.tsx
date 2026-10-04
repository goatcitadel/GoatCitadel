import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";

type ActiveSession = MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"];

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
  const parts = [
    projectName,
    active?.activePersonality?.name,
    active?.selectedProviderId && active?.selectedModel ? `${active.selectedProviderId} · ${active.selectedModel}` : null,
    active?.delegationRun?.status ? `Run ${active.delegationRun.status}` : null,
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
