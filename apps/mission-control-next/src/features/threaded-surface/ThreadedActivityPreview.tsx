import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { StatusChip } from "../native-routes/primitives";
import { shortId } from "./workflow/format";
import { formatUtilitySnippet } from "./threaded-surface-model";
import { ActivitySessionActions, UtilityChangePlanHistory } from "./ThreadedActivityHistory";
import type { ThreadedUtilityPanelId } from "./threaded-utility-navigation";

export function UtilityPreviewPanel({
  onSelectPanel,
  activeProps,
  changePlans,
  onOpenBuildEditor,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  onSelectPanel: (panel: ThreadedUtilityPanelId) => void;
  changePlans?: readonly ChangePlanRecord[];
  onOpenBuildEditor?: () => void;
}) {
  const selectedTurn = activeProps.selectedTurn;
  const assistantPreview = formatUtilitySnippet(selectedTurn?.assistantMessage?.content);
  const userPreview = formatUtilitySnippet(selectedTurn?.userMessage?.content);
  const toolRuns = selectedTurn?.toolRuns ?? [];
  const citations = selectedTurn?.citations ?? [];
  const generatedArtifacts = selectedTurn?.generatedArtifacts ?? [];
  const threadTurnCount = activeProps.thread?.turns.length ?? 0;
  const sessionLabel = activeProps.selectedSessionId ? shortId(activeProps.selectedSessionId) : "New chat";

  if (activeProps.activeGeneratedArtifact) {
    return (
      <section className="mc-next-utility-card mc-next-work-record-card">
        <div className="mc-next-work-record-section-head">
          <div>
            <p className="mc-next-panel-kicker">Artifact preview</p>
            <h4>{activeProps.activeGeneratedArtifact.title}</h4>
          </div>
          {activeProps.onCloseGeneratedArtifact ? (
            <button type="button" className="mc-next-panel-button" onClick={activeProps.onCloseGeneratedArtifact}>
              Close
            </button>
          ) : null}
        </div>
        <GeneratedArtifactViewer artifact={activeProps.activeGeneratedArtifact} compact />
        <UtilityChangePlanHistory changePlans={changePlans ?? []} />
        <div className="mc-next-work-record-actions">
          <ActivitySessionActions activeProps={activeProps} onOpenBuildEditor={onOpenBuildEditor} />
        </div>
      </section>
    );
  }

  return (
    <section className="mc-next-utility-card mc-next-work-record-card">
      <h4 className="mc-next-chat-record-title">Work Record</h4>
      <details className="mc-next-chat-evidence">
        <summary>Session summary</summary>
        <div className="mc-next-work-record-metrics" aria-label="Thread record summary">
          <div>
            <span>Session</span>
            <strong>{sessionLabel}</strong>
          </div>
          <div>
            <span>Turns</span>
            <strong>{threadTurnCount}</strong>
          </div>
          <div>
            <span>Approvals</span>
            <strong>{activeProps.approvalsCount}</strong>
          </div>
        </div>
      </details>
      {selectedTurn ? (
        <>
          <details className="mc-next-chat-evidence">
            <summary>Selected turn · {selectedTurn.trace.status}</summary>
            <div className="mc-next-work-record-section">
              <div className="mc-next-work-record-section-head">
                <div>
                  <p className="mc-next-panel-kicker">Selected turn</p>
                  <h5>{shortId(selectedTurn.turnId)}</h5>
                </div>
                <StatusChip tone={selectedTurn.trace.status === "completed" ? "success" : "muted"}>
                  {selectedTurn.trace.status}
                </StatusChip>
              </div>
              <p className="mc-next-work-record-snippet">
                <strong>User:</strong> {userPreview}
              </p>
              <p className="mc-next-work-record-snippet">
                <strong>Assistant:</strong> {assistantPreview}
              </p>
            </div>
          </details>
          <details className="mc-next-chat-evidence">
            <summary>Artifacts and citations · {generatedArtifacts.length + citations.length}</summary>
            <div className="mc-next-work-record-section">
              <div className="mc-next-work-record-section-head">
                <h5>Artifacts and citations</h5>
                <div className="mc-next-utility-chip-row">
                  <StatusChip tone={generatedArtifacts.length > 0 ? "success" : "muted"}>
                    {generatedArtifacts.length} artifact{generatedArtifacts.length === 1 ? "" : "s"}
                  </StatusChip>
                  <StatusChip tone={citations.length > 0 ? "success" : "muted"}>
                    {citations.length} citation{citations.length === 1 ? "" : "s"}
                  </StatusChip>
                </div>
              </div>
              {generatedArtifacts.length > 0 ? (
                <ul className="mc-next-work-record-list">
                  {generatedArtifacts.map((artifact) => (
                    <li key={artifact.artifactId}>
                      <button
                        type="button"
                        className="mc-next-panel-link"
                        onClick={() => activeProps.onOpenGeneratedArtifact(selectedTurn.turnId, artifact.artifactId)}
                      >
                        {artifact.title}
                      </button>
                      <strong>{artifact.kind}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No generated artifacts are attached to this turn.</p>
              )}
              {citations.length > 0 ? (
                <ul className="mc-next-work-record-list">
                  {citations.map((citation) => (
                    <li key={citation.citationId}>
                      {/^https?:\/\//i.test(citation.url) ? (
                        <a href={citation.url} target="_blank" rel="noreferrer">
                          {citation.title ?? citation.url}
                        </a>
                      ) : (
                        <span>{citation.title ?? citation.url}</span>
                      )}
                      <strong>{citation.sourceType ?? "source"}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </details>
          <div className="mc-next-work-record-section">
            <div className="mc-next-work-record-section-head">
              <h5>Recent tool events</h5>
              <StatusChip tone={toolRuns.length > 0 ? "warning" : "muted"}>
                {toolRuns.length} event{toolRuns.length === 1 ? "" : "s"}
              </StatusChip>
            </div>
            {toolRuns.length > 0 ? (
              <ul className="mc-next-work-record-list">
                {toolRuns.map((toolRun) => (
                  <li key={toolRun.toolRunId}>
                    <span>{toolRun.toolName}</span>
                    <strong>{toolRun.status}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No tool events are recorded on the selected turn.</p>
            )}
          </div>
        </>
      ) : (
        <p>Select a turn or open a generated artifact to preview the thread record here.</p>
      )}
      <UtilityChangePlanHistory changePlans={changePlans ?? []} />
      <div className="mc-next-work-record-actions">
        {selectedTurn ? (
          <>
            <button
              type="button"
              className="mc-next-panel-button"
              disabled={generatedArtifacts.length === 0}
              onClick={() => activeProps.onOpenGeneratedArtifact(selectedTurn.turnId)}
            >
              Open artifact
            </button>
            <button type="button" className="mc-next-panel-button" onClick={() => onSelectPanel("trace")}>
              Trace turn
            </button>
          </>
        ) : null}
        {activeProps.onExportRunBundle ? (
          <button type="button" className="mc-next-panel-button" onClick={activeProps.onExportRunBundle}>
            Export proof
          </button>
        ) : null}
        <ActivitySessionActions activeProps={activeProps} onOpenBuildEditor={onOpenBuildEditor} />
        <button type="button" className="mc-next-panel-link" onClick={activeProps.onOpenLibraryArtifacts}>
          Library
        </button>
        <button type="button" className="mc-next-panel-link" onClick={activeProps.onOpenOpsRuntime}>
          Ops
        </button>
      </div>
    </section>
  );
}
