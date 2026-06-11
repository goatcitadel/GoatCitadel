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

function describePlanStepDelegation(step: ChatExecutionPlanStepRecord): string | null {
  // Raw lineage ids (durableRunId/childSessionId/childTurnId/childRunId) are
  // operator-debug data; end users only need to know the step runs elsewhere.
  const durable = Boolean(step.durableRunId);
  const delegated = Boolean(step.childSessionId || step.childTurnId || step.childRunId);
  if (durable && delegated) {
    return "Runs as a durable background task · delegated to a child session";
  }
  if (durable) {
    return "Runs as a durable background task";
  }
  if (delegated) {
    return "Delegated to a child session";
  }
  return null;
}

export function ChatExecutionPlanSummary({
  plan,
}: {
  plan: ChatExecutionPlanRecord;
}) {
  const density = getPlanDensity(plan.mode);
  const currentStep = getCurrentPlanStep(plan);
  const currentStepDelegation = currentStep ? describePlanStepDelegation(currentStep) : null;

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
            {currentStepDelegation ? <p>{currentStepDelegation}</p> : null}
          </div>
        ) : null
      ) : (
        <ol className="chat-trace-list">
          {plan.steps.map((step) => {
            const delegationNote = describePlanStepDelegation(step);
            return (
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
                {delegationNote ? <p>{delegationNote}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
