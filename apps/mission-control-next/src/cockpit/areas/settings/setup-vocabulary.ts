import type {
  AgenticRunStatus,
  AuthMode,
  EvidenceEnvelopeEventKind,
  OnboardingChecklistStatus,
  OnboardingReadinessStatus,
  OnboardingSetupReadiness,
  OnboardingSetupReadinessItem,
  OnboardingState,
} from "@goatcitadel/contracts";
import type { SettingsWizardStepState } from "../../../features/native-routes/settings/SettingsShared";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { deriveSetupCenterItems } from "../../../features/native-routes/settings/helpers/onboarding-readiness";
import { approvalModeLabel } from "../library/capability-vocabulary";
import { BUDGET_MODE } from "../system/system-vocabulary";

/**
 * First-run and setup-readiness enums in plain words, one table per contract enum so a new value fails typecheck until
 * it has a label. Anything unexpected from the wire reads "Unknown" rather than the raw token.
 */
export const SETUP_STEP_STATE_LABELS: Record<SettingsWizardStepState, string> = {
  complete: "Done",
  active: "In progress",
  pending: "Not started",
};
export const CHECKLIST_STATUS_LABELS: Record<OnboardingChecklistStatus, string> = {
  complete: "Done",
  needs_input: "Needs your input",
  optional: "Optional",
};
export const READINESS_STATUS_LABELS: Record<OnboardingReadinessStatus, string> = {
  ready: "Ready",
  needs_input: "Needs your input",
  blocked: "Blocked",
  unknown: "Unknown",
};
export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  none: "No sign-in",
  token: "Access token",
  basic: "Username and password",
};
export const DEPLOYMENT_POSTURE_LABELS: Record<OnboardingSetupReadiness["profile"]["deploymentPosture"], string> = {
  local_trusted: "Trusted local",
  remote_hardened: "Remote hardened",
  local_network: "Local network",
  unknown: "Unknown",
};
export const TAILNET_MODE_LABELS: Record<OnboardingSetupReadiness["profile"]["tailnetMode"], string> = {
  enabled: "On",
  disabled: "Off",
  not_required: "Not needed",
  unknown: "Unknown",
};
export const AGENTIC_RUN_STATUS_LABELS: Record<AgenticRunStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  approval_required: "Waiting on you",
  paused: "Paused",
  checkpointing: "Saving progress",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stopped_by_limit: "Stopped at its limit",
};
export const EVIDENCE_EVENT_KIND_LABELS: Record<EvidenceEnvelopeEventKind, string> = {
  tool_invocation: "Tool call",
  approval_resolution: "Approval decision",
  durable_checkpoint: "Run checkpoint",
  memory_write: "Memory write",
  capability_pack_install: "Capability pack install",
  capability_pack_materialization: "Capability pack set-up",
  continuation_gate: "Continuation check",
  skill_export: "Skill export",
  browser_content_guard: "Browser content guard",
  external_writeback: "External write",
  cron_job_executed: "Scheduled job run",
};

export function presentSetupLabel<K extends string>(
  table: Record<K, string>,
  value: string | null | undefined,
): string {
  return value && Object.hasOwn(table, value) ? table[value as K] : "Unknown";
}

/**
 * Readiness rows whose value is a contract enum read as a plain label. Free-form values (URLs, paths, counts) return
 * undefined and stay in technical details.
 */
export function presentReadinessValue(item: OnboardingSetupReadinessItem): string | undefined {
  switch (item.id) {
    case "auth_mode":
      return presentSetupLabel(AUTH_MODE_LABELS, item.value);
    case "remote_posture":
      return presentSetupLabel(DEPLOYMENT_POSTURE_LABELS, item.value);
    case "tailnet":
      return presentSetupLabel(TAILNET_MODE_LABELS, item.value);
    default:
      return undefined;
  }
}

/**
 * The shared helper's Setup Center rows, with the descriptions the Gateway composes from raw values (approval and
 * budget modes, the auth mode, the model id) restated in plain words.
 */
export function presentSetupCenterItems(state: OnboardingState, activeModelLabel: string) {
  const settings = state.settings;
  const runtimeComplete = state.checklist?.some((item) => item.id === "runtime" && item.status === "complete");
  const authMode = settings?.auth?.mode ?? "none";
  const providersWithKeys = (settings?.llm?.providers ?? []).filter((provider) => provider.hasApiKey).length;
  return deriveSetupCenterItems(state).map((item) => {
    if (item.label === "Provider smoke" && providersWithKeys > 0) {
      const sources = plural(providersWithKeys, "provider credential source");
      return { ...item, description: `${sources} available. Active model: ${activeModelLabel}.` };
    }
    if (item.label === "Local runtime" && runtimeComplete) {
      const budget = presentSetupLabel(BUDGET_MODE, settings.budgetMode);
      return { ...item, description: `${approvalModeLabel(settings.toolApprovalMode)} · ${budget} budget.` };
    }
    if (item.label === "Access and auth" && authMode !== "none") {
      return { ...item, description: `Gateway sign-in: ${presentSetupLabel(AUTH_MODE_LABELS, authMode)}.` };
    }
    return item;
  });
}
