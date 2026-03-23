import type { ChatMode } from "@goatcitadel/contracts";

interface ExecutionPlanStepView {
  index: number;
  objective: string;
  successCriteria?: string;
  expectedOutput?: string;
  suggestedTools?: string[];
  dependsOnStepIds?: string[];
  delegatedRole?: string;
}

export function renderExecutionPlanAsMarkdown(input: {
  mode: ChatMode;
  objective: string;
  summary: string;
  steps: ExecutionPlanStepView[];
}): string {
  const modeLabel = input.mode === "cowork"
    ? "Cowork plan"
    : input.mode === "code"
      ? "Code plan"
      : "Chat plan";
  const stepLines = input.steps.map((step) => {
    const parts = [
      `${step.index + 1}. ${step.objective}`,
      step.successCriteria ? `Success: ${step.successCriteria}` : undefined,
      step.expectedOutput ? `Output: ${step.expectedOutput}` : undefined,
      step.suggestedTools?.length ? `Suggested tools: ${step.suggestedTools.join(", ")}` : undefined,
      step.dependsOnStepIds?.length ? `Depends on: ${step.dependsOnStepIds.join(", ")}` : undefined,
      step.delegatedRole ? `Delegated role: ${step.delegatedRole}` : undefined,
    ].filter(Boolean);
    return parts.join("\n   ");
  });
  return [
    `## ${modeLabel}`,
    "",
    `Objective: ${input.objective}`,
    "",
    input.summary,
    "",
    "Planned steps:",
    ...stepLines,
  ].join("\n");
}

export function buildDelegationFailureGuidance(error: string, role: string): string {
  const normalized = error.toLowerCase();
  if (/\bauth|login|token|credential|permission\b/.test(normalized)) {
    return `${toTitleCase(role)} hit an auth or permission barrier. Reconnect the required account or switch to another source.`;
  }
  if (/\btimeout|timed out|deadline|aborted\b/.test(normalized)) {
    return `${toTitleCase(role)} ran out of time. Retry with a narrower brief or fewer sources.`;
  }
  if (/\bblocked|deny|denied|approval|policy|jail\b/.test(normalized)) {
    return `${toTitleCase(role)} hit a restricted action. Use a safer fallback path or request approval explicitly.`;
  }
  if (/\bnot found|404|missing\b/.test(normalized)) {
    return `${toTitleCase(role)} could not find the expected input. Retry with a more explicit file, path, or source reference.`;
  }
  return `Retry the ${role} delegate with a narrower brief or a different tool/source strategy.`;
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
