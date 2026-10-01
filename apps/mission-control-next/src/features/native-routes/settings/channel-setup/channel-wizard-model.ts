import type { ReactNode } from "react";
import type {
  ChannelProbeReport,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupIssue,
  ChannelSetupStatus,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
export const SECRET_REDACTION_MARKER = "[REDACTED]";
export interface ChannelSetupWizardFeedback {
  kind: "validate" | "test";
  status: ChannelSetupStatus;
  issues: ChannelSetupIssue[];
  recommendedNextAction?: string;
  probe?: ChannelProbeReport;
}

export interface ChannelSetupWizardProps {
  scopeId?: string;
  advancedValue?: string;
  onAdvancedValueChange?: (value: string) => void;
  definition: ChannelSetupDefinition;
  draft: ChannelSetupDraft;
  values: Record<string, unknown>;
  label: string;
  enabled: boolean;
  dirty: boolean;
  reviewRequired?: boolean;
  busyAction?: "save" | "validate" | "test" | "finalize" | null;
  feedback?: ChannelSetupWizardFeedback | null;
  supplementaryActions?: ReactNode;
  onValuesChange: (next: Record<string, unknown>) => void;
  onLabelChange: (next: string) => void;
  onEnabledChange: (next: boolean) => void;
  onDirty: () => void;
  onSave: (valuesOverride?: Record<string, unknown>) => Promise<boolean>;
  onValidate: (valuesOverride?: Record<string, unknown>) => Promise<void>;
  onTest: (valuesOverride?: Record<string, unknown>) => Promise<void>;
  onFinalize: (valuesOverride?: Record<string, unknown>) => Promise<void>;
}

export function isStepVisible(step: ChannelSetupStepDefinition, values: Record<string, unknown>): boolean {
  const condition = step.visibleWhenFieldEquals;
  return !condition || values[condition.fieldKey] === condition.value;
}

export function isStepComplete(
  step: ChannelSetupStepDefinition,
  definition: ChannelSetupDefinition,
  draft: ChannelSetupDraft,
  values: Record<string, unknown>,
  visitedStepIds: Record<string, boolean>,
  checkedItems: Record<string, boolean>,
  feedback?: ChannelSetupWizardFeedback | null,
): boolean {
  if (step.kind === "test") {
    return feedback?.kind === "test" && feedback.status === "ok";
  }
  if (step.kind === "confirm") {
    return false;
  }
  if (step.checklist?.length) {
    return step.checklist.every((item) => checkedItems[`${draft.draftId}:${step.id}:${item.id}`]);
  }
  if (step.fields?.length) {
    return findMissingFieldLabels(definition, draft, step, values).length === 0;
  }
  return Boolean(visitedStepIds[step.id]);
}

export function findMissingFieldLabels(
  definition: ChannelSetupDefinition,
  draft: ChannelSetupDraft,
  step: ChannelSetupStepDefinition,
  values: Record<string, unknown>,
): string[] {
  const missing = (step.fields ?? [])
    .filter((field) => field.required && !hasFieldValue(draft, values, field.key))
    .map((field) => field.label);
  if (
    definition.catalog.catalogId === "channel.discord" &&
    step.fields?.some((field) => field.key === "botTokenEnv") &&
    !hasFieldValue(draft, values, "botTokenEnv") &&
    !hasFieldValue(draft, values, "botToken") &&
    !hasFieldValue(draft, values, "webhookUrl")
  ) {
    missing.unshift("Bot token env var or bot token");
  }
  return missing;
}

export function hasFieldValue(draft: ChannelSetupDraft, values: Record<string, unknown>, key: string): boolean {
  const value = values[key];
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (value !== undefined && value !== null) {
    return true;
  }
  return draft.hydration?.fieldState[key] === "configured";
}

export function updateFieldValue(
  draft: ChannelSetupDraft,
  values: Record<string, unknown>,
  field: ChannelSetupFieldDefinition,
  next: unknown,
): Record<string, unknown> {
  const current = values[field.key];
  if (
    field.sensitive &&
    typeof next === "string" &&
    next.length === 0 &&
    (current === SECRET_REDACTION_MARKER || draft.hydration?.fieldState[field.key] === "configured")
  ) {
    return { ...values, [field.key]: SECRET_REDACTION_MARKER };
  }
  return { ...values, [field.key]: next };
}

export function humanizeStepKind(kind: ChannelSetupStepDefinition["kind"]): string {
  return kind.replaceAll("-", " ");
}

export function finalizeDisabledReason(
  dirty: boolean,
  feedback?: ChannelSetupWizardFeedback | null,
): string | undefined {
  if (dirty) {
    return "Save these changes and run the live test again before finalizing.";
  }
  if (feedback?.kind !== "test") {
    return "Run the live test before finalizing this connection.";
  }
  if (feedback.status !== "ok") {
    return "Resolve the live test results and rerun the test before finalizing.";
  }
  return undefined;
}

export function formatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}
