import type {
  AgenticRunStatus,
  AuthMode,
  EvidenceEnvelopeEventKind,
  OnboardingChecklistStatus,
  OnboardingReadinessStatus,
  OnboardingSetupReadiness,
} from "@goatcitadel/contracts";
import type { SettingsWizardStepState } from "../../../features/native-routes/settings/SettingsShared";

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
  remote_hardened: "Remote Hardened",
  local_network: "Local network",
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
