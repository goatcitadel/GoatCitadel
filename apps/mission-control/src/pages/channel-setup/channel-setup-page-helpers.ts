/**
 * Pure helpers extracted from ChannelSetupPage.tsx (Step 10 page slimming).
 */

import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupStepDefinition,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
} from "@goatcitadel/contracts";

export function isStepVisible(step: ChannelSetupStepDefinition, draft: Record<string, unknown> | undefined): boolean {
  if (!step.visibleWhenFieldEquals) {
    return true;
  }
  return draft?.[step.visibleWhenFieldEquals.fieldKey] === step.visibleWhenFieldEquals.value;
}

export function isFieldSatisfied(
  field: ChannelSetupFieldDefinition,
  draftValues: Record<string, unknown>,
  hydrationState?: "configured" | "missing" | "needs_replacement" | "unknown",
) {
  const value = draftValues[field.key];
  if (field.type === "boolean") {
    return typeof value === "boolean" || hydrationState === "configured";
  }
  if (!field.required) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return hydrationState === "configured";
}

export function getStepCompletionState(
  step: ChannelSetupStepDefinition,
  draft: ChannelSetupDraft | null,
  validation: ChannelSetupValidationResult | null,
  testResult: ChannelSetupTestResult | null,
): "pending" | "complete" {
  if (!draft) {
    return "pending";
  }
  if (step.fields && step.fields.length > 0) {
    return step.fields.every((field) => isFieldSatisfied(field, draft.draft, draft.hydration?.fieldState[field.key]))
      ? "complete"
      : "pending";
  }
  if (step.kind === "test") {
    return testResult?.status === "ok" ? "complete" : "pending";
  }
  if (step.kind === "confirm") {
    return testResult?.status === "ok" && validation?.status === "ok" ? "complete" : "pending";
  }
  return "pending";
}

export function findResumeStepId(definition: ChannelSetupDefinition, draft: ChannelSetupDraft) {
  const visibleSteps = definition.wizard.steps.filter((step) => isStepVisible(step, draft.draft));
  const nextIncomplete = visibleSteps.find((step) => getStepCompletionState(step, draft, null, null) !== "complete");
  return nextIncomplete?.id ?? visibleSteps.at(-1)?.id ?? "";
}

export function describeStepStatus(
  step: ChannelSetupStepDefinition,
  draft: ChannelSetupDraft | null,
  validation: ChannelSetupValidationResult | null,
  testResult: ChannelSetupTestResult | null,
) {
  const state = getStepCompletionState(step, draft, validation, testResult);
  if (state === "complete") {
    return "Complete";
  }
  switch (step.kind) {
    case "field-collection":
      return "Values and context";
    case "test":
      return testResult ? "Re-run after changes" : "Run validation and live checks";
    case "confirm":
      return "Finalize when validation and tests pass";
    default:
      return "Review and continue";
  }
}

export function findStartStepId(definition: ChannelSetupDefinition, lifecycleMode: ChannelSetupDraft["lifecycleMode"]) {
  if (lifecycleMode === "repair" || lifecycleMode === "rotate_secret" || lifecycleMode === "retest") {
    return (
      definition.wizard.steps.find((step) => step.kind === "field-collection" || step.kind === "test")?.id ??
      definition.wizard.steps[0]?.id ??
      ""
    );
  }
  return definition.wizard.steps[0]?.id ?? "";
}

export function titleCaseLifecycle(mode: ChannelSetupDraft["lifecycleMode"]) {
  switch (mode) {
    case "rotate_secret":
      return "Rotate Secret";
    case "retest":
      return "Re-test";
    default:
      return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
}

export function lifecycleDescription(mode: ChannelSetupDraft["lifecycleMode"]) {
  switch (mode) {
    case "create":
      return "Guided first-time setup";
    case "edit":
      return "Selective edit of an existing connection";
    case "repair":
      return "Diagnostics-forward recovery path";
    case "rotate_secret":
      return "Focused credential replacement";
    case "retest":
      return "Verification-only run";
  }
}
