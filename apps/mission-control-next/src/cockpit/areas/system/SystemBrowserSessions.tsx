import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BrowserSessionRecord } from "@goatcitadel/contracts";
import { createBrowserSession, fetchBrowserSessions } from "@goatcitadel/mission-control-shared/api/browser-sessions";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { StatusBadge } from "../../ui/StatusBadge";
import { useLibraryOperation } from "../library/use-library-operation";
import { BrowserSessionDetail } from "./BrowserSessionDetail";
import { formatTime, LIST_LIMIT } from "./browser-sessions-model";

type Filter = "active" | "closed" | "all";
const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];
/** The exact request, plus the draft it came from so a replay never clears later typing. */
type PendingCreate = { label: string; requestId: string; submitted: { label: string } };

export function SystemBrowserSessions() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  return <BrowserSessionsWorkspace key={workspaceId} workspaceId={workspaceId} />;
}

function BrowserSessionsWorkspace({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const selectedId = new URLSearchParams(route.search).get("sessionId") ?? "";
  const operation = useLibraryOperation(JSON.stringify(["browser-session-create", workspaceId]));
  const [filter, setFilter] = useSessionViewState<Filter>(operation.key + ":filter", "active");
  const list = useQuery({
    queryKey: ["system", "browser-sessions", workspaceId, filter, operation.identity],
    queryFn: () => fetchBrowserSessions({ workspaceId, status: filter, limit: LIST_LIMIT }),
    staleTime: 0,
  });
  const draft = useSessionDraft(operation.presentationScope, { label: "" }, undefined, {
    label: "New browser session",
  });
  const [pending, setPending] = useSessionViewState<PendingCreate | undefined>(
    operation.key + ":create-pending",
    undefined,
  );
  const [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string } | undefined>(
    operation.key + ":create-outcome",
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const sessions = (list.data ?? []).filter((session) => session.workspaceId === workspaceId);
  const select = (sessionId?: string) =>
    route.navigate(`/system/browser-sessions${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);

  async function create(replay = false) {
    if (busy || !operation.current()) return;
    const target: PendingCreate | undefined = replay
      ? pending
      : {
          label: draft.value.label.trim() || "Shared browser session",
          requestId: crypto.randomUUID(),
          submitted: draft.value,
        };
    if (!target || (replay ? operation.attempt?.phase !== "uncertain" : operation.locked)) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const receipt = await operation.run(
        `create:${target.requestId}`,
        async () => undefined,
        async () => {
          if (!replay) setPending(target);
          return await createBrowserSession({ workspaceId, label: target.label, requestId: target.requestId });
        },
        (value: BrowserSessionRecord) => {
          if (value.workspaceId !== workspaceId || value.label !== target.label || value.status !== "active")
            throw new Error("The session receipt does not match the requested session.");
        },
        replay,
      );
      if (!receipt || !operation.current()) return;
      setPending(undefined);
      draft.acceptSaved({ label: "" }, undefined, target.submitted);
      setOutcome({ error: false, text: `Session ${receipt.label} recorded. It has no grants yet.` });
      await list.refetch();
      select(receipt.sessionId);
    } catch (cause) {
      if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary });
    } finally {
      if (operation.current()) setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 overflow-y-auto p-4">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-xl font-semibold">Browser sessions</h1>
        <p className="text-sm text-fg-secondary">
          Governed browser-session records and scoped grants for workspace {workspaceId}. A session record does not
          open, bind or control a browser; tools still need a grant, policy checks and guardrails.
        </p>
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <section
            className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-line p-3"
            aria-label="New browser session"
          >
            <h2 className="font-display text-md font-semibold">New browser session</h2>
            <Field label="Session label" help="Creates an empty session record in this workspace, with no grants.">
              {(props) => (
                <input
                  {...props}
                  className="w-full min-w-0 rounded-md border border-line bg-raised p-2"
                  value={draft.value.label}
                  readOnly={operation.locked}
                  onChange={(event) => draft.setValue({ label: event.target.value })}
                />
              )}
            </Field>
            {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
            {operation.locked && pending ? (
              <p className="text-sm wrap-anywhere">
                Pending request: a session labelled &ldquo;{pending.label}&rdquo; in workspace {workspaceId}.
              </p>
            ) : null}
            {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
            <div className="flex flex-wrap gap-2">
              {operation.locked && pending && operation.attempt?.phase === "uncertain" ? (
                <Button disabled={busy} onClick={() => void create(true)}>
                  Replay exact session request
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy || operation.locked || list.isError}
                  onClick={() => void create()}
                >
                  Create session
                </Button>
              )}
            </div>
          </section>
          <section
            className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-line p-3"
            aria-label="Browser session list"
          >
            <h2 className="font-display text-md font-semibold">Sessions</h2>
            <div role="group" aria-label="Browser session filter" className="flex flex-wrap gap-1">
              {FILTERS.map((item) => (
                <Button
                  key={item.id}
                  variant={filter === item.id ? "secondary" : "ghost"}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </Button>
              ))}
              <Button variant="ghost" disabled={list.isFetching} onClick={() => void list.refetch()}>
                Refresh sessions
              </Button>
            </div>
            {list.isPending ? <p role="status">Reading browser sessions…</p> : null}
            {list.error ? <Callout tone="error">{describeApiError(list.error).summary}</Callout> : null}
            {list.data && !sessions.length ? (
              <p className="text-sm text-fg-muted">No browser sessions match this filter.</p>
            ) : null}
            {(list.data?.length ?? 0) >= LIST_LIMIT ? (
              <p className="text-sm text-fg-secondary">
                Showing the newest {LIST_LIMIT} sessions. Older sessions exist; filter to narrow the list.
              </p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {sessions.map((session) => (
                <li key={session.sessionId} className="min-w-0">
                  <button
                    type="button"
                    aria-current={session.sessionId === selectedId ? "true" : undefined}
                    onClick={() => select(session.sessionId)}
                    className="grid min-h-11 w-full min-w-0 gap-1 rounded-md border border-line p-2 text-left wrap-anywhere aria-[current=true]:border-accent"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <strong>{session.label}</strong>
                      <StatusBadge
                        status={
                          session.status === "active"
                            ? { label: "Open record", tone: "done" }
                            : { label: "Closed record", tone: "neutral" }
                        }
                      />
                    </span>
                    <span className="text-sm text-fg-secondary">Updated {formatTime(session.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="min-w-0 lg:col-span-2">
          {selectedId ? (
            <BrowserSessionDetail
              key={selectedId}
              sessionId={selectedId}
              workspaceId={workspaceId}
              onListChanged={() => list.refetch()}
            />
          ) : (
            <p className="rounded-lg border border-line p-3 text-sm text-fg-secondary">
              Select a session to review its grants, state projection and events.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
