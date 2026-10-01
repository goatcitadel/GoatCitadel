import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useState } from "react";
import type { DurableBackgroundTaskItem, DurableBackgroundTaskRailResponse, DurableBackgroundTaskSemanticLink } from "@goatcitadel/contracts";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { humanizeToken, presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useDurableBackgroundTaskRail } from "../../../features/threaded-surface/useDurableBackgroundTaskRail";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { runWorkspaceSession } from "./run-workspace-context";

const MAX_CHILDREN = 40;
const MAX_SOURCES = 40;
const OUTPUT_LABELS = { available: "Recorded output available", missing: "Output missing", not_terminal: "Output not final", unknown: "Output unknown" };
const SYNTHESIS_LABELS = { available: "Recorded synthesis available", partial: "Synthesis is partial", missing: "Synthesis missing", not_terminal: "Parent has not finished" };

export function RunLineage({ trace, workspaceId }: { trace: ObserveRunTraceResponse; workspaceId: string }) {
  const sessionId = runWorkspaceSession(trace, workspaceId);
  return <section aria-label="Delegation lineage" className="rounded-lg border border-line bg-raised p-4">
    <h2 className="font-display text-lg font-semibold text-fg">Delegation lineage</h2>
    <p className="mt-2 text-sm text-fg-secondary">Direct children watched by this run and the outputs cited by its selected synthesis. Run status is current; output references describe recorded evidence.</p>
    <p className="mt-1 text-xs text-fg-muted">This view covers one parent and its watched children. Open a child run to inspect another level.</p>
    {sessionId ? <LineageInspection key={JSON.stringify([workspaceId, trace.runId, sessionId])} runId={trace.runId} sessionId={sessionId} workspaceId={workspaceId} />
      : <p className="mt-3 text-sm text-fg-muted">Lineage unavailable: this run has no consistent Gateway-resolved conversation in this workspace.</p>}
  </section>;
}

function LineageInspection(props: { runId: string; sessionId: string; workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="mt-3 grid gap-3">
    <Button size="sm" onClick={() => setOpen((value) => !value)}>{open ? "Hide lineage" : "Inspect lineage"}</Button>
    {open ? <LineageSnapshot {...props} /> : null}
  </div>;
}

function LineageSnapshot({ runId, sessionId, workspaceId }: { runId: string; sessionId: string; workspaceId: string }) {
  const rail = useDurableBackgroundTaskRail({ parentRunId: runId, sessionId, workspaceId });
  const snapshot = !rail.error && !rail.loading && !rail.refreshing ? rail.snapshot : null;
  const bound = snapshot && snapshot.parent.runId === runId && snapshot.scope.verified
    && snapshot.scope.workspaceId === workspaceId && snapshot.scope.sessionId === sessionId
    && snapshot.tasks.every((task) => task.scope.workspaceId === workspaceId);
  return <div className="grid min-w-0 gap-3">
    <Button size="sm" disabled={rail.loading || rail.refreshing} onClick={() => void rail.refresh()}>Refresh lineage</Button>
    {rail.loading || rail.refreshing ? <p role="status" className="text-sm text-fg-muted">Reading run lineage…</p> : null}
    {rail.error ? <p role="alert" className="text-sm text-status-failed">Lineage unavailable: {rail.error}</p> : null}
    {snapshot && !bound ? <p role="alert" className="text-sm text-status-failed">Lineage has no matching run and workspace evidence.</p> : null}
    {bound ? <LineageEvidence snapshot={snapshot} /> : null}
  </div>;
}

function LineageEvidence({ snapshot }: { snapshot: DurableBackgroundTaskRailResponse }) {
  const children = snapshot.tasks.filter((task) => task.scope.verified);
  const unverified = snapshot.tasks.length - children.length;
  const sources = snapshot.synthesis.lineage.filter((entry) => children.some((task) => task.watcherId === entry.watcherId));
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle p-3">
      <p className="text-sm font-medium text-fg">This parent run</p><StatusBadge status={presentRunStatus(snapshot.parent.status)} />
    </div>
    <p className="text-xs text-fg-muted">Gateway snapshot: {snapshot.generatedAt}. Showing up to {MAX_CHILDREN} verified children and {MAX_SOURCES} cited sources.</p>
    {!snapshot.coverage.watchers.complete || !snapshot.coverage.parentSignals.complete ? <p className="text-sm text-status-waiting">Coverage is partial. Additional children or parent signals may be omitted.</p> : null}
    {unverified > 0 ? <p className="text-sm text-fg-muted">{unverified} child {unverified === 1 ? "record has" : "records have"} unverified scope; details are withheld.</p> : null}
    {children.length ? <ol className="grid gap-3 border-l border-line pl-3" aria-label="Watched child runs">
      {children.slice(0, MAX_CHILDREN).map((task) => <li key={task.watcherId}><ChildEvidence task={task} /></li>)}
    </ol> : <p className="text-sm text-fg-muted">No verified watched children were returned for this run.</p>}
    {children.length > MAX_CHILDREN ? <p className="text-xs text-fg-muted">{children.length - MAX_CHILDREN} additional verified children are outside this display.</p> : null}
    <section aria-label="Recorded synthesis sources" className="min-w-0 rounded-md border border-line-subtle p-3">
      <h3 className="text-sm font-semibold text-fg">Parent synthesis</h3>
      <p className="mt-1 text-sm text-fg-secondary">{SYNTHESIS_LABELS[snapshot.synthesis.availability]}</p>
      {snapshot.synthesis.summary ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg">{snapshot.synthesis.summary}</p> : null}
      {sources.length ? <ol className="mt-3 grid gap-2">{sources.slice(0, MAX_SOURCES).map((source) => <li key={source.watcherId} className="min-w-0 rounded-md bg-sunken p-3">
        <p className="text-sm font-medium text-fg">Cited {humanizeToken(source.source).toLowerCase()} output</p>
        <p className="mt-1 break-all text-xs text-fg-muted">{source.byteCount} bytes · SHA-256 {source.sha256}</p>
        <LineageLinks links={source.links} />
      </li>)}</ol> : <p className="mt-2 text-sm text-fg-muted">No verified output citations were returned.</p>}
      {sources.length > MAX_SOURCES ? <p className="mt-2 text-xs text-fg-muted">{sources.length - MAX_SOURCES} additional cited sources are outside this display.</p> : null}
      {snapshot.synthesis.missingTerminalChildRunIds.length > 0 ? <p className="mt-2 text-sm text-fg-secondary">Output is missing from {snapshot.synthesis.missingTerminalChildRunIds.length} finished child runs.</p> : null}
      {snapshot.synthesis.uncoveredChildRunIds.length > 0 || snapshot.synthesis.uncoveredStepIds.length > 0 ? <p className="mt-2 text-sm text-fg-secondary">This synthesis does not cover {snapshot.synthesis.uncoveredChildRunIds.length} watched children and {snapshot.synthesis.uncoveredStepIds.length} delegation steps.</p> : null}
    </section>
    {snapshot.unknowns.length ? <details className="text-sm text-fg-secondary"><summary className="cursor-pointer">Evidence limitations ({snapshot.unknowns.length})</summary><ul className="mt-2 grid gap-1">{snapshot.unknowns.slice(0, 8).map((unknown, index) => <li key={index}>{unknown}</li>)}</ul></details> : null}
  </>;
}

function ChildEvidence({ task }: { task: DurableBackgroundTaskItem }) {
  const status = task.canonicalStatus === "missing" || task.canonicalStatus === "unknown"
    ? { label: "Status unavailable", tone: "neutral" as const } : presentRunStatus(task.canonicalStatus);
  return <article className="min-w-0 rounded-md border border-line-subtle p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="break-words text-sm font-medium text-fg">{task.label}</h3><StatusBadge status={status} /></div>
    <p className="mt-1 text-xs text-fg-muted">{task.role ? `${task.role} · ` : ""}{humanizeToken(task.watcherState)} watcher · {OUTPUT_LABELS[task.output.availability]}</p>
    {task.output.availability === "available" ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-secondary">{task.output.summary}</p> : null}
    {task.blockers.length ? <ul className="mt-2 grid gap-1 text-sm text-fg-secondary">{task.blockers.slice(0, 4).map((blocker, index) => <li key={index}>{blocker.message}</li>)}</ul> : null}
    {task.signalIntegrity.posture !== "clean" || !task.signalIntegrity.observationComplete ? <p className="mt-2 text-xs text-fg-muted">Retained child signals are {humanizeToken(task.signalIntegrity.posture).toLowerCase()}{!task.signalIntegrity.observationComplete ? " and incomplete" : ""}. Run status comes from its durable record.</p> : null}
    <LineageLinks links={task.links} />
  </article>;
}

function LineageLinks({ links }: { links: DurableBackgroundTaskSemanticLink[] }) {
  return <div className="mt-2 flex flex-wrap gap-3">{links.map((link) => {
    const href = link.kind === "durable_run" ? `/work/runs/${encodeURIComponent(link.id)}`
      : link.kind === "chat_session" ? `/chat?sessionId=${encodeURIComponent(link.id)}&shell=cockpit` : null;
    return href ? <NativeOwnerLink key={`${link.kind}:${link.id}`} scope={[link.kind, link.id]} className="text-sm font-medium text-accent hover:underline" href={href}>{link.label}</NativeOwnerLink> : null;
  })}</div>;
}
