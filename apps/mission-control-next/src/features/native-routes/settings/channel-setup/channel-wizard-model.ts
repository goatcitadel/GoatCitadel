import type { ReactNode } from "react";
import type {
  ChannelProbeReport,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftEvidence,
  ChannelSetupFieldDefinition,
  ChannelSetupIssue,
  ChannelSetupStatus,
  ChannelSetupStepDefinition,
  ChannelSetupTestResult,
} from "@goatcitadel/contracts";
export const SECRET_REDACTION_MARKER = "[REDACTED]";
export interface ChannelSetupWizardFeedback {
  kind: "validate" | "test";
  checkedAt?: string;
  restored?: boolean;
  proofExpiresAt?: string;
  status: ChannelSetupStatus;
  issues: ChannelSetupIssue[];
  recommendedNextAction?: string;
  probe?: ChannelProbeReport;
  evidenceId?: string;
  finalizationEligibility?: ChannelSetupTestResult["finalizationEligibility"];
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
  mutationBlocked?: boolean;
  busyAction?: "save" | "validate" | "test" | "finalize" | null;
  feedback?: ChannelSetupWizardFeedback | null;
  supplementaryActions?: ReactNode;
  draftEvidence?: ChannelSetupDraftEvidence;
  draftEvidenceLoading?: boolean;
  draftEvidenceError?: string | null;
  onAcknowledgeTest?: (acknowledgement: "cleanup" | "receipt") => Promise<void>;
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
    return feedback?.kind === "test" && !finalizeDisabledReason(false, feedback);
  }
  if (step.kind === "confirm" || step.stage === "first_message") {
    return false;
  }
  const checklistComplete = !step.checklist?.length ||
    step.checklist.every((item) => checkedItems[`${draft.draftId}:${step.id}:${item.id}`]);
  if (!checklistComplete) return false;
  if (step.fields?.length || step.requiredAnyOf?.length) {
    return findMissingFieldLabels(definition, draft, step, values).length === 0;
  }
  if (step.checklist?.length) return true;
  return Boolean(visitedStepIds[step.id]);
}

export function findMissingFieldLabels(
  definition: ChannelSetupDefinition,
  draft: ChannelSetupDraft,
  step: ChannelSetupStepDefinition,
  values: Record<string, unknown>,
): string[] {
  const effectiveValues = wizardValuesWithDefaults(definition, values);
  const fields = (step.fields ?? []).filter((field) => isFieldVisible(field, effectiveValues));
  const missing = fields
    .filter((field) => field.required && !hasFieldValue(draft, effectiveValues, field.key))
    .map((field) => field.label);
  for (const group of step.requiredAnyOf ?? []) {
    if (!group.some((key) => hasFieldValue(draft, effectiveValues, key))) {
      const allFields = definition.wizard.steps.flatMap((item) => item.fields ?? []);
      missing.push(group.map((key) => allFields.find((field) => field.key === key)?.label ?? key).join(" or "));
    }
  }
  for (const field of fields) {
    if (field.type === "target-list" && hasFieldValue(draft, effectiveValues, field.key)) {
      const addressKey = field.targetAddressKey ?? "chatId";
      const rows = readChannelTargetRows(effectiveValues[field.key], addressKey);
      if (!rows.length || rows.some((row) => !String(row[addressKey] ?? "").trim())) missing.push(field.label + ": add a destination to every row");
      if (rows.length && rows.filter((row) => row.default === true).length !== 1) missing.push(field.label + ": choose one default");
      const identities = rows.map((row) => channelTargetIdentity(row));
      if (new Set(identities).size !== identities.length) missing.push(field.label + ": remove duplicate destinations");
    }
  }
  if (
    !step.requiredAnyOf?.length &&
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
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return draft.hydration?.fieldState[key] === "configured" || draft.secretState[key]?.configured === true;
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
    (current === SECRET_REDACTION_MARKER || draft.hydration?.fieldState[field.key] === "configured" || draft.secretState[field.key]?.configured === true)
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
  if (channelProofExpired(feedback)) {
    return "This test proof expired. Review the saved evidence and run a new reviewed test before finalizing.";
  }
  if (feedback.finalizationEligibility) {
    return feedback.finalizationEligibility.allowed
      ? undefined
      : feedback.finalizationEligibility.blockingReasons.join(" ") || "The Gateway has not cleared this test for activation.";
  }
  if (feedback.status !== "ok") {
    return "Resolve the live test results and rerun the test before finalizing.";
  }
  return undefined;
}

/** The Gateway supplies the deadline; the client never invents or extends a TTL. */
export function channelProofExpired(feedback?: Pick<ChannelSetupWizardFeedback, "kind" | "proofExpiresAt" | "restored"> | null): boolean {
  if (feedback?.kind !== "test") return false;
  if (!feedback.proofExpiresAt) return feedback.restored === true;
  const deadline = Date.parse(feedback.proofExpiresAt);
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

export function formatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function wizardValuesWithDefaults(definition: ChannelSetupDefinition, values: Record<string, unknown>): Record<string, unknown> {
  return {
    ...Object.fromEntries(definition.wizard.steps.flatMap((step) => step.fields ?? [])
      .filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue])),
    ...values,
  };
}

export function isFieldVisible(field: ChannelSetupFieldDefinition, values: Record<string, unknown>): boolean {
  const condition = field.visibleWhenFieldEquals;
  return !condition || values[condition.fieldKey] === condition.value;
}

export interface ChannelTargetRow extends Record<string, unknown> {
  id: string;
  label: string;
  default?: boolean;
  channel?: string;
  chatId?: string;
  threadTs?: string;
  threadId?: string;
}
export function readChannelTargetRows(value: unknown, addressKey: "channel" | "chatId"): ChannelTargetRow[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item, index) => ({
      ...item,
      id: typeof item.id === "string" && item.id ? item.id : `target-${index + 1}`,
      label: typeof item.label === "string" ? item.label : "",
      [addressKey]: typeof item[addressKey] === "string" ? item[addressKey] : "",
      default: item.default === true || item.default === "true",
    }));
}

export function channelTargetIdentity(row: ChannelTargetRow): string {
  return JSON.stringify([String(row.chatId ?? row.channel ?? "").trim().toLowerCase(), String(row.chatId !== undefined ? row.threadId ?? "" : row.threadTs ?? "").trim()]);
}

export function mergeDiscoveredChannelTargets(current: ChannelTargetRow[], selected: ChannelTargetRow[]): ChannelTargetRow[] {
  const known = new Set(current.map(channelTargetIdentity));
  const added = selected.filter((item) => {
    const address = String(item.chatId ?? item.channel ?? "").trim().toLowerCase();
    const identity = channelTargetIdentity(item);
    if (!address || known.has(identity)) return false;
    known.add(identity);
    return true;
  }).map((item) => ({ ...item, default: false }));
  return [...current, ...added];
}

export function channelStageLabel(step: ChannelSetupStepDefinition): string {
  const labels = {
    prerequisites: "Before you start", identity: "Connect account",
    destinations_access: "Destinations and access", checks: "Check connection",
    activation: "Activate connection", first_message: "First message",
  };
  return step.stage ? labels[step.stage] : humanizeStepKind(step.kind);
}
