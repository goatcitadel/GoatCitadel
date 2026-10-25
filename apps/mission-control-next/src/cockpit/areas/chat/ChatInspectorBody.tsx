import { ChatConversationSettings } from "./ChatConversationSettings";
import {
  DetailRow,
  SourcesPanel,
  renderInspectorRunEvidence,
  ModelDetailRow,
  ModelTechnicalDetails,
  TABS,
  type ChatInspectorTab,
} from "./chat-inspector-evidence";
import { useEffect, useState } from "react";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import {
  presentMemoryMode,
  presentPlanningMode,
  presentRoutedContextKind,
  presentRoutedDisposition,
  presentToolAutonomy,
  presentWebMode,
} from "./chat-vocabulary";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { ThreadedDocumentsPanel } from "../../../features/threaded-surface/ThreadedDocumentsPanel";
import { ThreadedContextConflictNotices } from "../../../features/threaded-surface/ThreadedContextConflictNotices";
import { ChatBackgroundTasks } from "./ChatBackgroundTasks";
import { SessionControlManager } from "./SessionControlManager";
import { ChatInspectorTurnPanel } from "./ChatInspectorTurnPanel";
import { ChatTurnApprovalHistory } from "./ChatTurnApprovalHistory";
import { ChatOrganizationForm } from "./ChatOrganizationForm";

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
        className="flex gap-1 overflow-x-auto whitespace-nowrap rounded-md bg-sunken p-1"
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
            className="min-h-8 shrink-0 rounded-md px-2 text-xs font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <section
        id={`cockpit-inspector-${tab}`}
        aria-labelledby={`cockpit-inspector-tab-${tab}`}
        role="tabpanel"
        className="min-w-0"
      >
        {tab === "run" ? (
          <>
            {renderInspectorRunEvidence(run, selectedTurn)}
            <ChatTurnApprovalHistory turn={selectedTurn} />
          </>
        ) : null}

        {tab === "turn" ? <ChatInspectorTurnPanel selectedTurn={selectedTurn} /> : null}

        {tab === "sources" ? <SourcesPanel turn={selectedTurn} /> : null}

        {tab === "context" ? (
          <div className="space-y-4 text-sm">
            <section aria-label="Recorded message context" className="space-y-2">
              <h3 className="font-medium text-fg">Recorded for this message</h3>
              {selectedTurn ? (
                <>
                  <dl>
                    <DetailRow label="Memory mode" value={presentMemoryMode(selectedTurn.trace.memoryMode)} />
                    <DetailRow label="Web mode" value={presentWebMode(selectedTurn.trace.webMode)} />
                    <DetailRow
                      label="Estimated prompt size"
                      value={
                        selectedTurn.trace.routing?.promptContextBudget
                          ? `${plural(selectedTurn.trace.routing.promptContextBudget.tokenEstimates.total, "token")} (estimated)`
                          : "Not recorded"
                      }
                    />
                    <DetailRow
                      label="Instruction files"
                      value={
                        selectedTurn.trace.guidance
                          ? `${selectedTurn.trace.guidance.globalFilesUsed.length} global, ${selectedTurn.trace.guidance.workspaceFilesUsed.length} workspace${selectedTurn.trace.guidance.truncated ? " (truncated)" : ""}`
                          : "Not recorded"
                      }
                    />
                    <DetailRow label="Routed context" value={routedContext ? "Recorded" : "Not recorded"} />
                  </dl>
                  {routedContext ? (
                    <TechnicalDetails label="Routed context details">
                      <p className="font-mono text-xs wrap-anywhere">Snapshot hash: {routedContext.snapshotHash}</p>
                    </TechnicalDetails>
                  ) : null}
                  {verifiedRoutedContext ? (
                    <div role="group" className="border-t border-line-subtle pt-2" aria-label="Verified routed context">
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
                              {entry.label} · {presentRoutedDisposition(entry.disposition)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : routedContext ? (
                    <p className="text-fg-muted">
                      A routed context was recorded. Scoped source details are unavailable for this selection.
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
                      value={dock?.prefs?.memoryMode ? presentMemoryMode(dock.prefs.memoryMode) : "Not available"}
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
                    <ul className="divide-y divide-line-subtle">
                      {dock.documents.includedRefs.map((ref) => (
                        <li key={`${ref.kind}:${ref.ref}`} className="py-2 text-fg-secondary">
                          {ref.label ?? presentRoutedContextKind(ref.kind)}
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
              <ModelDetailRow
                providerId={active.selectedProviderId}
                modelId={active.selectedModel}
                missing="Not selected"
              />
              <DetailRow
                label="Planning"
                value={dock?.prefs ? presentPlanningMode(dock.prefs.planningMode) : "Not available"}
              />
              <DetailRow
                label="Tool autonomy"
                value={
                  // The saved setting, like Planning and Web; the last message's own value stays in its run detail.
                  dock?.prefs
                    ? presentToolAutonomy(dock.prefs.planningMode === "advisory" ? "manual" : dock.prefs.toolAutonomy)
                    : "Not available"
                }
              />
              <DetailRow label="Web" value={dock?.prefs ? presentWebMode(dock.prefs.webMode) : "Not available"} />
            </dl>
            <ModelTechnicalDetails providerId={active.selectedProviderId} modelId={active.selectedModel} />
            {dock ? <ChatOrganizationForm key={dock.selectedSessionId} dock={dock} /> : null}
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
