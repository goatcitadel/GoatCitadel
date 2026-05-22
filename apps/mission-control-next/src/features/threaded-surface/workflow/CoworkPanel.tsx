import { useState } from "react";
import type { MissionThreadedWorkflowPanel } from "@goatcitadel/threaded-surface-core";
import { AgenticRuntimeVisibilityPanel } from "@goatcitadel/mission-control-shared/components/AgenticRuntimeVisibilityPanel";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { describeAgenticControlCopy } from "./format";
import { PanelList } from "./PanelList";

type CoworkPanelType = Extract<MissionThreadedWorkflowPanel, { kind: "cowork" }>;

export function NextCoworkPanel({ panel }: { panel: CoworkPanelType }) {
  const {
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
  } = panel.props;
  const [activeTab, setActiveTab] = useState<"plan" | "run-map" | "timeline" | "actions">("plan");
  const [stopRunConfirmOpen, setStopRunConfirmOpen] = useState(false);
  const activeTrace = viewModel.raw.selectedTurn?.trace ?? viewModel.raw.activeTurn?.trace ?? null;
  const pendingApproval = activeTrace?.pendingApprovalSummary;
  const requestedModel =
    activeTrace?.routing.primaryModel ?? activeTrace?.routing.fallbackModel ?? activeTrace?.model ?? "not requested";
  const effectiveModel = activeTrace?.routing.effectiveModel ?? activeTrace?.model ?? "not resolved";
  const activeAgentSummary = viewModel.agenticRuntime
    ? `${viewModel.agenticRuntime.nodeCount} runtime nodes`
    : `${viewModel.roleItems.items.length}${viewModel.roleItems.overflow ? "+" : ""} visible roles`;

  return (
    <section className={`mc-next-cowork-panel${viewModel.empty ? " is-empty" : ""}`}>
      <header className="mc-next-cowork-head">
        <div>
          <p className="mc-next-panel-kicker">Cowork</p>
          <h4>{viewModel.headerTitle}</h4>
          <p>{viewModel.headerSummary}</p>
        </div>
        <div className="mc-next-cowork-toolbar">
          {onOpenDetails ? (
            <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
              Run details
            </button>
          ) : null}
          {onStopTurn ? (
            <button type="button" className="mc-next-panel-button" onClick={() => setStopRunConfirmOpen(true)}>
              Stop run
            </button>
          ) : null}
        </div>
      </header>

      <ConfirmModal
        open={stopRunConfirmOpen}
        title="Stop the active Cowork run?"
        message="In-flight steps will be cancelled. Durable execution retains completed evidence, so you can review what landed before deciding whether to retry or pivot."
        confirmLabel="Stop run"
        danger
        onCancel={() => setStopRunConfirmOpen(false)}
        onConfirm={() => {
          setStopRunConfirmOpen(false);
          onStopTurn?.();
        }}
      />

      <div className="mc-next-cowork-stage-strip">
        {viewModel.stageCards.map((item) => (
          <div key={`${item.label}-${item.value}`} className="mc-next-cowork-stage-card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <section className="mc-next-cowork-mission-brief" aria-label="Cowork mission brief">
        <div>
          <p className="mc-next-panel-kicker">Mission brief</p>
          <h5>{viewModel.runMap.objective || viewModel.headerTitle}</h5>
          <p>{viewModel.runMap.currentState || viewModel.now.summary}</p>
        </div>
        <dl>
          <div>
            <dt>Phase</dt>
            <dd>{viewModel.now.title}</dd>
          </div>
          <div>
            <dt>Active agents</dt>
            <dd>{activeAgentSummary}</dd>
          </div>
          <div>
            <dt>Blockers</dt>
            <dd>{viewModel.blockers.length || "None"}</dd>
          </div>
          <div>
            <dt>Approvals</dt>
            <dd>
              {pendingApproval ? (pendingApproval.description ?? pendingApproval.kind ?? "Pending") : "None pending"}
            </dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{viewModel.evidenceSummary.detail}</dd>
          </div>
          <div>
            <dt>Requested model</dt>
            <dd>{requestedModel}</dd>
          </div>
          <div>
            <dt>Effective model</dt>
            <dd>{effectiveModel}</dd>
          </div>
          <div>
            <dt>Next action</dt>
            <dd>{viewModel.nextAction?.label ?? viewModel.runMap.nextAction}</dd>
          </div>
        </dl>
      </section>

      <section className="mc-next-cowork-now">
        <p className="mc-next-panel-kicker">{viewModel.now.label}</p>
        <h5>{viewModel.now.title}</h5>
        <p>{viewModel.now.summary}</p>
        {viewModel.now.facts.length > 0 ? (
          <dl className="mc-next-cowork-facts">
            {viewModel.now.facts.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      {viewModel.nextAction ? (
        <section className="mc-next-cowork-action-callout">
          <p className="mc-next-panel-kicker">Next operator action</p>
          <h5>{viewModel.nextAction.label}</h5>
          <p>{viewModel.nextAction.note}</p>
          <div className="mc-next-cowork-toolbar">
            {viewModel.nextAction.kind === "retry_turn" && onRetryTurn ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onRetryTurn}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "refresh_run_state" && onRefreshRunState ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onRefreshRunState}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "open_tasks" && onOpenTasks ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onOpenTasks}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {viewModel.nextAction.kind === "focus_composer" && onFocusComposer ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onFocusComposer}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
            {!["retry_turn", "refresh_run_state", "open_tasks", "focus_composer"].includes(viewModel.nextAction.kind) &&
            onOpenDetails ? (
              <button type="button" className="mc-next-panel-button primary" onClick={onOpenDetails}>
                {viewModel.nextAction.label}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="mc-next-panel-tab-row">
        {["plan", "run-map", "timeline", "actions"].map((tab) => (
          <button
            key={tab}
            type="button"
            className={`mc-next-panel-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab as typeof activeTab)}
          >
            {tab === "plan"
              ? "Plan"
              : tab === "run-map"
                ? "Run Map"
                : tab === "timeline"
                  ? "Timeline"
                  : "Operator actions"}
          </button>
        ))}
      </div>

      {activeTab === "plan" ? (
        <div className="mc-next-cowork-grid">
          <PanelList
            title="Plan"
            items={viewModel.planItems.items}
            emptyCopy="Cowork has not attached a visible plan yet."
          />
          <PanelList
            title="Roles / steps"
            items={viewModel.roleItems.items}
            emptyCopy="Role activity will land here when the run fans out."
          />
          <PanelList
            title="Outputs / tasks"
            items={viewModel.outputItems.items}
            emptyCopy="Outputs and attached tasks will appear here as the run produces them."
          />
        </div>
      ) : null}

      {activeTab === "run-map" ? <RunMapPanel viewModel={viewModel} onOpenDetails={onOpenDetails} /> : null}

      {activeTab === "timeline" ? (
        <PanelList
          title="Recent timeline"
          items={viewModel.timelineItems.items}
          emptyCopy="Recent checkpoints will appear here once the run starts moving."
        />
      ) : null}

      {activeTab === "actions" ? (
        <PanelList
          title="Operator actions"
          items={viewModel.operatorActionItems.items}
          emptyCopy="Operator actions will collect here when Cowork needs follow-up work."
        />
      ) : null}

      {viewModel.blockers.length > 0 ? (
        <section className="mc-next-cowork-blockers">
          <p className="mc-next-panel-kicker">Blockers</p>
          {viewModel.blockers.map((blocker) => (
            <article key={blocker.id} className="mc-next-cowork-blocker">
              <div className="mc-next-cowork-blocker-head">
                <strong>{blocker.title}</strong>
                {onOpenDetails ? (
                  <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
                    Details
                  </button>
                ) : null}
              </div>
              <p>{blocker.summary}</p>
            </article>
          ))}
        </section>
      ) : null}

      {viewModel.agenticRuntime ? (
        <AgenticRuntimePanel
          viewModel={viewModel}
          onAgenticControl={onAgenticControl}
          agenticControlPending={agenticControlPending}
          agenticControlStatus={agenticControlStatus}
        />
      ) : null}
    </section>
  );
}

function RunMapPanel({
  viewModel,
  onOpenDetails,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  onOpenDetails?: () => void;
}) {
  const gate = viewModel.continuationGate;
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Run map</p>
          <h5>{viewModel.runMap.objective}</h5>
          <p>{viewModel.runMap.currentState}</p>
        </div>
        <StatusChip
          tone={gate.decision === "continue" ? "success" : gate.decision === "checkpoint" ? "warning" : "critical"}
        >
          Gate: {gate.decision}
        </StatusChip>
      </div>

      <div className="mc-next-cowork-run-map-grid">
        <section>
          <p className="mc-next-panel-kicker">Current state</p>
          <strong>{viewModel.runMap.currentState}</strong>
          <span>{gate.summary}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Next action</p>
          <strong>{viewModel.runMap.nextAction}</strong>
          <span>{gate.recommendedAction}</span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">State gaps</p>
          <strong>{viewModel.stateGaps.length ? `${viewModel.stateGaps.length} open` : "None"}</strong>
          <span>{viewModel.stateGaps.join(" · ") || "No state gaps detected in the current view."}</span>
        </section>
      </div>

      <div className="mc-next-cowork-run-map-graph" aria-label="Cowork plan graph">
        {viewModel.runMap.planNodes.map((node, index) => (
          <div key={node.id} className="mc-next-cowork-run-map-node-wrap">
            <article className="mc-next-cowork-run-map-node">
              <span>{node.status}</span>
              <strong>{node.label}</strong>
              {node.meta ? <p>{node.meta}</p> : null}
            </article>
            {index < viewModel.runMap.planNodes.length - 1 ? <span className="mc-next-cowork-run-map-link" /> : null}
          </div>
        ))}
      </div>

      <div className="mc-next-cowork-run-map-footer">
        <section>
          <p className="mc-next-panel-kicker">{viewModel.evidenceSummary.label}</p>
          <strong>{viewModel.evidenceSummary.detail}</strong>
          <span>
            Tool calls {gate.metrics.toolRunCount} · failures {gate.metrics.failedToolRunCount} · gaps{" "}
            {gate.metrics.evidenceGapCount}
          </span>
        </section>
        <section>
          <p className="mc-next-panel-kicker">Checkpoint timeline</p>
          <strong>{viewModel.runMap.checkpoints.length} retained</strong>
          <span>{viewModel.runMap.checkpoints.map((item) => item.title).join(" -> ") || "No checkpoints yet."}</span>
        </section>
        {onOpenDetails ? (
          <button type="button" className="mc-next-panel-button" onClick={onOpenDetails}>
            Inspect evidence
          </button>
        ) : null}
      </div>
    </section>
  );
}

function AgenticRuntimePanel({
  viewModel,
  onAgenticControl,
  agenticControlPending,
  agenticControlStatus,
}: {
  viewModel: CoworkPanelType["props"]["viewModel"];
  onAgenticControl?: CoworkPanelType["props"]["onAgenticControl"];
  agenticControlPending?: string | null;
  agenticControlStatus?: string | null;
}) {
  const runtime = viewModel.agenticRuntime;
  if (!runtime) {
    return null;
  }
  return (
    <section className="mc-next-cowork-run-map">
      <div className="mc-next-cowork-run-map-head">
        <div>
          <p className="mc-next-panel-kicker">Agentic runtime</p>
          <h5>{runtime.nodeCount} runtime nodes</h5>
          <p>
            Run {runtime.runId} · {runtime.edgeCount} links · generated {runtime.generatedAt}
          </p>
        </div>
      </div>
      <div className="mc-next-cowork-run-map-grid">
        <PanelList
          title="Run tree"
          items={runtime.treeNodes.map((node) => ({
            id: node.id,
            title: node.label,
            status: node.status,
            meta: node.meta,
          }))}
          emptyCopy="No runtime tree nodes are loaded."
        />
        <PanelList title="Diagnostics" items={runtime.diagnostics} emptyCopy="No diagnostics are active." />
        <AgenticRuntimeVisibilityPanel surface="cowork" className="mc-next-panel-list" deliveryLimit={8} />
        <section className="mc-next-panel-list">
          <p className="mc-next-panel-kicker">Controls</p>
          <p>
            State-only controls record durable operator intent. They do not live-pause or terminate an executor unless a
            running executor separately honors that recorded intent.
          </p>
          {agenticControlStatus ? <p>{agenticControlStatus}</p> : null}
          {runtime.controls.length > 0 ? (
            <ul>
              {runtime.controls.map((control) => {
                const controlCopy = describeAgenticControlCopy(control);
                return (
                  <li key={control.id}>
                    <div className="mc-next-panel-list-head">
                      <strong>{control.title}</strong>
                      {control.status ? <span>{control.status}</span> : null}
                    </div>
                    {control.meta ? <p>{control.meta}</p> : null}
                    {control.note ? <p>{control.note}</p> : null}
                    {controlCopy.intentNote ? <p>{controlCopy.intentNote}</p> : null}
                    {onAgenticControl ? (
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        disabled={!control.enabled || agenticControlPending === control.action}
                        onClick={() => onAgenticControl(control)}
                      >
                        {agenticControlPending === control.action ? "Recording..." : controlCopy.buttonLabel}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No runtime controls are available.</p>
          )}
        </section>
      </div>
    </section>
  );
}
