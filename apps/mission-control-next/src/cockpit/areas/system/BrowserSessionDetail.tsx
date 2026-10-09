import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BrowserSessionGrantRecord, BrowserSessionRecord } from "@goatcitadel/contracts";
import {
  closeBrowserSession,
  fetchBrowserSession,
  fetchBrowserSessionEvents,
  fetchBrowserSessionGrants,
  fetchBrowserSessionState,
} from "@goatcitadel/mission-control-shared/api/browser-sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import { useLibraryOperation } from "../library/use-library-operation";
import { BrowserSessionGrants, browserSessionOperationScope } from "./BrowserSessionGrants";
import { BrowserSessionStateView } from "./BrowserSessionStateView";
import { describeEventPayload, formatTime, isGrantActive, LIST_LIMIT } from "./browser-sessions-model";

const EVENT_LIMIT = 100;
type View = "session" | "state" | "events";
const VIEWS: readonly { id: View; label: string }[] = [
  { id: "session", label: "Session and grants" },
  { id: "state", label: "State" },
  { id: "events", label: "Events" },
];

export function BrowserSessionDetail({
  sessionId,
  workspaceId,
  onListChanged,
}: {
  sessionId: string;
  workspaceId: string;
  onListChanged: () => Promise<unknown>;
}) {
  const operation = useLibraryOperation(browserSessionOperationScope(workspaceId, sessionId));
  const [view, setView] = useSessionViewState<View>(operation.key + ":view", "session");
  const key = ["system", "browser-session", workspaceId, sessionId, operation.identity];
  const session = useQuery({
    queryKey: [...key, "record"],
    queryFn: () => fetchBrowserSession(sessionId),
    staleTime: 0,
  });
  const grants = useQuery({
    queryKey: [...key, "grants"],
    queryFn: () => fetchBrowserSessionGrants(sessionId, { status: "all", limit: LIST_LIMIT }),
    staleTime: 0,
    enabled: session.data?.workspaceId === workspaceId,
  });
  const events = useQuery({
    queryKey: [...key, "events"],
    queryFn: () => fetchBrowserSessionEvents(sessionId, EVENT_LIMIT),
    staleTime: 0,
    enabled: session.data?.workspaceId === workspaceId && view === "events",
  });
  const state = useQuery({
    queryKey: [...key, "state"],
    queryFn: () => fetchBrowserSessionState(sessionId),
    staleTime: 0,
    enabled: session.data?.workspaceId === workspaceId && view === "state",
  });
  const refresh = async () => {
    await Promise.all([session.refetch(), grants.refetch(), onListChanged()]);
  };

  if (session.isPending) return <p role="status">Reading browser session…</p>;
  if (session.error)
    return (
      <Callout tone="error">
        {describeApiError(session.error).summary} The browser session may not exist or may not be readable.
      </Callout>
    );
  const record = session.data!;
  if (record.workspaceId !== workspaceId)
    return (
      <Callout tone="warning">
        This browser session belongs to {record.workspaceId ? `workspace ${record.workspaceId}` : "no workspace"}, not
        workspace {workspaceId}. Switch workspace to manage it.
      </Callout>
    );
  return (
    <section className="grid min-w-0 grid-cols-1 gap-3" aria-label={`Browser session ${record.label}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-semibold wrap-anywhere">{record.label}</h2>
        <StatusBadge
          status={
            record.status === "active"
              ? { label: "Open record", tone: "done" }
              : { label: "Closed record", tone: "neutral" }
          }
        />
      </div>
      <div role="group" aria-label="Browser session views" className="flex flex-wrap gap-1">
        {VIEWS.map((item) => (
          <Button
            key={item.id}
            variant={view === item.id ? "secondary" : "ghost"}
            aria-pressed={view === item.id}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {view === "session" ? (
        <>
          <SessionPosture
            session={record}
            workspaceId={workspaceId}
            activeGrants={(grants.data ?? []).filter((grant) => isGrantActive(grant))}
            onChanged={refresh}
          />
          {grants.error ? <Callout tone="error">{describeApiError(grants.error).summary}</Callout> : null}
          {grants.data ? (
            <BrowserSessionGrants session={record} workspaceId={workspaceId} grants={grants.data} onChanged={refresh} />
          ) : grants.isPending ? (
            <p role="status">Reading grants…</p>
          ) : null}
        </>
      ) : view === "state" ? (
        <BrowserSessionStateView
          status={record.status}
          grants={grants.data}
          grantsPending={grants.isPending}
          grantsError={grants.error}
          projection={state.data}
          pending={state.isPending}
          error={state.error}
        />
      ) : (
        <section
          className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-line p-3"
          aria-label="Event timeline"
        >
          <h3 className="font-display text-md font-semibold">Event timeline</h3>
          <p className="text-sm text-fg-secondary">
            Grant changes and policy blocks. Browser state values stay hidden.
          </p>
          {events.isPending ? <p role="status">Reading events…</p> : null}
          {events.error ? <Callout tone="error">{describeApiError(events.error).summary}</Callout> : null}
          {events.data && !events.data.length ? (
            <p className="text-sm text-fg-muted">No events are recorded for this session.</p>
          ) : null}
          {(events.data?.length ?? 0) >= EVENT_LIMIT ? (
            <p className="text-sm text-fg-secondary">Showing the newest {EVENT_LIMIT} events.</p>
          ) : null}
          {events.data?.length ? (
            // The region wraps the list: a role on the <ol> itself would remove its list semantics.
            <div
              role="region"
              aria-label="Browser session events"
              tabIndex={0}
              onKeyDown={handleEvidenceScrollKeyDown}
              className="max-h-96 min-w-0 overflow-y-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ol className="grid min-w-0 grid-cols-1 gap-2">
                {events.data.map((event) => (
                  <li key={event.eventId} className="min-w-0 rounded-md border border-line p-2 text-sm wrap-anywhere">
                    <p className="font-medium">{event.eventType.replaceAll("_", " ")}</p>
                    <p className="text-fg-secondary">
                      {[event.actorId, formatTime(event.createdAt)].filter(Boolean).join(" · ")}
                    </p>
                    <p>{describeEventPayload(event)}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      )}
    </section>
  );
}

function SessionPosture({
  session,
  workspaceId,
  activeGrants,
  onChanged,
}: {
  session: BrowserSessionRecord;
  workspaceId: string;
  activeGrants: BrowserSessionGrantRecord[];
  onChanged: () => Promise<unknown>;
}) {
  const operation = useLibraryOperation(browserSessionOperationScope(workspaceId, session.sessionId));
  const [reviewOpen, setReviewOpen] = useSessionViewState(operation.key + ":close-review", false);
  const [pending, setPending] = useSessionViewState(operation.key + ":close-pending", false);
  const [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string } | undefined>(
    operation.key + ":close-outcome",
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const canReplay = pending && operation.attempt?.phase === "uncertain";

  async function confirmClose(replay = false) {
    if (busy || !operation.current() || (replay ? !canReplay : operation.locked)) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const receipt = await operation.run(
        `close:${session.sessionId}`,
        async () => {
          const fresh = await fetchBrowserSession(session.sessionId);
          if (fresh.workspaceId !== workspaceId)
            throw new Error("This browser session is not in the current workspace.");
        },
        async () => {
          setPending(true);
          return await closeBrowserSession(session.sessionId);
        },
        (value) => {
          if (value.sessionId !== session.sessionId || value.status !== "closed")
            throw new Error("The close receipt does not confirm this session is closed.");
        },
        replay,
      );
      if (!receipt || !operation.current()) return;
      setPending(false);
      setReviewOpen(false);
      // Claim revocation only after the Gateway shows no active grant remains.
      let remaining: number | undefined;
      try {
        remaining = (await fetchBrowserSessionGrants(session.sessionId, { status: "active", limit: 1 })).length;
      } catch {
        remaining = undefined;
      }
      if (!operation.current()) return;
      const closedAt = formatTime(receipt.closedAt) ?? "";
      setOutcome({
        error: remaining !== 0,
        text:
          remaining === undefined
            ? `Session closed ${closedAt}, but GoatCitadel could not confirm whether any grant is still active. Refresh the session to check.`
            : remaining
              ? `Session closed ${closedAt}, but an active grant is still recorded. Review closing again to finish revoking it.`
              : `Session closed ${closedAt}. No active grant remains.`,
      });
      await onChanged();
    } catch (cause) {
      if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  return (
    <section className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-line p-3" aria-label="Session posture">
      <h3 className="font-display text-md font-semibold">Session posture</h3>
      <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Workspace</dt>
          <dd className="wrap-anywhere">{session.workspaceId}</dd>
        </div>
        <div>
          <dt className="font-medium">Created</dt>
          <dd>
            {formatTime(session.createdAt)} by {session.createdBy}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Active grants</dt>
          <dd>{activeGrants.length}</dd>
        </div>
        <div>
          <dt className="font-medium">Closed</dt>
          <dd>{formatTime(session.closedAt) ?? "Not closed"}</dd>
        </div>
      </dl>
      <p className="text-sm text-fg-secondary">
        A session record governs browser grants and events. It does not show that a browser is open, bound or active.
      </p>
      <TechnicalDetails label="Session record">
        <p>Session {session.sessionId}</p>
      </TechnicalDetails>
      {operation.locked && pending ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      {outcome && !reviewOpen ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
      {session.status === "active" || activeGrants.length > 0 || canReplay ? (
        <div>
          <Button
            variant="danger"
            disabled={busy || (operation.locked && !canReplay)}
            onClick={() => {
              setOutcome(undefined);
              setReviewOpen(true);
            }}
          >
            {canReplay ? "Review pending close" : "Review closing this session"}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReviewOpen(false);
            if (!pending) setOutcome({ error: false, text: "Cancelled. The session stays open." });
          }
        }}
        title="Review closing this session"
        description={`Session ${session.label} · workspace ${workspaceId}.`}
      >
        <div className="grid min-w-0 grid-cols-1 gap-3 text-sm wrap-anywhere">
          <p>
            Closes this session and revokes its {activeGrants.length} active grant{activeGrants.length === 1 ? "" : "s"}
            . New tool access through this session is refused once it closes; calls already admitted are not
            interrupted, and browser state is not cleared. A closed session cannot be reopened or receive new grants.
          </p>
          {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReviewOpen(false);
                if (!pending) setOutcome({ error: false, text: "Cancelled. The session stays open." });
              }}
            >
              {canReplay ? "Close" : "Cancel"}
            </Button>
            {canReplay ? (
              <Button disabled={busy} onClick={() => void confirmClose(true)}>
                Replay exact close request
              </Button>
            ) : (
              <Button variant="danger" disabled={busy || operation.locked} onClick={() => void confirmClose()}>
                Close session and revoke grants
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </section>
  );
}
