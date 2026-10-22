import type {
  ExternalSideEffectRunStatus,
  GoogleMeetSessionState,
  IntegrationExternalWritebackResumeState,
} from "@goatcitadel/contracts";

/** Integration side-effect and Meet enums in plain words; a new contract value fails typecheck until it has a label. */
export const SIDE_EFFECT_STATUS_LABELS: Record<ExternalSideEffectRunStatus, string> = {
  claimed_not_sent: "Claimed, not sent",
  external_call_started: "Sending",
  completed: "Done",
  failed_before_boundary: "Failed before sending",
  unknown_external_outcome: "Outcome unknown",
  blocked_duplicate: "Blocked as a duplicate",
  payload_mismatch: "Different from the original request",
  idempotency_unavailable: "Duplicate protection unavailable",
};
export const RESUME_STATE_LABELS: Record<IntegrationExternalWritebackResumeState, string> = {
  not_resumable: "Cannot be resumed",
  completed: "Done",
  manual_retry_after_recorded_failure: "Needs a manual retry",
  manual_review_unknown_external_outcome: "Needs a manual check",
  in_progress: "In progress",
  payload_mismatch: "Different from the original request",
  idempotency_unavailable: "Duplicate protection unavailable",
};
export const MEET_SESSION_STATE_LABELS: Record<GoogleMeetSessionState, string> = {
  blocked: "Blocked",
  ready: "Ready",
  connecting: "Connecting",
  running: "Running",
  consulting: "Consulting",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};
