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

const MAX_VISIBLE_PLAN_STEPS = 3;
const MAX_VISIBLE_OPERATOR_ITEMS = 2;
const MAX_VISIBLE_TIMELINE_ITEMS = 3;
const MAX_VISIBLE_ROLE_ITEMS = 3;
const MAX_VISIBLE_DELEGATION_ITEMS = 2;

function humanizeStatus(value?: string | null): string {
  if (!value) {
    return "unknown";
  }
  return value.replaceAll("_", " ");
}

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

function normalizeSummary(value?: string | null, maxLength = 140): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function limitItems<T>(items: T[], maxVisible: number): { visible: T[]; overflow: number } {
  return {
    visible: items.slice(0, maxVisible),
    overflow: Math.max(0, items.length - maxVisible),
  };
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
  const waitingForUserInput = selectedTurn?.trace?.status === "waiting_for_user_input";
  const executionTruthRun = orchestrationRun ?? null;
  const approvalState = formatApprovalState({ orchestrationRun: executionTruthRun, waitingForApproval });
  const checkpointTimeline = orchestrationCheckpoints ?? [];
  const planState = executionTruthRun?.status ?? orchestration?.status ?? "idle";
  const executionState = formatExecutionState(executionTruthRun?.executionState);
  const worktreeState = executionTruthRun?.worktreeStatus ?? workbenchState?.worktreeStatus ?? "off";
  const visibleActions = [
    onRetryTurn ? (
      <button key="retry" type="button" className="gc-button" onClick={onRetryTurn}>
        Retry turn
      </button>
    ) : null,
    onStopTurn ? (
      <button key="stop" type="button" className="gc-button" onClick={onStopTurn}>
        Stop run
      </button>
    ) : null,
    onOpenTasks ? (
      <button key="tasks" type="button" className="gc-button" onClick={onOpenTasks}>
        Open tasks
      </button>
    ) : null,
  ].filter(Boolean);
  const selectedRoles = orchestration?.routeDecision.selectedRoles ?? [];
  const attentionItems = [
    waitingForUserInput ? "Cowork is waiting for your answer before the run can continue." : null,
    !waitingForUserInput && waitingForApproval
      ? `Approval is blocking the current run${executionTruthRun?.pendingApprovalPhaseId ? ` on ${executionTruthRun.pendingApprovalPhaseId}` : ""}.`
      : null,
    orchestrationError ? orchestrationError : null,
    executionTruthRun?.lastError ? executionTruthRun.lastError : null,
    delegationSteps.find((step) => step.error)?.error ?? null,
  ].filter((value): value is string => Boolean(value));
  const emptyBoard =
    !executionTruthRun &&
    !orchestration &&
    !orchestrationLoading &&
    !orchestrationError &&
    activePlanSteps.length === 0 &&
    delegationSteps.length === 0 &&
    checkpointTimeline.length === 0 &&
    items.length === 0;
  const nowLabel = emptyBoard ? "Ready to start" : attentionItems.length > 0 ? "Needs attention" : "Now";
  const nowHeadline = emptyBoard
    ? "No orchestration run is attached yet."
    : waitingForUserInput
      ? "Answer needed before Cowork can continue"
      : waitingForApproval
        ? `Approval pause${executionTruthRun?.pendingApprovalPhaseId ? ` on ${executionTruthRun.pendingApprovalPhaseId}` : ""}`
        : executionTruthRun
          ? `${humanizeStatus(planState)} run · ${executionState}`
          : orchestration
            ? `${humanizeStatus(orchestration.status)} workflow`
            : "Cowork is waiting for structured work";
  const nowSummary = emptyBoard
    ? "Start with a coordination request and Cowork will attach a visible plan, role activity, and run checkpoints here."
    : orchestration?.finalSummary
      ? orchestration.finalSummary
      : executionTruthRun
        ? `Wave ${executionTruthRun.currentWaveId ?? "none"} · Phase ${executionTruthRun.currentPhaseId ?? "none"} · ${executionTruthRun.workspaceId ?? "default"} workspace.`
        : selectedRoles.length > 0
          ? `Roles in play: ${selectedRoles.join(" -> ")}.`
          : "Cowork has context, but no routed role activity yet.";
  const nowFacts = [
    selectedRoles.length > 0 ? { label: "Roles", value: selectedRoles.join(" -> ") } : null,
    orchestration?.workflowTemplate ? { label: "Workflow", value: orchestration.workflowTemplate } : null,
    executionTruthRun?.runId ? { label: "Run", value: executionTruthRun.runId } : null,
    executionTruthRun?.currentPhaseId ? { label: "Phase", value: executionTruthRun.currentPhaseId } : null,
  ].filter((value): value is { label: string; value: string } => Boolean(value));
  const roleActivity = orchestration?.steps ?? [];
  const hasSideColumn =
    attentionItems.length > 0 ||
    checkpointTimeline.length > 0 ||
    roleActivity.length > 0 ||
    delegationSteps.length > 0 ||
    Boolean(executionTruthRun);
  const visiblePlanSteps = limitItems(activePlanSteps, MAX_VISIBLE_PLAN_STEPS);
  const visibleOperatorItems = limitItems(items, MAX_VISIBLE_OPERATOR_ITEMS);
  const visibleTimeline = limitItems([...checkpointTimeline].reverse(), MAX_VISIBLE_TIMELINE_ITEMS);
  const visibleRoleActivity = limitItems(roleActivity, MAX_VISIBLE_ROLE_ITEMS);
  const visibleDelegationSteps = limitItems(delegationSteps, MAX_VISIBLE_DELEGATION_ITEMS);

  return (
    <section className={`chat-cowork-panel chat-workspace-panel mission-dock-panel${emptyBoard ? " is-empty" : ""}`}>
      <header className="mission-dock-panel-head">
        <h4>Workflow overview</h4>
        <p>
          {executionTruthRun
            ? `Run ${executionTruthRun.runId} · plan ${executionTruthRun.planId} with durable/worktree execution truth attached.`
            : orchestration
              ? `Workflow ${orchestration.workflowTemplate} · ${orchestration.steps.length} role${orchestration.steps.length === 1 ? "" : "s"} in flight.`
              : "One place for what is active, blocked, and next."}
        </p>
      </header>

      <div className="chat-cowork-posture-row" aria-label="Cowork run summary">
        <div className="chat-cowork-stage-strip">
          <div className="chat-cowork-stage-card">
            <span>Workflow</span>
            <strong>{planState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Execution</span>
            <strong>{executionState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Approval</span>
            <strong>{waitingForUserInput ? "answer needed" : approvalState}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Worktree</span>
            <strong>{humanizeStatus(worktreeState)}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Tools used</span>
            <strong>{toolRuns}</strong>
          </div>
        </div>
      </div>

      {visibleActions.length > 0 ? <div className="chat-cowork-toolbar">{visibleActions}</div> : null}

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

      <div className={`chat-cowork-execution-grid${hasSideColumn ? "" : " chat-cowork-execution-grid-single"}`}>
        <div className="chat-cowork-execution-main">
          <section className="chat-cowork-section chat-cowork-section-primary chat-cowork-section-callout">
            <p className="chat-cowork-section-label">{nowLabel}</p>
            <div className="chat-cowork-callout">
              <strong className="chat-cowork-callout-title">{nowHeadline}</strong>
              <p className="chat-cowork-section-copy">{nowSummary}</p>
              {orchestrationLoading ? (
                <p className="chat-cowork-section-copy">Loading canonical orchestration run.</p>
              ) : null}
              {!executionTruthRun && canonicalFallback(orchestration) ? (
                <p className="chat-cowork-section-copy">
                  Canonical run {canonicalFallback(orchestration)} has not loaded yet.
                </p>
              ) : null}
              {nowFacts.length > 0 ? (
                <dl className="chat-cowork-fact-list">
                  {nowFacts.map((fact) => (
                    <div key={`${fact.label}-${fact.value}`}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </section>

          {attentionItems.length > 0 ? (
            <section className="chat-cowork-section chat-cowork-section-primary">
              <p className="chat-cowork-section-label">Needs attention</p>
              <ul className="chat-cowork-orchestration-steps">
                {attentionItems.map((item) => (
                  <li key={item}>
                    <p>{item}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {activePlanSteps.length > 0 ? (
            <section className="chat-cowork-section chat-cowork-section-primary">
              <p className="chat-cowork-section-label">Planned steps</p>
              <ol className="chat-cowork-plan-list">
                {visiblePlanSteps.visible.map((step) => (
                  <li key={step.stepId}>
                    <div className="chat-cowork-step-head">
                      <strong>{step.objective}</strong>
                      <span>{step.status}</span>
                    </div>
                    {step.delegatedRole || step.dependsOnStepIds?.length ? (
                      <p className="chat-cowork-step-meta">
                        {step.delegatedRole ? `Role ${step.delegatedRole}` : ""}
                        {step.delegatedRole && step.dependsOnStepIds?.length ? " · " : ""}
                        {step.dependsOnStepIds?.length ? `Depends on ${step.dependsOnStepIds.join(", ")}` : ""}
                      </p>
                    ) : null}
                    {normalizeSummary(step.summary ?? step.error ?? step.successCriteria) ? (
                      <p>{normalizeSummary(step.summary ?? step.error ?? step.successCriteria)}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
              {visiblePlanSteps.overflow > 0 ? (
                <p className="chat-cowork-overflow-note">+{visiblePlanSteps.overflow} more planned step(s)</p>
              ) : null}
            </section>
          ) : null}

          {items.length > 0 ? (
            <section className="chat-cowork-section chat-cowork-section-secondary">
              <p className="chat-cowork-section-label">Operator queue</p>
              <ul>
                {visibleOperatorItems.visible.map((item) => (
                  <li key={item.id} className="chat-cowork-queue-item">
                    <strong className="chat-cowork-queue-title">{item.title}</strong>
                    {item.note ? <p className="chat-cowork-queue-note">{item.note}</p> : null}
                  </li>
                ))}
              </ul>
              {visibleOperatorItems.overflow > 0 ? (
                <p className="chat-cowork-overflow-note">+{visibleOperatorItems.overflow} more queue item(s)</p>
              ) : null}
            </section>
          ) : null}

          {emptyBoard ? (
            <section className="chat-cowork-section chat-cowork-section-secondary">
              <p className="chat-cowork-section-label">What to do next</p>
              <ul className="chat-cowork-orchestration-steps">
                <li>
                  <p>Ask Cowork to break the work into a staged plan.</p>
                </li>
                <li>
                  <p>Use Open tasks when you want the broader queue beside the run.</p>
                </li>
                <li>
                  <p>Once a run starts, this board will promote the current phase, blockers, and timeline here.</p>
                </li>
              </ul>
            </section>
          ) : null}
        </div>

        {hasSideColumn ? (
          <aside className="chat-cowork-execution-side">
            {executionTruthRun ? (
              <section className="chat-cowork-section">
                <p className="chat-cowork-section-label">Run facts</p>
                <dl className="chat-cowork-fact-list">
                  <div>
                    <dt>Plan</dt>
                    <dd>{executionTruthRun.status}</dd>
                  </div>
                  <div>
                    <dt>Execution</dt>
                    <dd>{executionState}</dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{executionTruthRun.workspaceId ?? "default"}</dd>
                  </div>
                  <div>
                    <dt>Phase</dt>
                    <dd>{executionTruthRun.currentPhaseId ?? "none"}</dd>
                  </div>
                  <div>
                    <dt>Wave</dt>
                    <dd>{executionTruthRun.currentWaveId ?? "none"}</dd>
                  </div>
                  <div>
                    <dt>Worktree</dt>
                    <dd>{humanizeStatus(executionTruthRun.worktreeStatus ?? "uninitialized")}</dd>
                  </div>
                </dl>
                {executionTruthRun.pendingApprovalPhaseId ? (
                  <p className="chat-cowork-section-copy">
                    Approval paused on {executionTruthRun.pendingApprovalPhaseId}
                    {executionTruthRun.pendingApprovedBy
                      ? ` · last operator ${executionTruthRun.pendingApprovedBy}`
                      : ""}
                  </p>
                ) : null}
                {executionTruthRun.executionState === "resume_requested" ? (
                  <p className="chat-cowork-section-copy">Resume requested; durable worker has not resumed yet.</p>
                ) : null}
              </section>
            ) : null}

            {checkpointTimeline.length ? (
              <section className="chat-cowork-section">
                <p className="chat-cowork-section-label">Execution timeline</p>
                <ul className="chat-cowork-orchestration-steps">
                  {visibleTimeline.visible.map((checkpoint) => (
                    <li key={checkpoint.checkpointId}>
                      <div className="chat-cowork-step-head">
                        <strong>{CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? checkpoint.checkpointKind}</strong>
                        <span>{checkpoint.createdAt}</span>
                      </div>
                      <p className="chat-cowork-step-meta">
                        Wave {checkpoint.waveId ?? "none"}
                        {" · "}
                        Phase {checkpoint.phaseId ?? "none"}
                      </p>
                      {checkpoint.details.error ? (
                        <p>{normalizeSummary(String(checkpoint.details.error), 110)}</p>
                      ) : null}
                      {checkpoint.details.lifecycleState ? (
                        <p className="chat-cowork-step-meta">Execution {String(checkpoint.details.lifecycleState)}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {visibleTimeline.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">+{visibleTimeline.overflow} earlier checkpoint(s)</p>
                ) : null}
              </section>
            ) : null}

            {roleActivity.length ? (
              <section className="chat-cowork-section">
                <p className="chat-cowork-section-label">Role execution</p>
                <ul className="chat-cowork-orchestration-steps">
                  {visibleRoleActivity.visible.map((step) => (
                    <li key={step.stepId}>
                      <div className="chat-cowork-step-head">
                        <strong>{step.role}</strong>
                        <span>{step.status}</span>
                      </div>
                      <p className="chat-cowork-step-meta">
                        {step.providerId ?? "provider auto"}
                        {step.model ? ` · ${step.model}` : ""}
                      </p>
                      {normalizeSummary(step.summary ?? step.error, 120) ? (
                        <p>{normalizeSummary(step.summary ?? step.error, 120)}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {visibleRoleActivity.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">+{visibleRoleActivity.overflow} more role update(s)</p>
                ) : null}
              </section>
            ) : null}

            {delegationSteps.length || delegationRun ? (
              <section className="chat-cowork-section">
                <p className="chat-cowork-section-label">Delegation run</p>
                {visibleDelegationSteps.visible.length ? (
                  <ul className="chat-cowork-orchestration-steps">
                    {visibleDelegationSteps.visible.map((step) => (
                      <li key={step.stepId}>
                        <div className="chat-cowork-step-head">
                          <strong>{step.role}</strong>
                          <span>{step.status}</span>
                        </div>
                        {step.durableRunId ? <p className="chat-cowork-step-meta">Durable linked</p> : null}
                        {normalizeSummary(step.output ?? step.error, 120) ? (
                          <p>{normalizeSummary(step.output ?? step.error, 120)}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : delegationRun ? (
                  <p className="chat-cowork-section-copy">
                    Delegation is attached, but no step detail has arrived yet.
                  </p>
                ) : null}
                {visibleDelegationSteps.overflow > 0 ? (
                  <p className="chat-cowork-overflow-note">+{visibleDelegationSteps.overflow} more delegated step(s)</p>
                ) : null}
                {delegationRun?.stitchedOutput ? (
                  <p className="chat-cowork-section-copy">Stitched output available in the run trace.</p>
                ) : null}
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function canonicalFallback(orchestration?: ChatOrchestrationSummary): string | null {
  const runId = orchestration?.runId?.trim();
  return runId?.length ? runId : null;
}
