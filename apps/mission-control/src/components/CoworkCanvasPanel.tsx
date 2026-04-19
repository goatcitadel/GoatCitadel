import type {
  ChatExecutionPlanRecord,
  ChatOrchestrationSummary,
  ChatSessionWorkbenchRecord,
  ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import type { ActiveChatDelegationRun } from "../pages/chat/useChatDelegationPolicyActions";

export interface CoworkTaskItem {
  id: string;
  title: string;
  note?: string;
}

export function CoworkCanvasPanel({
  items,
  orchestration,
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
  executionPlan?: ChatExecutionPlanRecord;
  delegationRun?: ActiveChatDelegationRun | null;
  selectedTurn?: ChatThreadTurnRecord | null;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  onRetryTurn?: () => void;
  onStopTurn?: () => void;
  onOpenTasks?: () => void;
}) {
  const runningSteps = orchestration?.steps.filter((step) => step.status === "running").length ?? 0;
  const completedSteps = orchestration?.steps.filter((step) => step.status === "completed").length ?? 0;
  const queuedSteps =
    orchestration?.steps.filter((step) => step.status !== "completed" && step.status !== "running").length ?? 0;
  const activePlanSteps = executionPlan?.steps ?? [];
  const delegationSteps = delegationRun?.steps ?? [];
  const toolRuns = selectedTurn?.toolRuns?.length ?? 0;
  const waitingForApproval = selectedTurn?.trace?.status === "waiting_for_approval";

  return (
    <section className="chat-cowork-panel chat-workspace-panel mission-dock-panel">
      <header className="mission-dock-panel-head">
        <h4>Execution Board</h4>
        <p>
          {orchestration
            ? `Workflow ${orchestration.workflowTemplate} · ${orchestration.steps.length} role${orchestration.steps.length === 1 ? "" : "s"} in flight.`
            : "Primary run state, step ownership, and operator controls for structured work."}
        </p>
      </header>

      <div className="chat-cowork-posture-row" aria-label="Cowork run summary">
        <div className="chat-cowork-stage-strip">
          <div className="chat-cowork-stage-card">
            <span>Running</span>
            <strong>{runningSteps}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Completed</span>
            <strong>{completedSteps}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Queued</span>
            <strong>{queuedSteps}</strong>
          </div>
        </div>
        <div className="chat-cowork-stage-strip chat-cowork-stage-strip-ops">
          <div className="chat-cowork-stage-card">
            <span>Tools used</span>
            <strong>{toolRuns}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Approvals</span>
            <strong>{waitingForApproval ? "1" : "0"}</strong>
          </div>
          <div className="chat-cowork-stage-card">
            <span>Worktree</span>
            <strong>{workbenchState?.worktreeStatus ?? "off"}</strong>
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
