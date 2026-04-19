import type {
  ChatExecutionPlanRecord,
  ChatOrchestrationSummary,
  OrchestrationRun,
  ChatSessionWorkbenchRecord,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import type { OrchestrationCheckpointRecord } from "../api/types";
import type { ActiveChatDelegationRun } from "../pages/chat/useChatDelegationPolicyActions";

export interface CoworkTaskItem {
  id: string;
  title: string;
  note?: string;
}

const CHECKPOINT_LABELS: Record<OrchestrationCheckpointRecord["checkpointKind"], string> = {
  run_created: "Created",
  durable_run_linked: "Durable linked",
  worktree_allocated: "Worktree allocated",
  run_queued: "Queued",
  run_started: "Started",
  run_paused_for_approval: "Paused for approval",
  run_resumed: "Resumed",
  phase_approved: "Approval recorded",
  phase_executed: "Phase executed",
  wave_advanced: "Wave advanced",
  run_completed: "Completed",
  run_stopped: "Stopped by limit",
  run_failed: "Failed",
};

function formatExecutionState(value?: OrchestrationRun["executionState"]): string {
  switch (value) {
    case "worktree_allocating":
      return "worktree allocating";
    case "worktree_ready":
      return "worktree ready";
    case "paused_for_approval":
      return "paused for approval";
    case "resume_requested":
      return "resume requested";
    case "stopped_by_limit":
      return "stopped by limit";
    default:
      return value?.replaceAll("_", " ") ?? "not linked";
  }
}

function formatApprovalState(input: {
  orchestrationRun?: OrchestrationRun | null;
  waitingForApproval: boolean;
}): string {
  if (input.orchestrationRun?.executionState === "paused_for_approval") {
    return "paused";
  }
  if (input.orchestrationRun?.executionState === "resume_requested") {
    return "resume queued";
  }
  if (input.waitingForApproval) {
    return "waiting";
  }
  return "clear";
}

export function CoworkCanvasPanel({
  items,
  orchestration,
  orchestrationRun,
  orchestrationCheckpoints,
  orchestrationLoading,
  orchestrationError,
  executionPlan,
  delegationRun,
  selectedTurn,
  workbenchState,
  onRetryTurn,
  onStopTurn,
  onOpenTasks,
}: {
  items: CoworkTaskItem[];
  orchestration?: ChatOrchestrationSummary;
  orchestrationRun?: OrchestrationRun | null;
  orchestrationCheckpoints?: OrchestrationCheckpointRecord[];
  orchestrationLoading?: boolean;
  orchestrationError?: string | null;
  executionPlan?: ChatExecutionPlanRecord;
  delegationRun?: ActiveChatDelegationRun | null;
  selectedTurn?: ChatThreadTurnRecord | null;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  onRetryTurn?: () => void;
  onStopTurn?: () => void;
  onOpenTasks?: () => void;
}) {
  const activePlanSteps = executionPlan?.steps ?? [];
  const delegationSteps = delegationRun?.steps ?? [];
  const toolRuns = selectedTurn?.toolRuns?.length ?? 0;
  const waitingForApproval = selectedTurn?.trace?.status === "waiting_for_approval";
  const executionTruthRun = orchestrationRun ?? null;
  const approvalState = formatApprovalState({ orchestrationRun: executionTruthRun, waitingForApproval });
  const checkpointTimeline = orchestrationCheckpoints ?? [];
  const planState = executionTruthRun?.status ?? orchestration?.status ?? "idle";
  const executionState = formatExecutionState(executionTruthRun?.executionState);
  const durableState = executionTruthRun?.durableRunId ? "linked" : "missing";
  const worktreeState = executionTruthRun?.worktreeStatus ?? workbenchState?.worktreeStatus ?? "off";

  return (
    <section className="chat-cowork-panel chat-workspace-panel mission-dock-panel">
      <header className="mission-dock-panel-head">
        <h4>Execution Board</h4>
        <p>
          {executionTruthRun
            ? `Run ${executionTruthRun.runId} · plan ${executionTruthRun.planId} with durable/worktree execution truth attached.`
            : orchestration
              ? `Workflow ${orchestration.workflowTemplate} · ${orchestration.steps.length} role${orchestration.steps.length === 1 ? "" : "s"} in flight.`
              : "Primary run state, step ownership, and operator controls for structured work."}
        </p>
      </header>

      <div className="chat-cowork-posture-row" aria-label="Cowork run summary">
        <div className="chat-cowork-stage-strip">
          <div className="chat-cowork-stage-card">
            <span>Plan state</span>
            <strong>{planState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Execution state</span>
            <strong>{executionState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Durable run</span>
            <strong>{durableState}</strong>
          </div>
        </div>
        <div className="chat-cowork-stage-strip chat-cowork-stage-strip-ops">
          <div className="chat-cowork-stage-card">
            <span>Tools used</span>
            <strong>{toolRuns}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Approval</span>
            <strong>{approvalState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Worktree</span>
            <strong>{worktreeState}</strong>
          </div>
        </div>
      </div>

      <div className="chat-cowork-toolbar">
        <button type="button" className="gc-button" onClick={onRetryTurn} disabled={!onRetryTurn}>
          Retry turn
        </button>
        <button type="button" className="gc-button" onClick={onStopTurn} disabled={!onStopTurn}>
          Stop run
        </button>
        <button type="button" className="gc-button" onClick={onOpenTasks} disabled={!onOpenTasks}>
          Open tasks
        </button>
      </div>

      {orchestration ? (
        <div className="chat-cowork-orchestration">
          <p className="chat-cowork-orchestration-summary">
            <strong>{orchestration.status}</strong>
            {" · "}
            {orchestration.routeDecision.selectedRoles.join(" -> ")}
          </p>
          {orchestration.finalSummary ? <p>{orchestration.finalSummary}</p> : null}
        </div>
      ) : null}

      <div className="chat-cowork-execution-grid">
        <div className="chat-cowork-execution-main">
          <section className="chat-cowork-section chat-cowork-section-primary">
            <p className="chat-cowork-section-label">Execution truth</p>
            {orchestrationLoading ? (
              <p className="chat-cowork-section-copy">Loading canonical orchestration run.</p>
            ) : null}
            {orchestrationError ? <p>{orchestrationError}</p> : null}
            {executionTruthRun ? (
              <ul className="chat-cowork-orchestration-steps">
                <li>
                  <div className="chat-cowork-step-head">
                    <strong>Plan state</strong>
                    <span>{executionTruthRun.status}</span>
                  </div>
                  <p>Execution state {executionState}</p>
                  <p>Run {executionTruthRun.runId}</p>
                  <p>Plan {executionTruthRun.planId}</p>
                  {executionTruthRun.durableRunId ? (
                    <p>Durable run {executionTruthRun.durableRunId}</p>
                  ) : (
                    <p>Durable linkage missing.</p>
                  )}
                  <p>Workspace {executionTruthRun.workspaceId ?? "default"}</p>
                  <p>Wave {executionTruthRun.currentWaveId ?? "none"}</p>
                  <p>Phase {executionTruthRun.currentPhaseId ?? "none"}</p>
                  <p>Worktree {executionTruthRun.worktreeStatus ?? "uninitialized"}</p>
                  {executionTruthRun.worktreeBaseRef ? <p>Base ref {executionTruthRun.worktreeBaseRef}</p> : null}
                  {executionTruthRun.worktreePath ? <p>Path {executionTruthRun.worktreePath}</p> : null}
                  {executionTruthRun.pendingApprovalPhaseId ? (
                    <p>
                      Approval pause on {executionTruthRun.pendingApprovalPhaseId}
                      {executionTruthRun.pendingApprovedBy
                        ? ` · last operator ${executionTruthRun.pendingApprovedBy}`
                        : ""}
                    </p>
                  ) : null}
                  {executionTruthRun.executionState === "resume_requested" ? (
                    <p>Resume requested; durable worker has not resumed yet.</p>
                  ) : null}
                  {executionTruthRun.lastError ? <p>{executionTruthRun.lastError}</p> : null}
                </li>
              </ul>
            ) : canonicalFallback(orchestration) ? (
              <p className="chat-cowork-section-copy">
                Canonical run {canonicalFallback(orchestration)} has not loaded yet. Turn summary stays secondary until
                the run record arrives.
              </p>
            ) : (
              <p className="chat-cowork-section-copy">
                No canonical orchestration run is attached to the selected turn.
              </p>
            )}
          </section>

          <section className="chat-cowork-section chat-cowork-section-primary">
            <p className="chat-cowork-section-label">Planned steps</p>
            {activePlanSteps.length === 0 ? (
              <p className="chat-cowork-section-copy">No execution plan is attached to the selected turn yet.</p>
            ) : (
              <ol className="chat-cowork-plan-list">
                {activePlanSteps.map((step) => (
                  <li key={step.stepId}>
                    <div className="chat-cowork-step-head">
                      <strong>{step.objective}</strong>
                      <span>{step.status}</span>
                    </div>
                    {step.delegatedRole ? <p>Assigned role: {step.delegatedRole}</p> : null}
                    {step.dependsOnStepIds?.length ? <p>Depends on: {step.dependsOnStepIds.join(", ")}</p> : null}
                    {step.successCriteria ? <p>Success: {step.successCriteria}</p> : null}
                    {step.durableRunId ? <p>Durable: {step.durableRunId}</p> : null}
                    {step.childSessionId ? <p>Child session: {step.childSessionId}</p> : null}
                    {step.childTurnId ? <p>Child turn: {step.childTurnId}</p> : null}
                    {step.childRunId ? <p>Deprecated child run: {step.childRunId}</p> : null}
                    {step.summary ? <p>{step.summary}</p> : null}
                    {step.error ? <p>{step.error}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="chat-cowork-execution-side">
          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Execution timeline</p>
            {checkpointTimeline.length ? (
              <ul className="chat-cowork-orchestration-steps">
                {checkpointTimeline.map((checkpoint) => (
                  <li key={checkpoint.checkpointId}>
                    <div className="chat-cowork-step-head">
                      <strong>{CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? checkpoint.checkpointKind}</strong>
                      <span>{checkpoint.createdAt}</span>
                    </div>
                    <p>
                      Wave {checkpoint.waveId ?? "none"}
                      {" · "}
                      Phase {checkpoint.phaseId ?? "none"}
                    </p>
                    {checkpoint.details.error ? <p>{String(checkpoint.details.error)}</p> : null}
                    {checkpoint.details.lifecycleState ? (
                      <p>Execution {String(checkpoint.details.lifecycleState)}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="chat-cowork-section-copy">No orchestration checkpoints are attached yet.</p>
            )}
          </section>

          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Role execution</p>
            {orchestration?.steps.length ? (
              <ul className="chat-cowork-orchestration-steps">
                {orchestration.steps.map((step) => (
                  <li key={step.stepId}>
                    <div className="chat-cowork-step-head">
                      <strong>{step.role}</strong>
                      <span>{step.status}</span>
                    </div>
                    <p>
                      {step.providerId ?? "provider auto"}
                      {step.model ? ` · ${step.model}` : ""}
                    </p>
                    {step.summary ? <p>{step.summary}</p> : null}
                    {step.error ? <p>{step.error}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="chat-cowork-section-copy">No delegated role activity is available yet.</p>
            )}
          </section>

          {orchestration ? (
            <section className="chat-cowork-section">
              <p className="chat-cowork-section-label">Turn summary</p>
              <ul className="chat-cowork-orchestration-steps">
                <li>
                  <div className="chat-cowork-step-head">
                    <strong>{orchestration.workflowTemplate}</strong>
                    <span>{orchestration.status}</span>
                  </div>
                  <p>{orchestration.routeDecision.selectedRoles.join(" -> ")}</p>
                  {orchestration.finalSummary ? <p>{orchestration.finalSummary}</p> : null}
                  {orchestration.runId ? <p>Related run {orchestration.runId}</p> : null}
                </li>
              </ul>
            </section>
          ) : null}

          <section className="chat-cowork-section">
            <p className="chat-cowork-section-label">Delegation run</p>
            {delegationSteps.length ? (
              <ul className="chat-cowork-orchestration-steps">
                {delegationSteps.map((step) => (
                  <li key={step.stepId}>
                    <div className="chat-cowork-step-head">
                      <strong>{step.role}</strong>
                      <span>{step.status}</span>
                    </div>
                    {step.durableRunId ? <p>Durable {step.durableRunId}</p> : null}
                    {step.childSessionId ? <p>Child session {step.childSessionId}</p> : null}
                    {step.childTurnId ? <p>Child turn {step.childTurnId}</p> : null}
                    {step.output ? <p>{step.output}</p> : null}
                    {step.error ? <p>{step.error}</p> : null}
                  </li>
                ))}
              </ul>
            ) : delegationRun ? (
              <p className="chat-cowork-section-copy">Delegation is attached, but no step detail has arrived yet.</p>
            ) : (
              <p className="chat-cowork-section-copy">No delegation run is attached to the selected turn.</p>
            )}
            {delegationRun?.stitchedOutput ? <p>{delegationRun.stitchedOutput}</p> : null}
          </section>

          {items.length > 0 ? (
            <section className="chat-cowork-section chat-cowork-section-secondary">
              <p className="chat-cowork-section-label">Operator queue</p>
              <ul>
                {items.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    {item.note ? <p>{item.note}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function canonicalFallback(orchestration?: ChatOrchestrationSummary): string | null {
  const runId = orchestration?.runId?.trim();
  return runId?.length ? runId : null;
}
