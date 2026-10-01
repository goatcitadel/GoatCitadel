import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useState } from "react";
import type { ChatCitationRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/ChatToolResultPreview";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ThreadedDocumentsPanel } from "../../../features/threaded-surface/ThreadedDocumentsPanel";
import { ThreadedContextConflictNotices } from "../../../features/threaded-surface/ThreadedContextConflictNotices";
import { StatusBadge } from "../../ui/StatusBadge";
import { ChatBackgroundTasks } from "./ChatBackgroundTasks";
import { recordedCostLabel } from "./recorded-cost";

type ChatInspectorTab = "run" | "turn" | "sources" | "context" | "files" | "thread" | "background";

const TABS: readonly { id: ChatInspectorTab; label: string }[] = [
  { id: "run", label: "Run" },
  { id: "turn", label: "Turn" },
  { id: "sources", label: "Sources" },
  { id: "context", label: "Context" },
  { id: "files", label: "Files" },
  { id: "thread", label: "Thread" },
  { id: "background", label: "Background" },
];

function statusTone(status: string): "running" | "waiting" | "done" | "failed" | "neutral" {
  if (status === "running" || status === "started" || status === "streaming") return "running";
  if (status === "waiting" || status === "approval_required" || status === "blocked" || status === "paused") return "waiting";
  if (status === "completed" || status === "done" || status === "executed") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  return "neutral";
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 border-b border-line-subtle py-2 text-sm">
    <dt className="text-fg-muted">{label}</dt><dd className="min-w-0 text-right text-fg-secondary wrap-anywhere">{value}</dd>
  </div>;
}

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function SourcesPanel({ turn }: { turn: ChatThreadTurnRecord | undefined }) {
  if (!turn) return <p className="text-sm text-fg-muted">Select a conversation turn to inspect its sources.</p>;
  if (!turn.citations.length) return <p className="text-sm text-fg-muted">No sources were recorded for this turn.</p>;
  return <ol className="space-y-2">{turn.citations.map((source: ChatCitationRecord) => {
    const href = safeSourceHref(source.url);
    return <li key={source.citationId} className="rounded-md border border-line bg-raised p-3 text-sm">
      <p className="mb-1 text-xs text-fg-muted">{source.sourceType ? humanizeToken(source.sourceType) : "Source"}</p>
      {href ? <a href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-accent underline-offset-2 hover:underline">{source.title || "Open source"}</a>
        : <span className="font-medium text-fg">{source.title || "Source"}</span>}
      {source.snippet ? <p className="mt-2 text-fg-secondary">{source.snippet}</p> : null}
    </li>;
  })}</ol>;
}

export function ChatInspector({ input, targetTurnId, initialTab = "run" }: { input: MissionThreadedRenderSurfaceInput; targetTurnId?: string | null; initialTab?: ChatInspectorTab }) {
  const [tab, setTab] = useState<ChatInspectorTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const active = input.activeSessionSurfaceProps;
  const dock = input.contextDockProps;
  if (!active) return <p className="text-sm text-fg-muted">Choose a conversation to inspect.</p>;
  const visibleTurns = active.thread?.turns.filter((turn) => turn.branch.isSelectedPath &&
    turn.trace.sessionId === dock?.selectedSessionId && turn.trace.turnId === turn.turnId) ?? [];
  const selectedTurn = visibleTurns.find((turn) => turn.turnId === targetTurnId)
    ?? visibleTurns.find((turn) => turn.turnId === active.selectedTurnId) ?? visibleTurns.at(-1);
  const run = selectedTurn && active.delegationRun?.attachedTurnId === selectedTurn.turnId ? active.delegationRun : null;
  const openedArtifact = dock?.activeGeneratedArtifact;
  const selectedArtifact = openedArtifact && openedArtifact.turnId === selectedTurn?.turnId &&
    openedArtifact.sessionId === dock?.selectedSessionId ? openedArtifact : null;
  const contextInspection = selectedTurn && dock?.selectedTurn?.turnId === selectedTurn.turnId &&
    dock.selectedSessionId === selectedTurn.trace.sessionId &&
    dock.capabilityProfileInspection.status === "verified" &&
    dock.capabilityProfileInspection.expectedProfileId === selectedTurn.trace.capabilityProfileId &&
    dock.capabilityProfileInspection.expectedProfileHash === selectedTurn.trace.capabilityProfileHash
    ? dock.capabilityProfileInspection.routedContext : undefined;
  const routedContext = selectedTurn?.trace.routing?.routedContext;
  const verifiedRoutedContext = contextInspection?.snapshotId === routedContext?.snapshotId &&
    contextInspection?.snapshotHash === routedContext?.snapshotHash &&
    contextInspection?.sourceRequestHash === routedContext?.sourceRequestHash &&
    contextInspection?.contentHash === routedContext?.contentHash ? contextInspection : undefined;
  const currentContextMatchesSession = Boolean(dock?.selectedSessionId &&
    dock.selectedSessionId === active.selectedSessionId && dock.selectedSessionId === input.sessionRail.selectedSessionId);

  return <div className="space-y-4">
    <div role="tablist" aria-label="Conversation inspector" className="grid grid-cols-3 gap-1 rounded-md bg-sunken p-1">
      {TABS.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id}
        aria-controls={`cockpit-inspector-${entry.id}`} onClick={() => setTab(entry.id)}
        className="min-h-8 rounded px-2 text-xs font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg">
        {entry.label}
      </button>)}
    </div>
    <section id={`cockpit-inspector-${tab}`} role="tabpanel" aria-label={TABS.find((entry) => entry.id === tab)?.label} className="min-w-0">
      {tab === "run" ? run ? <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-md font-semibold text-fg">{run.label}</h3><StatusBadge status={{ label: humanizeToken(run.status), tone: statusTone(run.status) }} /></div>
        <p className="text-sm text-fg-secondary">{run.objective}</p>
        <ol className="space-y-2">{run.steps.map((step) => <li key={step.stepId} className="rounded-md border border-line bg-raised p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium text-fg">{step.label ?? `Step ${step.index + 1}`}</span><StatusBadge status={{ label: humanizeToken(step.status), tone: statusTone(step.status) }} /></div>
          {step.summary ? <p className="mt-1 text-sm text-fg-secondary">{step.summary}</p> : null}
          {step.error ? <p className="mt-1 text-sm text-status-failed">{step.error}</p> : null}
          {step.output ? <details className="mt-2 text-sm text-fg-secondary">
            <summary className="cursor-pointer text-accent">Recorded output</summary>
            <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap wrap-anywhere">{step.output}</div>
          </details> : null}
        </li>)}</ol>
        {selectedTurn?.trace.durable?.runId ? <NativeOwnerLink scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]} className="text-sm font-medium text-accent hover:underline" href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}>Open durable evidence</NativeOwnerLink>
          : <p className="text-xs text-fg-muted">No linked durable run is recorded for this turn.</p>}
      </div> : <div className="space-y-2 text-sm text-fg-muted"><p>No delegation run is linked to this turn.</p>
        {selectedTurn?.trace.durable?.runId ? <NativeOwnerLink scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]} className="font-medium text-accent hover:underline" href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}>Open durable evidence</NativeOwnerLink> : null}</div> : null}

      {tab === "turn" ? selectedTurn ? <div className="space-y-3">
        <StatusBadge status={{ label: humanizeToken(selectedTurn.trace.status), tone: statusTone(selectedTurn.trace.status) }} />
        <dl><DetailRow label="Model" value={selectedTurn.trace.model ?? "Not recorded"} />
          <DetailRow label="Tools" value={String(selectedTurn.toolRuns.length)} />
          <DetailRow label="Sources" value={String(selectedTurn.citations.length)} />
          <DetailRow label="Duration" value={selectedTurn.trace.completion?.latencyMs === undefined ? "Not recorded" : `${(selectedTurn.trace.completion.latencyMs / 1000).toFixed(1)} seconds`} />
          <DetailRow label="Cost" value={recordedCostLabel(selectedTurn.trace.completion?.usage?.costUsd, selectedTurn.trace.completion?.usage?.costSource)} /></dl>
        {selectedTurn.trace.failure?.message ? <p role="alert" className="rounded-md border border-status-failed p-2 text-sm text-fg-secondary">{selectedTurn.trace.failure.message}</p> : null}
        {selectedTurn.toolRuns.length ? <ol className="space-y-1">{selectedTurn.toolRuns.map((tool) => <li key={tool.toolRunId} className="flex justify-between gap-2 text-sm"><span>{chatToolDisplayName(tool)}</span><span className="text-fg-muted">{humanizeToken(tool.status)}</span></li>)}</ol> : null}
        {selectedTurn.trace.durable?.runId ? <NativeOwnerLink scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]} className="text-sm font-medium text-accent hover:underline" href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}>Open durable evidence</NativeOwnerLink> : null}
      </div> : <p className="text-sm text-fg-muted">No turn is available yet.</p> : null}

      {tab === "sources" ? <SourcesPanel turn={selectedTurn} /> : null}

      {tab === "context" ? <div className="space-y-4 text-sm">
        <section aria-label="Recorded turn context" className="space-y-2">
          <h3 className="font-medium text-fg">Recorded for this turn</h3>
          {selectedTurn ? <>
            <dl><DetailRow label="Memory mode" value={humanizeToken(selectedTurn.trace.memoryMode)} />
              <DetailRow label="Web mode" value={humanizeToken(selectedTurn.trace.webMode)} />
              <DetailRow label="Prompt estimate" value={selectedTurn.trace.routing?.promptContextBudget ? `${selectedTurn.trace.routing.promptContextBudget.tokenEstimates.total.toLocaleString()} tokens (estimated)` : "Not recorded"} />
              <DetailRow label="Guidance files" value={selectedTurn.trace.guidance ? `${selectedTurn.trace.guidance.globalFilesUsed.length} global, ${selectedTurn.trace.guidance.workspaceFilesUsed.length} workspace${selectedTurn.trace.guidance.truncated ? " (truncated)" : ""}` : "Not recorded"} />
              <DetailRow label="Routed snapshot" value={routedContext ? `${routedContext.snapshotHash.slice(0, 12)}…` : "Not recorded"} /></dl>
            {verifiedRoutedContext ? <div className="rounded-md border border-line bg-raised p-3" aria-label="Verified routed context">
              <p className="text-fg-secondary">Scoped source inspection: {verifiedRoutedContext.includedCount} included, {verifiedRoutedContext.truncatedCount} truncated, {verifiedRoutedContext.omittedCount} omitted.</p>
              <p className="text-fg-secondary">Attached context estimate: {verifiedRoutedContext.budget.usedTokens.toLocaleString()} of {verifiedRoutedContext.budget.effectiveBudgetTokens.toLocaleString()} tokens.</p>
              {verifiedRoutedContext.entries.length ? <ul className="mt-2 space-y-1">{verifiedRoutedContext.entries.map((entry) => <li key={`${entry.index}:${entry.sourceHash}`} className="text-fg-secondary">{entry.label} · {humanizeToken(entry.disposition)}</li>)}</ul> : null}
            </div> : routedContext ? <p className="text-fg-muted">A routed snapshot was recorded. Scoped source details are unavailable for this selection.</p> : null}
          </> : <p className="text-fg-muted">Select a conversation turn to inspect its recorded context.</p>}
        </section>
        <section aria-label="Current context selection" className="space-y-2 border-t border-line-subtle pt-3">
          <h3 className="font-medium text-fg">Current selection for the next turn</h3>
          {currentContextMatchesSession ? <>
            <dl><DetailRow label="Memory mode" value={dock?.prefs?.memoryMode ? humanizeToken(dock.prefs.memoryMode) : "Not available"} />
              <DetailRow label="Selected turns" value={String(active.selectedContextTurnIds.length)} />
              <DetailRow label="Included documents" value={String(dock?.documents?.includedRefs.length ?? 0)} /></dl>
            {active.outboundContext ? <section className="rounded-md border border-line bg-raised p-3"><h4 className="font-medium text-fg">{active.outboundContext.label}</h4><p className="mt-1 whitespace-pre-wrap text-fg-secondary">{active.outboundContext.content}</p></section> : null}
            {dock?.documents?.includedRefs.length ? <ul className="space-y-1">{dock.documents.includedRefs.map((ref) => <li key={`${ref.kind}:${ref.ref}`} className="rounded-md border border-line bg-raised p-2 text-fg-secondary">{ref.label ?? humanizeToken(ref.kind)}</li>)}</ul> : null}
          </> : <p className="text-fg-muted">Current settings are unavailable until this session is selected.</p>}
        </section>
      </div> : null}

      {tab === "files" ? dock ? <div className="cockpit-chat-documents space-y-3">
        {selectedArtifact ? <section aria-label="Selected artifact" className="rounded-md border border-line bg-raised p-3">
          {dock.onCloseGeneratedArtifact ? <div className="mb-2 flex justify-end"><button type="button" className="text-xs font-medium text-accent hover:underline" onClick={dock.onCloseGeneratedArtifact}>Close artifact</button></div> : null}
          <GeneratedArtifactViewer artifact={selectedArtifact} compact />
        </section> : null}
        <div className="mc-next-context-drawer" data-mode="chat">
          <ThreadedContextConflictNotices props={dock} />
          <ThreadedDocumentsPanel props={dock} />
        </div></div>
        : <p className="text-sm text-fg-muted">Documents are unavailable for this conversation.</p> : null}

      {tab === "thread" ? <div className="space-y-3 text-sm"><dl>
        <DetailRow label="Project" value={dock?.selectedProject?.name ?? "No project"} />
        <DetailRow label="Personality" value={active.activePersonality?.name ?? "Default"} />
        <DetailRow label="Provider" value={active.selectedProviderId ?? "Not selected"} />
        <DetailRow label="Model" value={active.selectedModel ?? "Not selected"} />
        <DetailRow label="Planning" value={dock?.prefs ? humanizeToken(dock.prefs.planningMode) : "Not available"} />
        <DetailRow label="Tool autonomy" value={dock?.effectiveToolAutonomy ? humanizeToken(dock.effectiveToolAutonomy) : "Not available"} />
        <DetailRow label="Web" value={dock?.prefs ? humanizeToken(dock.prefs.webMode) : "Not available"} />
      </dl><p className="text-fg-muted">Use the model and effort controls under the composer to change the next turn.</p></div> : null}
      {tab === "background" ? <ChatBackgroundTasks input={input} turnId={selectedTurn?.turnId} /> : null}
    </section>
  </div>;
}
