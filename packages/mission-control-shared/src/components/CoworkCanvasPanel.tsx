import type { CoworkAgenticControlItem, CoworkRunViewModel, CoworkViewItem } from "./cowork-view-model";
import { AgenticRuntimeVisibilityPanel } from "./AgenticRuntimeVisibilityPanel";

function renderSectionList(label: string, items: { items: CoworkViewItem[]; overflow: number }, emptyCopy: string) {
  return (
    <div className="chat-cowork-progress-group">
      <p className="chat-cowork-subsection-label">{label}</p>
      {items.items.length > 0 ? (
        <>
          <ul className="chat-cowork-plan-list">
            {items.items.map((item) => (
              <li key={item.id}>
                <div className="chat-cowork-step-head">
                  <strong>{item.title}</strong>
                  {item.status ? <span>{item.status}</span> : null}
                </div>
                {item.meta ? <p className="chat-cowork-step-meta">{item.meta}</p> : null}
                {item.note ? <p>{item.note}</p> : null}
              </li>
            ))}
          </ul>
          {items.overflow > 0 ? <p className="chat-cowork-overflow-note">+{items.overflow} more</p> : null}
        </>
      ) : (
        <p className="chat-cowork-section-copy">{emptyCopy}</p>
      )}
    </div>
  );
}

export function CoworkCanvasPanel({
  viewModel,
  onRetryTurn,
  onStopTurn,
  onOpenTasks,
  onOpenDetails,
  onFocusComposer,
  onRefreshRunState,
  onAgenticControl,
  agenticControlPending,
  agenticControlStatus,
}: {
  viewModel: CoworkRunViewModel;
  onRetryTurn?: () => void;
  onStopTurn?: () => void;
  onOpenTasks?: () => void;
  onOpenDetails?: () => void;
  onFocusComposer?: () => void;
  onRefreshRunState?: () => void;
  onAgenticControl?: (control: CoworkAgenticControlItem) => void;
  agenticControlPending?: string | null;
  agenticControlStatus?: string | null;
}) {
  const primaryActionHandler =
    viewModel.nextAction?.kind === "retry_turn"
      ? onRetryTurn
      : viewModel.nextAction?.kind === "refresh_run_state"
        ? onRefreshRunState
        : viewModel.nextAction?.kind === "open_tasks"
          ? onOpenTasks
          : viewModel.nextAction?.kind === "focus_composer"
            ? onFocusComposer
            : onOpenDetails;

  return (
    <section
      className={`chat-cowork-panel chat-workspace-panel mission-dock-panel${viewModel.empty ? " is-empty" : ""}`}
    >
      <header className="chat-cowork-board-head">
        <div className="chat-cowork-board-copy">
          <h4>{viewModel.headerTitle}</h4>
          <p>{viewModel.headerSummary}</p>
          {viewModel.selectionLabel ? <p className="chat-cowork-board-note">{viewModel.selectionLabel}</p> : null}
        </div>
        <div className="chat-cowork-toolbar">
          {onOpenDetails ? (
            <button type="button" className="gc-button" onClick={onOpenDetails}>
              Run details
            </button>
          ) : null}
          {onStopTurn ? (
            <button type="button" className="gc-button" onClick={onStopTurn}>
              Stop run
            </button>
          ) : null}
        </div>
      </header>

      <div className="chat-cowork-source-row" aria-label="Cowork run source and freshness">
        <span>{viewModel.sourceLabel}</span>
        <span>{viewModel.freshnessLabel}</span>
        <span>{viewModel.completenessLabel}</span>
      </div>

      <div className="chat-cowork-posture-row" aria-label="Cowork run summary">
        <div className="chat-cowork-stage-strip">
          {viewModel.stageCards.map((item) => (
            <div key={`${item.label}-${item.value}`} className="chat-cowork-stage-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-cowork-execution-grid">
        <div className="chat-cowork-execution-main">
          <section className="chat-cowork-section chat-cowork-section-primary chat-cowork-section-callout">
            <p className="chat-cowork-section-label">{viewModel.now.label}</p>
            <div className="chat-cowork-callout">
              <strong className="chat-cowork-callout-title">{viewModel.now.title}</strong>
              <p className="chat-cowork-section-copy">{viewModel.now.summary}</p>
              {viewModel.now.facts.length > 0 ? (
                <dl className="chat-cowork-fact-list">
                  {viewModel.now.facts.map((fact) => (
                    <div key={`${fact.label}-${fact.value}`}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </section>

          {viewModel.nextAction ? (
            <section className="chat-cowork-section chat-cowork-section-primary chat-cowork-next-action">
              <p className="chat-cowork-section-label">Next operator action</p>
              <div className="chat-cowork-callout">
                <strong className="chat-cowork-callout-title">{viewModel.nextAction.label}</strong>
                <p className="chat-cowork-section-copy">{viewModel.nextAction.note}</p>
                <div className="chat-cowork-toolbar">
                  {primaryActionHandler ? (
                    <button type="button" className="gc-button" onClick={primaryActionHandler}>
                      {viewModel.nextAction.label}
                    </button>
                  ) : null}
                  {onOpenDetails && viewModel.nextAction.kind !== "review_run_details" ? (
                    <button type="button" className="gc-button" onClick={onOpenDetails}>
                      Open details
                    </button>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <section className="chat-cowork-section chat-cowork-section-primary">
            <p className="chat-cowork-section-label">Progress</p>
            <div className="chat-cowork-progress-grid">
              {renderSectionList("Plan", viewModel.planItems, "Cowork has not attached a visible plan yet.")}
              {renderSectionList(
                "Roles / steps",
                viewModel.roleItems,
                "Role activity will land here when the run fans out.",
              )}
            </div>
          </section>

          {viewModel.blockers.length > 0 ? (
            <section className="chat-cowork-section chat-cowork-section-primary">
              <p className="chat-cowork-section-label">Blockers</p>
              <ul className="chat-cowork-orchestration-steps">
                {viewModel.blockers.map((blocker) => (
                  <li key={blocker.id} className="chat-cowork-blocker">
                    <div className="chat-cowork-step-head">
                      <strong>{blocker.title}</strong>
                      {onOpenDetails ? (
                        <button type="button" className="gc-button" onClick={onOpenDetails}>
                          Details
                        </button>
                      ) : null}
                    </div>
                    <p>{blocker.summary}</p>
                    {blocker.raw ? (
                      <details className="chat-cowork-raw-details">
                        <summary>Raw details</summary>
                        <p>{blocker.raw}</p>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="chat-cowork-execution-side">
          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Recent timeline</p>
            {viewModel.timelineItems.items.length > 0 ? (
              <>
                <ul className="chat-cowork-orchestration-steps">
                  {viewModel.timelineItems.items.map((item) => (
                    <li key={item.id}>
                      <div className="chat-cowork-step-head">
                        <strong>{item.title}</strong>
                        {item.status ? <span>{item.status}</span> : null}
                      </div>
                      {item.meta ? <p className="chat-cowork-step-meta">{item.meta}</p> : null}
                      {item.note ? <p>{item.note}</p> : null}
                    </li>
                  ))}
                </ul>
                {viewModel.timelineItems.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">
                    +{viewModel.timelineItems.overflow} earlier timeline item(s)
                  </p>
                ) : null}
              </>
            ) : (
              <p className="chat-cowork-section-copy">
                Recent checkpoints will appear here once the run starts moving.
              </p>
            )}
          </section>

          {viewModel.agenticRuntime ? (
            <section className="chat-cowork-section">
              <p className="chat-cowork-section-label">Agentic runtime</p>
              <div className="chat-cowork-step-head">
                <strong>{viewModel.agenticRuntime.nodeCount} nodes</strong>
                <span>{viewModel.agenticRuntime.edgeCount} links</span>
              </div>
              <p className="chat-cowork-step-meta">Run {viewModel.agenticRuntime.runId}</p>
              {viewModel.agenticRuntime.treeNodes.length > 0 ? (
                <ul className="chat-cowork-plan-list">
                  {viewModel.agenticRuntime.treeNodes.slice(0, 4).map((node) => (
                    <li key={node.id}>
                      <div className="chat-cowork-step-head">
                        <strong>{node.label}</strong>
                        <span>{node.status}</span>
                      </div>
                      {node.meta ? <p className="chat-cowork-step-meta">{node.meta}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {viewModel.agenticRuntime.diagnostics.length > 0 ? (
                <>
                  <p className="chat-cowork-subsection-label">Diagnostics</p>
                  <ul className="chat-cowork-orchestration-steps">
                    {viewModel.agenticRuntime.diagnostics.map((diagnostic) => (
                      <li key={diagnostic.id}>
                        <div className="chat-cowork-step-head">
                          <strong>{diagnostic.title}</strong>
                          {diagnostic.status ? <span>{diagnostic.status}</span> : null}
                        </div>
                        {diagnostic.note ? <p>{diagnostic.note}</p> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {viewModel.agenticRuntime.controls.length > 0 ? (
                <>
                  <p className="chat-cowork-subsection-label">Controls</p>
                  {agenticControlStatus ? <p className="chat-cowork-step-meta">{agenticControlStatus}</p> : null}
                  <ul className="chat-cowork-orchestration-steps">
                    {viewModel.agenticRuntime.controls.map((control) => (
                      <li key={control.id}>
                        <div className="chat-cowork-step-head">
                          <strong>{control.title}</strong>
                          {control.status ? <span>{control.status}</span> : null}
                        </div>
                        <p>{[control.meta, control.note].filter(Boolean).join(" · ") || "No control note."}</p>
                        {onAgenticControl ? (
                          <button
                            type="button"
                            className="gc-button"
                            disabled={!control.enabled || agenticControlPending === control.action}
                            onClick={() => onAgenticControl(control)}
                          >
                            {agenticControlPending === control.action ? "Recording..." : control.title}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}

          <AgenticRuntimeVisibilityPanel surface="cowork" className="chat-cowork-section" />

          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Operator actions</p>
            {viewModel.operatorActionItems.items.length > 0 ? (
              <>
                <ul>
                  {viewModel.operatorActionItems.items.map((item) => (
                    <li key={item.id} className="chat-cowork-queue-item">
                      <strong className="chat-cowork-queue-title">{item.title}</strong>
                      {item.note ? <p className="chat-cowork-queue-note">{item.note}</p> : null}
                    </li>
                  ))}
                </ul>
                {viewModel.operatorActionItems.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">
                    +{viewModel.operatorActionItems.overflow} more operator action(s)
                  </p>
                ) : null}
              </>
            ) : (
              <p className="chat-cowork-section-copy">
                Operator actions will collect here when Cowork needs follow-up work.
              </p>
            )}
          </section>

          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Outputs / tasks</p>
            {viewModel.outputItems.items.length > 0 ? (
              <>
                <ul>
                  {viewModel.outputItems.items.map((item) => (
                    <li key={item.id}>
                      <strong>{item.title}</strong>
                      {item.note ? <p>{item.note}</p> : null}
                    </li>
                  ))}
                </ul>
                {viewModel.outputItems.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">+{viewModel.outputItems.overflow} more output item(s)</p>
                ) : null}
              </>
            ) : (
              <p className="chat-cowork-section-copy">
                Outputs and attached tasks will appear here as the run produces them.
              </p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
