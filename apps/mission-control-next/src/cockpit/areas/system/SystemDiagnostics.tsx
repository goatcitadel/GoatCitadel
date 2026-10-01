import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchDevDiagnostics } from "@goatcitadel/mission-control-shared/api/diagnostics";
import { fetchDaemonLogs } from "@goatcitadel/mission-control-shared/api/platform";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { describeOperatorInboxError } from "../../data/operator-inbox-error";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { Button } from "../../ui/Button";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { buildRecentDiagnosticsExport } from "./recent-diagnostics-export";

function timestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time) : "Time unavailable";
}

export function SystemDiagnostics() {
  const [eventView, setEventView] = useState<"issues" | "all">("issues");
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const diagnostics = useQuery({ queryKey: queryKeys.systemDiagnostics(), queryFn: () => fetchDevDiagnostics({ limit: 100 }), refetchInterval: 30_000 });
  const logs = useQuery({ queryKey: ["system", "daemon-logs", 100], queryFn: () => fetchDaemonLogs(100), refetchInterval: 30_000 });
  const inbox = useOperatorInbox(workspaceId);
  const scopedInbox = !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined;
  const deadLetters = scopedInbox?.items.filter((item) => item.kind === "dead_letter" && item.source.workspaceId === workspaceId) ?? [];
  const deadLetterCoverage = scopedInbox?.coverage.find((source) => source.source === "dead_letters");
  const fetching = diagnostics.isFetching || logs.isFetching || inbox.isFetching;
  const eventWindow = diagnostics.data?.items ?? [];
  const filteredEvents = eventView === "issues"
    ? eventWindow.filter((item) => item.level === "warn" || item.level === "error")
    : eventWindow;
  const visibleEvents = showAllEvents ? filteredEvents : filteredEvents.slice(0, 20);
  const eventCountLabel = eventView === "issues"
    ? filteredEvents.length === 1 ? "warning or error" : "warnings or errors"
    : filteredEvents.length === 1 ? "event" : "events";
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
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "goatcitadel-recent-diagnostics.json";
        anchor.click();
      } finally { URL.revokeObjectURL(url); }
      setExportNotice({ tone: "success", message: !diagnostics.data || !logs.data || diagnostics.isError || logs.isError
        ? "Partial recent diagnostics downloaded. The file marks unavailable or stale sources."
        : "Recent diagnostics downloaded. Review the file before sharing." });
    } catch {
      setExportNotice({ tone: "error", message: "Could not create a diagnostics export on this device." });
    }
  };
  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="font-display text-xl font-semibold text-fg">Diagnostics</h1>
        <p className="text-sm text-fg-secondary">Recent events, daemon logs, and unresolved recovery records.</p>
        <p className="mt-1 text-xs text-fg-muted">Export includes only the recent event and log fields shown here. Messages may contain technical details; review the file before sharing.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={diagnostics.isFetching || logs.isFetching || (!diagnostics.data && !logs.data)} onClick={exportRecent}>Export recent diagnostics</Button>
        <Button size="sm" disabled={fetching} onClick={() => { void diagnostics.refetch(); void logs.refetch(); void inbox.refetch(); }}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
      </div>
    </header>
    {exportNotice ? <p role={exportNotice.tone === "error" ? "alert" : "status"} className={exportNotice.tone === "error" ? "text-sm text-status-failed" : "text-sm text-fg-secondary"}>{exportNotice.message}</p> : null}

    <section aria-labelledby="diagnostics-recovery-title" className="rounded-lg border border-line bg-raised p-4">
      <h2 id="diagnostics-recovery-title" className="font-display text-lg font-semibold text-fg">Durable queue recovery</h2>
      <p className="mt-1 text-xs text-fg-muted">Workspace-scoped Inbox projection. Its owner coverage determines whether the count is complete.</p>
      {inbox.isLoading ? <p role="status" className="mt-3 text-sm text-fg-muted">Checking recovery records…</p> : null}
      {inbox.isError ? <p role="alert" className="mt-3 text-sm text-status-failed">Recovery records unavailable: {describeOperatorInboxError(inbox.error).summary}</p> : null}
      {inbox.data && !inbox.isError && !scopedInbox ? <p role="alert" className="mt-3 text-sm text-status-failed">Recovery projection contains records outside the selected workspace.</p> : null}
      {scopedInbox && !inbox.isError ? <>
        <p className="mt-3 text-sm font-medium text-fg">{deadLetters.length} known unresolved dead {deadLetters.length === 1 ? "letter" : "letters"}</p>
        {deadLetterCoverage?.state !== "current" ? <p className="mt-1 text-xs text-status-waiting">{deadLetterCoverage?.detail ?? "Dead-letter source coverage is incomplete; this is a lower bound."}</p> : null}
        {deadLetters.length ? <ul className="mt-3 grid gap-2">{deadLetters.map((item) => <li key={item.id} className="rounded-md border border-line-subtle bg-sunken p-3">
          <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{item.summary}</p>
          {item.source.runId ? <NativeOwnerLink scope={[workspaceId, item.id, item.source.runId]} className="mt-2 inline-block text-sm font-medium text-accent hover:underline" href={`/work/runs/${encodeURIComponent(item.source.runId)}`}>Review run and guarded recovery</NativeOwnerLink> : <ClassicOwnerLink href={item.href} scope={JSON.stringify([workspaceId, item.id])} className="mt-2 inline-block text-sm font-medium text-accent hover:underline" label="Review run and guarded recovery" />}
        </li>)}</ul> : null}
      </> : null}
    </section>

    <section aria-labelledby="diagnostics-logs-title" className="rounded-lg border border-line bg-raised p-4">
      <h2 id="diagnostics-logs-title" className="font-display text-lg font-semibold text-fg">Daemon logs</h2>
      <p className="mt-1 text-xs text-fg-muted">Latest 100 entries reported by the Gateway daemon log API.</p>
      {logs.isLoading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading daemon logs…</p> : null}
      {logs.isError ? <p role="alert" className="mt-3 text-sm text-status-failed">Logs unavailable: {describeApiError(logs.error).summary}</p> : null}
      {logs.data && !logs.isError ? logs.data.items.length ? <ul className="mt-3 grid gap-2">{logs.data.items.map((item, index) => <li key={`${item.timestamp}:${index}`} className="rounded-md border border-line-subtle bg-sunken p-3">
        <details><summary className="cursor-pointer text-sm font-medium text-fg">{humanizeToken(item.level)} · {timestamp(item.timestamp)}</summary>
          <p className="mt-2 break-words text-sm text-fg-secondary">{item.message}</p></details>
      </li>)}</ul> : <p className="mt-3 text-sm text-fg-muted">No daemon log entries were returned.</p> : null}
    </section>

    <section aria-labelledby="diagnostics-events-title">
      <h2 id="diagnostics-events-title" className="font-display text-lg font-semibold text-fg">Diagnostic events</h2>
      <p className="mt-1 text-xs text-fg-muted">Latest 100 client and Gateway diagnostic entries. This is a recent window, not complete history.</p>
      <div role="group" aria-label="Diagnostic event view" className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant={eventView === "issues" ? "primary" : "secondary"} aria-pressed={eventView === "issues"} onClick={() => selectEventView("issues")}>Warnings and errors</Button>
        <Button size="sm" variant={eventView === "all" ? "primary" : "secondary"} aria-pressed={eventView === "all"} onClick={() => selectEventView("all")}>All events</Button>
      </div>
      {diagnostics.isLoading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading diagnostics…</p> : null}
      {diagnostics.isError ? <p role="alert" className="mt-3 text-sm text-status-failed">Diagnostics unavailable: {describeApiError(diagnostics.error).summary}</p> : null}
      {diagnostics.data && !diagnostics.isError ? eventWindow.length ? <>
        <p className="mt-3 text-xs text-fg-muted">{filteredEvents.length} {eventCountLabel} in the latest {eventWindow.length} received entries{remainingEvents > 0 ? `; showing the first ${visibleEvents.length}` : ""}.</p>
        {filteredEvents.length ? <ul className="mt-3 grid gap-2">{visibleEvents.map((item) => <li key={item.id} className="rounded-lg border border-line bg-raised p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-medium text-fg-muted">{humanizeToken(item.level)} · {humanizeToken(item.category)}</p><h3 className="mt-1 text-sm font-semibold text-fg">{humanizeToken(item.event)}</h3></div>
          <time dateTime={item.timestamp} className="text-xs text-fg-muted">{timestamp(item.timestamp)}</time></div>
        <details className="mt-2 text-sm text-fg-secondary"><summary className="cursor-pointer font-medium text-accent">Message</summary><p className="mt-2 break-words">{item.message}</p></details>
        </li>)}</ul> : <p className="mt-3 text-sm text-fg-muted">No warnings or errors were returned in this recent window. Select All events to inspect routine activity.</p>}
        {remainingEvents > 0 ? <Button className="mt-3" size="sm" onClick={() => setShowAllEvents(true)}>Show remaining {remainingEvents} {remainingEvents === 1 ? "event" : "events"}</Button> : null}
      </> : <p className="mt-3 text-sm text-fg-muted">No diagnostic entries were returned in this window.</p> : null}
    </section>
    <ClassicOwnerLink href="/ops/diagnostics?shell=classic" className="text-sm font-medium text-accent hover:underline" scope={workspaceId} label="Open full Ops diagnostics and export controls" />
  </section>;
}
