import type { ChatOrchestrationSummary } from "@goatcitadel/contracts";

export interface CoworkTaskItem {
  id: string;
  title: string;
  note?: string;
}

export function CoworkCanvasPanel({
  items,
  orchestration,
}: {
  items: CoworkTaskItem[];
  orchestration?: ChatOrchestrationSummary;
}) {
  const runningSteps = orchestration?.steps.filter((step) => step.status === "running").length ?? 0;
  const completedSteps = orchestration?.steps.filter((step) => step.status === "completed").length ?? 0;
  const waitingSteps = orchestration?.steps.filter((step) => step.status !== "completed" && step.status !== "running").length ?? 0;

  return (
    <aside className="chat-cowork-panel mission-dock-panel">
      <header className="mission-dock-panel-head">
        <h4>Cowork Canvas</h4>
        <p>
          {orchestration
            ? `Workflow ${orchestration.workflowTemplate} · ${orchestration.steps.length} role${orchestration.steps.length === 1 ? "" : "s"} in play.`
            : "Shared context, active checklist, and workflow framing for this session."}
        </p>
      </header>
      {orchestration ? (
        <div className="chat-cowork-orchestration">
          <div className="chat-cowork-stage-strip" aria-label="Cowork run summary">
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
              <strong>{waitingSteps}</strong>
            </div>
          </div>
          <p className="chat-cowork-orchestration-summary">
            <strong>{orchestration.status}</strong>
            {" · "}
            {orchestration.routeDecision.selectedRoles.join(" -> ")}
          </p>
          {orchestration.finalSummary ? <p>{orchestration.finalSummary}</p> : null}
          <div className="chat-cowork-section">
            <p className="chat-cowork-section-label">Active run</p>
            <p className="chat-cowork-section-copy">
              Workflow template <strong>{orchestration.workflowTemplate}</strong> is coordinating {orchestration.steps.length} role{orchestration.steps.length === 1 ? "" : "s"} across this thread.
            </p>
          </div>
          <ul className="chat-cowork-orchestration-steps">
            {orchestration.steps.map((step) => (
              <li key={step.stepId}>
                <strong>{step.role}</strong>
                <span>{step.providerId ?? "provider auto"}{step.model ? ` · ${step.model}` : ""}</span>
                <span>{step.status}</span>
                {step.summary ? <p>{step.summary}</p> : null}
                {step.error ? <p>{step.error}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="chat-cowork-empty">No active tasks yet. Ask GoatCitadel to plan next steps, research the space, or coordinate work across roles.</p>
      ) : (
        <div className="chat-cowork-section">
          <p className="chat-cowork-section-label">Operator queue</p>
          <ul>
          {items.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              {item.note ? <p>{item.note}</p> : null}
            </li>
          ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
