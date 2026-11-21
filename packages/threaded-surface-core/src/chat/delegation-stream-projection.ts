import type { ChatDelegationRunStatus } from "@goatcitadel/contracts";
import type { ActiveChatDelegationRun, ActiveChatDelegationStep } from "./useChatDelegationPolicyActions";

export class ExplorerObservationDetachedError extends Error {
  public constructor() {
    super("Workspace explorer observation continued in background.");
    this.name = "ExplorerObservationDetachedError";
  }
}

export function inferDelegationRunStatus(
  steps: ActiveChatDelegationStep[],
  fallback: ChatDelegationRunStatus = "running",
) {
  if (steps.length === 0) {
    return fallback;
  }
  if (steps.some((step) => step.status === "running" || step.status === "pending")) {
    return "running";
  }
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const failedOrSkippedCount = steps.filter((step) => step.status === "failed" || step.status === "skipped").length;
  if (completedCount === steps.length) {
    return "completed";
  }
  if (completedCount > 0 && failedOrSkippedCount > 0) {
    return "partial";
  }
  if (failedOrSkippedCount > 0) {
    return "failed";
  }
  return fallback;
}

function mergeDelegationStep(
  currentSteps: ActiveChatDelegationStep[],
  nextStep: ActiveChatDelegationStep,
): ActiveChatDelegationStep[] {
  // Assumes `currentSteps` is already sorted by `.index`. Callers seed via
  // `createSeedDelegationSteps` which sorts, and every other code path that
  // builds a fresh list also sorts before assigning. By inserting in-order
  // instead of `.sort()`-ing after every merge, we drop O(n log n) work
  // from every streaming update.
  const matchingIndex = currentSteps.findIndex(
    (step) =>
      step.stepId === nextStep.stepId ||
      (!step.runId && step.index === nextStep.index && step.role.toLowerCase() === nextStep.role.toLowerCase()),
  );
  const mergedStep = matchingIndex >= 0 ? { ...currentSteps[matchingIndex], ...nextStep } : nextStep;
  const remainingSteps =
    matchingIndex >= 0 ? currentSteps.filter((_, position) => position !== matchingIndex) : currentSteps;
  const insertionIndex = remainingSteps.findIndex((step) => step.index > mergedStep.index);
  if (insertionIndex < 0) {
    return [...remainingSteps, mergedStep];
  }
  return [...remainingSteps.slice(0, insertionIndex), mergedStep, ...remainingSteps.slice(insertionIndex)];
}

export function applyDelegationStatusChunk(
  current: ActiveChatDelegationRun | null,
  chunk: { runId?: string; taskId?: string },
): ActiveChatDelegationRun | null {
  return current
    ? {
        ...current,
        runId: chunk.runId ?? current.runId,
        taskId: chunk.taskId ?? current.taskId,
      }
    : current;
}

export function applyDelegationStepChunk(
  current: ActiveChatDelegationRun | null,
  chunk: { runId?: string; taskId?: string },
  nextStep: ActiveChatDelegationStep,
): ActiveChatDelegationRun | null {
  if (!current) {
    return current;
  }
  const steps = mergeDelegationStep(current.steps, nextStep);
  return {
    ...current,
    runId: chunk.runId ?? current.runId,
    taskId: chunk.taskId ?? current.taskId,
    steps,
    status: inferDelegationRunStatus(steps, "running"),
  };
}

export function applyDelegationStreamFailure(current: ActiveChatDelegationRun | null): ActiveChatDelegationRun | null {
  return current
    ? {
        ...current,
        status: inferDelegationRunStatus(
          current.steps,
          current.steps.some((step) => step.status === "completed") ? "partial" : "failed",
        ),
      }
    : current;
}
