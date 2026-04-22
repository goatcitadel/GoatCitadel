import type {
  ChatExecutionPlanRecord,
  ChatExecutionPlanStepRecord,
  ChatMode,
} from "@goatcitadel/contracts";

type PlanDensity = "compact" | "expanded" | "checklist";

function getPlanDensity(mode: ChatMode): PlanDensity {
  switch (mode) {
    case "cowork":
      return "expanded";
    case "code":
      return "checklist";
    default:
      return "compact";
  }
}

function getCurrentPlanStep(plan: ChatExecutionPlanRecord): ChatExecutionPlanStepRecord | undefined {
  return plan.steps.find((step) => step.status === "running")
    ?? plan.steps.find((step) => step.status === "pending")
    ?? plan.steps.find((step) => step.status === "failed");
}

function formatPlanStepStatus(step: ChatExecutionPlanStepRecord): string {
  switch (step.status) {
    case "completed":
      return "done";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function getPlanProgressLabel(plan: ChatExecutionPlanRecord): string {
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return `${completed}/${plan.steps.length} completed`;
}

export function ChatExecutionPlanSummary({
  plan,
}: {
  plan: ChatExecutionPlanRecord;
}) {
  const density = getPlanDensity(plan.mode);
  const currentStep = getCurrentPlanStep(plan);

  return (
    <div className="chat-execution-plan-summary">
      <p>
        <strong>{plan.objective}</strong>
        {" · "}
        {plan.status}
        {" · "}
        {getPlanProgressLabel(plan)}
      </p>
      <p>{plan.summary}</p>
      <p>
        {plan.source}
        {" · "}
        {plan.planningMode}
        {plan.advisoryOnly ? " · advisory only" : ""}
      </p>
      {density === "compact" ? (
        currentStep ? (
          <div>
            <p>
              <strong>Current step:</strong> {currentStep.objective}
            </p>
            <p>Status: {formatPlanStepStatus(currentStep)}</p>
            {currentStep.summary ? <p>{currentStep.summary}</p> : null}
            {currentStep.error ? <p>Error: {currentStep.error}</p> : null}
            {currentStep.durableRunId || currentStep.childSessionId || currentStep.childTurnId || currentStep.childRunId ? (
              <p>
                Lineage:
                {currentStep.durableRunId ? ` durable ${currentStep.durableRunId}` : ""}
                {currentStep.childSessionId ? ` | child session ${currentStep.childSessionId}` : ""}
                {currentStep.childTurnId ? ` | child turn ${currentStep.childTurnId}` : ""}
                {currentStep.childRunId ? ` | deprecated childRunId ${currentStep.childRunId}` : ""}
              </p>
            ) : null}
          </div>
        ) : null
      ) : (
        <ol className="chat-trace-list">
          {plan.steps.map((step) => (
            <li key={step.stepId}>
              <span>{step.objective}</span>
              <span>{formatPlanStepStatus(step)}</span>
              {density === "expanded" && step.successCriteria ? <p>Success: {step.successCriteria}</p> : null}
              {density === "expanded" && step.expectedOutput ? <p>Output: {step.expectedOutput}</p> : null}
              {density === "expanded" && step.suggestedTools?.length ? <p>Tools: {step.suggestedTools.join(", ")}</p> : null}
              {density === "expanded" && step.dependsOnStepIds?.length ? <p>Depends on: {step.dependsOnStepIds.join(", ")}</p> : null}
              {step.summary ? <p>{step.summary}</p> : null}
              {step.error ? <p>Error: {step.error}</p> : null}
              {step.delegatedRole ? <p>Delegated role: {step.delegatedRole}</p> : null}
              {step.durableRunId || step.childSessionId || step.childTurnId || step.childRunId ? (
                <p>
                  Lineage:
                  {step.durableRunId ? ` durable ${step.durableRunId}` : ""}
                  {step.childSessionId ? ` | child session ${step.childSessionId}` : ""}
                  {step.childTurnId ? ` | child turn ${step.childTurnId}` : ""}
                  {step.childRunId ? ` | deprecated childRunId ${step.childRunId}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
