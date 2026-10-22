import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchDevDiagnostics } from "@goatcitadel/mission-control-shared/api/diagnostics";
import { fetchDaemonLogs } from "@goatcitadel/mission-control-shared/api/platform";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { describeOperatorInboxError } from "../../data/operator-inbox-error";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { Button } from "../../ui/Button";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { saveLibraryDownload } from "../library/library-download";
import { buildRecentDiagnosticsExport } from "./recent-diagnostics-export";
import { FirstRunVerification } from "../settings/FirstRunVerification";
import { RuntimeAuthorityMap } from "./RuntimeAuthorityMap";
import { TimeText } from "../../ui/TimeText";
import { DIAGNOSTIC_LEVEL, presentDiagnosticCategory, presentDiagnosticEvent } from "./system-vocabulary";

// Segmented control: the pressed view uses a neutral fill and strong border, not the primary accent.
const EVENT_VIEW_TOGGLE = "aria-[pressed=true]:border-fg aria-[pressed=true]:bg-sunken";

export function SystemDiagnostics() {
  const location = useCockpitRoute();
  const [eventView, setEventView] = useState<"issues" | "all">("issues");
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const diagnostics = useQuery({
    queryKey: queryKeys.systemDiagnostics(),
    queryFn: () => fetchDevDiagnostics({ limit: 100 }),
    refetchInterval: 30_000,
  });
  const logs = useQuery({
    queryKey: ["system", "daemon-logs", 100],
    queryFn: () => fetchDaemonLogs(100),
    refetchInterval: 30_000,
  });
  const inbox = useOperatorInbox(workspaceId);
  const scopedInbox = !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined;
  const deadLetters =
    scopedInbox?.items.filter((item) => item.kind === "dead_letter" && item.source.workspaceId === workspaceId) ?? [];
  const deadLetterCoverage = scopedInbox?.coverage.find((source) => source.source === "dead_letters");
  const fetching = diagnostics.isFetching || logs.isFetching || inbox.isFetching;
  const eventWindow = diagnostics.data?.items ?? [];
  const filteredEvents =
    eventView === "issues"
      ? eventWindow.filter((item) => item.level === "warn" || item.level === "error")
      : eventWindow;
  const visibleEvents = showAllEvents ? filteredEvents : filteredEvents.slice(0, 20);
  const eventCountLabel =
    eventView === "issues"
      ? filteredEvents.length === 1
        ? "warning or error"
        : "warnings or errors"
      : filteredEvents.length === 1
        ? "event"
        : "events";
  const remainingEvents = filteredEvents.length - visibleEvents.length;
  const selectEventView = (view: "issues" | "all") => {
    setEventView(view);
    setShowAllEvents(false);
  };
  const exportRecent = () => {
    if (!diagnostics.data && !logs.data) return;
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
      setExportNotice({ tone: "error", message: "Diagnostics export is unavailable in this environment." });
      return;
    }
    try {
      const payload = buildRecentDiagnosticsExport({
        generatedAt: new Date().toISOString(),
        events: { items: diagnostics.data?.items, failed: diagnostics.isError, fetchedAt: diagnostics.dataUpdatedAt },
        logs: { items: logs.data?.items, failed: logs.isError, fetchedAt: logs.dataUpdatedAt },
      });
      // The shared helper attaches the anchor and defers revoking the URL, so Firefox and Safari keep the download.
      saveLibraryDownload(
        "goatcitadel-recent-diagnostics.json",
        new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" }),
      );
      setExportNotice({
        tone: "success",
        message:
          !diagnostics.data || !logs.data || diagnostics.isError || logs.isError
            ? "Partial recent diagnostics downloaded. The file marks unavailable or stale sources."
            : "Recent diagnostics downloaded. Review the file before sharing.",
      });
    } catch {
      setExportNotice({ tone: "error", message: "Could not create a diagnostics export on this device." });
    }
  };
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Diagnostics"
        description="Recent events, daemon logs, and unresolved recovery records."
        actions={
          <>
            <Button
              size="sm"
              disabled={diagnostics.isFetching || logs.isFetching || (!diagnostics.data && !logs.data)}
              onClick={exportRecent}
            >
              Export recent diagnostics
            </Button>
            <Button
              size="sm"
              disabled={fetching}
              onClick={() => {
                void diagnostics.refetch();
                void logs.refetch();
                void inbox.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" className="size-4" /> Refresh
            </Button>
          </>
        }
      >
        <p className="mt-1 text-xs text-fg-muted">
          Export includes only the recent event and log fields shown here. Messages may contain technical details;
          review the file before sharing.
        </p>
      </AreaHeader>
      {exportNotice ? (
        <p
          role={exportNotice.tone === "error" ? "alert" : "status"}
          className={exportNotice.tone === "error" ? "text-sm text-status-failed" : "text-sm text-fg-secondary"}
        >
          {exportNotice.message}
        </p>
      ) : null}
      <FirstRunVerification />

      <section aria-labelledby="diagnostics-recovery-title" className="border-t border-line-subtle pt-4">
        <h2 id="diagnostics-recovery-title" className="text-base font-semibold text-fg">
          Queue recovery
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          From this workspace's Inbox. The count is complete only when every source could be checked.
        </p>
        {inbox.isLoading ? (
          <p role="status" className="mt-3 text-sm text-fg-muted">
            Checking recovery records…
          </p>
        ) : null}
        {inbox.isError ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            Recovery records unavailable: {describeOperatorInboxError(inbox.error).summary}
          </p>
        ) : null}
        {inbox.data && !inbox.isError && !scopedInbox ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            The recovery list contains records outside the selected workspace.
          </p>
        ) : null}
        {scopedInbox && !inbox.isError ? (
          <>
            <p className="mt-3 text-sm font-medium text-fg">
              {deadLetters.length} known unresolved dead {deadLetters.length === 1 ? "letter" : "letters"}
            </p>
            {deadLetterCoverage?.state !== "current" ? (
              <p className="mt-1 text-xs text-status-waiting">
                {deadLetterCoverage?.detail ?? "Dead-letter source coverage is incomplete; this is a lower bound."}
              </p>
            ) : null}
            {deadLetters.length ? (
              <ul className="mt-2 divide-y divide-line-subtle">
                {deadLetters.map((item) => (
                  <li key={item.id} className="py-3">
                    <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                    <p className="mt-1 text-sm text-fg-secondary">{item.summary}</p>
                    {item.source.runId ? (
                      <NativeOwnerLink
                        scope={[workspaceId, item.id, item.source.runId]}
                        className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
                        href={`/work/runs/${encodeURIComponent(item.source.runId)}`}
                      >
                        Review run and guarded recovery
                      </NativeOwnerLink>
                    ) : (
                      <SystemOwnerLink href={item.href} scope={[workspaceId, item.id]}>
                        Review run and guarded recovery
                      </SystemOwnerLink>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </section>

      <section aria-labelledby="diagnostics-logs-title" className="border-t border-line-subtle pt-4">
        <h2 id="diagnostics-logs-title" className="text-base font-semibold text-fg">
          Daemon logs
        </h2>
        <p className="mt-1 text-xs text-fg-muted">Latest 100 entries from the daemon log.</p>
        {logs.isLoading ? (
          <p role="status" className="mt-3 text-sm text-fg-muted">
            Loading daemon logs…
          </p>
        ) : null}
        {logs.isError ? <Callout tone="error">Logs unavailable: {describeApiError(logs.error).summary}</Callout> : null}
        {logs.data && !logs.isError ? (
          logs.data.items.length ? (
            <ul className="mt-2 divide-y divide-line-subtle">
              {logs.data.items.map((item, index) => (
                <li key={`${item.timestamp}:${index}`} className="py-3">
                  <p className="text-xs font-medium text-fg-muted">
                    {DIAGNOSTIC_LEVEL[item.level] ?? "Log"} · <TimeText value={item.timestamp} />
                  </p>
                  <p className="mt-2 break-words text-sm text-fg-secondary">{item.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-fg-muted">No daemon log entries were returned.</p>
          )
        ) : null}
      </section>

      <section aria-labelledby="diagnostics-events-title" className="border-t border-line-subtle pt-4">
        <h2 id="diagnostics-events-title" className="text-base font-semibold text-fg">
          Diagnostic events
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          Latest 100 client and server diagnostic entries. This is a recent window, not complete history.
        </p>
        <div role="group" aria-label="Diagnostic event view" className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            aria-pressed={eventView === "issues"}
            className={EVENT_VIEW_TOGGLE}
            onClick={() => selectEventView("issues")}
          >
            Warnings and errors
          </Button>
          <Button
            size="sm"
            aria-pressed={eventView === "all"}
            className={EVENT_VIEW_TOGGLE}
            onClick={() => selectEventView("all")}
          >
            All events
          </Button>
        </div>
        {diagnostics.isLoading ? (
          <p role="status" className="mt-3 text-sm text-fg-muted">
            Loading diagnostics…
          </p>
        ) : null}
        {diagnostics.isError ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            Diagnostics unavailable: {describeApiError(diagnostics.error).summary}
          </p>
        ) : null}
        {diagnostics.data && !diagnostics.isError ? (
          eventWindow.length ? (
            <>
              <p className="mt-3 text-xs text-fg-muted">
                {filteredEvents.length} {eventCountLabel} in the latest {eventWindow.length} received entries
                {remainingEvents > 0 ? `; showing the first ${visibleEvents.length}` : ""}.
              </p>
              {filteredEvents.length ? (
                <ul className="mt-2 divide-y divide-line-subtle">
                  {visibleEvents.map((item) => (
                    <li key={item.id} className="py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-fg-muted">
                            {DIAGNOSTIC_LEVEL[item.level] ?? "Event"} · {presentDiagnosticCategory(item.category)}
                          </p>
                          <h3 className="mt-1 text-sm font-semibold text-fg">{presentDiagnosticEvent(item.event)}</h3>
                        </div>
                        <TimeText value={item.timestamp} className="text-xs text-fg-muted" />
                      </div>
                      <p className="mt-2 break-words text-sm text-fg-secondary">{item.message}</p>
                      <TechnicalDetails label="Event technical details">
                        <pre className="max-h-64 overflow-auto font-mono text-xs">
                          {JSON.stringify(
                            { id: item.id, event: item.event, category: item.category, timestamp: item.timestamp },
                            null,
                            2,
                          )}
                        </pre>
                      </TechnicalDetails>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-fg-muted">
                  No warnings or errors were returned in this recent window. Select All events to inspect routine
                  activity.
                </p>
              )}
              {remainingEvents > 0 ? (
                <Button className="mt-3" size="sm" onClick={() => setShowAllEvents(true)}>
                  Show remaining {remainingEvents} {remainingEvents === 1 ? "event" : "events"}
                </Button>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-sm text-fg-muted">No diagnostic entries were returned in this window.</p>
          )
        ) : null}
      </section>
      <RuntimeAuthorityMap key={workspaceId} workspaceId={workspaceId} />
      <NativeOwnerLink
        href={`/system/runtime/diagnostics${location.search}${location.hash}`}
        className="text-sm font-medium text-accent hover:underline"
        scope={workspaceId}
      >
        Open full diagnostics and export controls
      </NativeOwnerLink>
    </section>
  );
}
