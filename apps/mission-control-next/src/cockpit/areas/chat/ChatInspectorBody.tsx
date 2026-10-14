import { ChatConversationSettings } from "./ChatConversationSettings";
import {
  DetailRow,
  SourcesPanel,
  statusTone,
  renderInspectorRunEvidence,
  inspectorFallbackLabel,
  TABS,
  type ChatInspectorTab,
} from "./chat-inspector-evidence";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useState } from "react";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ThreadedDocumentsPanel } from "../../../features/threaded-surface/ThreadedDocumentsPanel";
import { ThreadedContextConflictNotices } from "../../../features/threaded-surface/ThreadedContextConflictNotices";
import { StatusBadge } from "../../ui/StatusBadge";
import { ChatBackgroundTasks } from "./ChatBackgroundTasks";
import { SessionControlManager } from "./SessionControlManager";
import { recordedCostLabel } from "./recorded-cost";

export function ChatInspector({
  input,
  targetTurnId,
  initialTab = "run",
}: {
  input: MissionThreadedRenderSurfaceInput;
  targetTurnId?: string | null;
  initialTab?: ChatInspectorTab;
}) {
  const [tab, setTab] = useState<ChatInspectorTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const active = input.activeSessionSurfaceProps;
  const dock = input.contextDockProps;
  if (!active) return <p className="text-sm text-fg-muted">Choose a conversation to inspect.</p>;
  const visibleTurns =
    active.thread?.turns.filter(
      (turn) =>
        turn.branch.isSelectedPath &&
        turn.trace.sessionId === dock?.selectedSessionId &&
        turn.trace.turnId === turn.turnId,
    ) ?? [];
  const selectedTurn =
    visibleTurns.find((turn) => turn.turnId === targetTurnId) ??
    visibleTurns.find((turn) => turn.turnId === active.selectedTurnId) ??
    visibleTurns.at(-1);
  const run =
    selectedTurn && active.delegationRun?.attachedTurnId === selectedTurn.turnId ? active.delegationRun : null;
  const openedArtifact = dock?.activeGeneratedArtifact;
  const selectedArtifact =
    openedArtifact &&
    openedArtifact.turnId === selectedTurn?.turnId &&
    openedArtifact.sessionId === dock?.selectedSessionId
      ? openedArtifact
      : null;
  const contextInspection =
    selectedTurn &&
    dock?.selectedTurn?.turnId === selectedTurn.turnId &&
    dock.selectedSessionId === selectedTurn.trace.sessionId &&
    (dock.capabilityProfileInspection.status === "verified" ||
      dock.capabilityProfileInspection.status === "admission_verified") &&
    dock.capabilityProfileInspection.expectedProfileId === selectedTurn.trace.capabilityProfileId &&
    dock.capabilityProfileInspection.expectedProfileHash === selectedTurn.trace.capabilityProfileHash
      ? dock.capabilityProfileInspection.routedContext
      : undefined;
  const routedContext = selectedTurn?.trace.routing?.routedContext;
  const verifiedRoutedContext =
    contextInspection?.snapshotId === routedContext?.snapshotId &&
    contextInspection?.snapshotHash === routedContext?.snapshotHash &&
    contextInspection?.sourceRequestHash === routedContext?.sourceRequestHash &&
    contextInspection?.contentHash === routedContext?.contentHash
      ? contextInspection
      : undefined;
  const currentContextMatchesSession = Boolean(
    dock?.selectedSessionId &&
    dock.selectedSessionId === active.selectedSessionId &&
    dock.selectedSessionId === input.sessionRail.selectedSessionId,
  );

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Conversation inspector"
        className="grid grid-cols-3 gap-1 rounded-md bg-sunken p-1"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            id={`cockpit-inspector-tab-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            aria-controls={`cockpit-inspector-${entry.id}`}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.id === tab);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % TABS.length
                  : event.key === "ArrowLeft"
                    ? (index + TABS.length - 1) % TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(TABS[next]!.id);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
            className="min-h-8 rounded px-2 text-xs font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <section
        id={`cockpit-inspector-${tab}`}
        aria-labelledby={`cockpit-inspector-tab-${tab}`}
        role="tabpanel"
        aria-label={TABS.find((entry) => entry.id === tab)?.label}
        className="min-w-0"
      >
        {tab === "run" ? renderInspectorRunEvidence(run, selectedTurn) : null}

        {tab === "turn" ? (
          selectedTurn ? (
            <div className="space-y-3">
              <StatusBadge
                status={{
                  label: humanizeToken(selectedTurn.trace.status),
                  tone: statusTone(selectedTurn.trace.status),
                }}
              />
              <dl>
                <DetailRow
                  label="Model"
                  value={selectedTurn.trace.routing?.effectiveModel ?? selectedTurn.trace.model ?? "Not recorded"}
                />
                <DetailRow label="Provider" value={selectedTurn.trace.routing?.effectiveProviderId ?? "Not recorded"} />
                <DetailRow label="Fallback" value={inspectorFallbackLabel(selectedTurn)} />
                <DetailRow label="Tools" value={String(selectedTurn.toolRuns.length)} />
                <DetailRow label="Sources" value={String(selectedTurn.citations.length)} />
                <DetailRow
                  label="Duration"
                  value={
                    selectedTurn.trace.completion?.latencyMs === undefined
                      ? "Not recorded"
                      : `${(selectedTurn.trace.completion.latencyMs / 1000).toFixed(1)} seconds`
                  }
                />
                <DetailRow
                  label="Cost"
                  value={recordedCostLabel(
                    selectedTurn.trace.completion?.usage?.costUsd,
                    selectedTurn.trace.completion?.usage?.costSource,
                  )}
                />
              </dl>
              {selectedTurn.trace.failure?.message ? (
                <p className="rounded-md border border-status-failed p-2 text-sm text-fg-secondary">
                  {selectedTurn.trace.failure.message}
                </p>
              ) : null}
              {selectedTurn.toolRuns.length ? (
                <ol className="space-y-1">
                  {selectedTurn.toolRuns.map((tool) => (
                    <li key={tool.toolRunId} className="flex justify-between gap-2 text-sm">
                      <span>{chatToolDisplayName(tool)}</span>
                      <span className="text-fg-muted">{humanizeToken(tool.status)}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {selectedTurn.trace.durable?.runId ? (
                <NativeOwnerLink
                  scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]}
                  className="text-sm font-medium text-accent hover:underline"
                  href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}
                >
                  Open durable evidence
                </NativeOwnerLink>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">No message is available yet.</p>
          )
        ) : null}

        {tab === "sources" ? <SourcesPanel turn={selectedTurn} /> : null}

        {tab === "context" ? (
          <div className="space-y-4 text-sm">
            <section aria-label="Recorded message context" className="space-y-2">
              <h3 className="font-medium text-fg">Recorded for this message</h3>
              {selectedTurn ? (
                <>
                  <dl>
                    <DetailRow label="Memory mode" value={humanizeToken(selectedTurn.trace.memoryMode)} />
                    <DetailRow label="Web mode" value={humanizeToken(selectedTurn.trace.webMode)} />
                    <DetailRow
                      label="Prompt estimate"
                      value={
                        selectedTurn.trace.routing?.promptContextBudget
                          ? `${selectedTurn.trace.routing.promptContextBudget.tokenEstimates.total.toLocaleString()} tokens (estimated)`
                          : "Not recorded"
                      }
                    />
                    <DetailRow
                      label="Guidance files"
                      value={
                        selectedTurn.trace.guidance
                          ? `${selectedTurn.trace.guidance.globalFilesUsed.length} global, ${selectedTurn.trace.guidance.workspaceFilesUsed.length} workspace${selectedTurn.trace.guidance.truncated ? " (truncated)" : ""}`
                          : "Not recorded"
                      }
                    />
                    <DetailRow
                      label="Routed snapshot"
                      value={routedContext ? `${routedContext.snapshotHash.slice(0, 12)}…` : "Not recorded"}
                    />
                  </dl>
                  {verifiedRoutedContext ? (
                    <div className="rounded-md border border-line bg-raised p-3" aria-label="Verified routed context">
                      <p className="text-fg-secondary">
                        {"Scoped source inspection: "}
                        {verifiedRoutedContext.includedCount}
                        {" included, "}
                        {verifiedRoutedContext.truncatedCount}
                        {" truncated, "}
                        {verifiedRoutedContext.omittedCount}
                        {" omitted."}
                      </p>
                      <p className="text-fg-secondary">
                        {"Attached context estimate: "}
                        {verifiedRoutedContext.budget.usedTokens.toLocaleString()}
                        {" of "}
                        {verifiedRoutedContext.budget.effectiveBudgetTokens.toLocaleString()}
                        {" tokens."}
                      </p>
                      {verifiedRoutedContext.entries.length ? (
                        <ul className="mt-2 space-y-1">
                          {verifiedRoutedContext.entries.map((entry) => (
                            <li key={`${entry.index}:${entry.sourceHash}`} className="text-fg-secondary">
                              {entry.label} · {humanizeToken(entry.disposition)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : routedContext ? (
                    <p className="text-fg-muted">
                      A routed snapshot was recorded. Scoped source details are unavailable for this selection.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-fg-muted">Select a message to inspect its recorded context.</p>
              )}
            </section>
            <section aria-label="Current context selection" className="space-y-2 border-t border-line-subtle pt-3">
              <h3 className="font-medium text-fg">Current selection for the next message</h3>
              {currentContextMatchesSession ? (
                <>
                  <dl>
                    <DetailRow
                      label="Memory mode"
                      value={dock?.prefs?.memoryMode ? humanizeToken(dock.prefs.memoryMode) : "Not available"}
                    />
                    <DetailRow label="Selected messages" value={String(active.selectedContextTurnIds.length)} />
                    <DetailRow label="Included documents" value={String(dock?.documents?.includedRefs.length ?? 0)} />
                  </dl>
                  {active.outboundContext ? (
                    <section className="rounded-md border border-line bg-raised p-3">
                      <h4 className="font-medium text-fg">{active.outboundContext.label}</h4>
                      <p className="mt-1 whitespace-pre-wrap text-fg-secondary">{active.outboundContext.content}</p>
                    </section>
                  ) : null}
                  {dock?.documents?.includedRefs.length ? (
                    <ul className="space-y-1">
                      {dock.documents.includedRefs.map((ref) => (
                        <li
                          key={`${ref.kind}:${ref.ref}`}
                          className="rounded-md border border-line bg-raised p-2 text-fg-secondary"
                        >
                          {ref.label ?? humanizeToken(ref.kind)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-fg-muted">Current settings are unavailable until this session is selected.</p>
              )}
            </section>
          </div>
        ) : null}

        {tab === "files" ? (
          dock ? (
            <div className="cockpit-chat-documents space-y-3">
              {selectedArtifact ? (
                <section aria-label="Selected artifact" className="rounded-md border border-line bg-raised p-3">
                  {dock.onCloseGeneratedArtifact ? (
                    <div className="mb-2 flex justify-end">
                      <button
                        type="button"
                        className="text-xs font-medium text-accent hover:underline"
                        onClick={dock.onCloseGeneratedArtifact}
                      >
                        Close artifact
                      </button>
                    </div>
                  ) : null}
                  <GeneratedArtifactViewer artifact={selectedArtifact} compact />
                </section>
              ) : null}
              <div className="mc-next-context-drawer" data-mode="chat">
                <ThreadedContextConflictNotices props={dock} />
                <ThreadedDocumentsPanel props={dock} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-fg-muted">Documents are unavailable for this conversation.</p>
          )
        ) : null}

        {tab === "thread" ? (
          <div className="space-y-3 text-sm">
            <dl>
              <DetailRow label="Project" value={dock?.selectedProject?.name ?? "No project"} />
              <DetailRow label="Personality" value={active.activePersonality?.name ?? "Default"} />
              <DetailRow label="Provider" value={active.selectedProviderId ?? "Not selected"} />
              <DetailRow label="Model" value={active.selectedModel ?? "Not selected"} />
              <DetailRow
                label="Planning"
                value={dock?.prefs ? humanizeToken(dock.prefs.planningMode) : "Not available"}
              />
              <DetailRow
                label="Tool autonomy"
                value={dock?.effectiveToolAutonomy ? humanizeToken(dock.effectiveToolAutonomy) : "Not available"}
              />
              <DetailRow label="Web" value={dock?.prefs ? humanizeToken(dock.prefs.webMode) : "Not available"} />
            </dl>
            {dock ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void dock.onSaveOrganization();
                }}
              >
                <label className="block">
                  Folder
                  <input
                    className="block w-full rounded-md border border-line bg-canvas p-2"
                    value={dock.folderName}
                    onChange={(event) => dock.onFolderNameChange(event.target.value)}
                  />
                </label>
                <label className="block">
                  Tags
                  <input
                    className="block w-full rounded-md border border-line bg-canvas p-2"
                    value={dock.tagsValue}
                    onChange={(event) => dock.onTagsValueChange(event.target.value)}
                    placeholder="Comma-separated tags"
                  />
                </label>
                <button
                  type="submit"
                  disabled={Boolean(dock.sessionControlPending)}
                  className="rounded-md border border-line px-3 py-2 text-accent"
                >
                  Save organization
                </button>
              </form>
            ) : null}
            <p className="text-fg-muted">
              Use the model and effort controls under the composer to change the next message.
            </p>
            {dock && currentContextMatchesSession && !active.historicalReadOnly ? (
              <ChatConversationSettings dock={dock} />
            ) : null}
            {dock?.selectedSessionId ? (
              <SessionControlManager
                key={dock.selectedSessionId}
                sessionId={dock.selectedSessionId}
                workspaceId={active.workspaceId}
              />
            ) : null}
          </div>
        ) : null}
        {tab === "background" ? <ChatBackgroundTasks input={input} turnId={selectedTurn?.turnId} /> : null}
      </section>
    </div>
  );
}
