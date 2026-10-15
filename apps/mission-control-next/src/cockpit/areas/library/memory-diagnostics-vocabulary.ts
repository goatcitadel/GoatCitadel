import type {
  EvidenceEnvelopeEventKind,
  EvidenceEnvelopeSignatureStatus,
  MemoryDecisionRetrospective,
  MemoryFeedbackKind,
  MemoryFeedbackStatus,
  MemoryMaintenanceRecommendationStatus,
  MemoryMaintenanceRunMode,
  MemoryMaintenanceRunStatus,
  MemoryMaintenanceSourceKind,
  MemoryQualityIssueSeverity,
  MemoryQualityIssueStatus,
  StructuredMemoryAuthority,
  StructuredMemoryScope,
  StructuredMemoryStatus,
} from "@goatcitadel/contracts";
import {
  humanizeToken,
  type StatusPresentation,
  type StatusTone,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** Plain words for memory diagnostics. Typed records so a new enum value fails typecheck. */

const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });
/** A value the Gateway adds before this map learns it reads as "Unknown …", never as the raw token. */
const lookup = <K extends string, V>(map: Record<K, V>, value: string, fallback: V): V =>
  (map as Record<string, V | undefined>)[value] ?? fallback;

const EVIDENCE_KIND: Record<EvidenceEnvelopeEventKind, string> = {
  tool_invocation: "Tool call",
  approval_resolution: "Approval decision",
  durable_checkpoint: "Run checkpoint",
  memory_write: "Memory write",
  capability_pack_install: "Capability pack install",
  capability_pack_materialization: "Capability pack set-up",
  continuation_gate: "Continuation check",
  skill_export: "Skill export",
  browser_content_guard: "Browser content check",
  external_writeback: "External write",
  cron_job_executed: "Scheduled job run",
};
export const evidenceKindLabel = (value: string) => lookup(EVIDENCE_KIND, value, "Other evidence");

const SIGNATURE: Record<EvidenceEnvelopeSignatureStatus, string> = {
  signed_hmac: "Signed",
  unsigned_local: "Unsigned (local)",
  verification_failed: "Signature check failed",
};
export const signatureLabel = (value: string) => lookup(SIGNATURE, value, "Signature state unknown");

const SEVERITY: Record<MemoryQualityIssueSeverity, StatusPresentation> = {
  low: status("Minor", "neutral"),
  medium: status("Worth fixing", "waiting"),
  high: status("Serious", "failed"),
};
export const presentIssueSeverity = (value: string) => lookup(SEVERITY, value, status("Severity unknown", "neutral"));

const ISSUE_STATUS: Record<MemoryQualityIssueStatus, StatusPresentation> = {
  open: status("Open", "waiting"),
  resolved: status("Resolved", "done"),
  dismissed: status("Dismissed", "neutral"),
};
export const presentIssueStatus = (value: string) => lookup(ISSUE_STATUS, value, status("Status unknown", "neutral"));

const FEEDBACK_KIND: Record<MemoryFeedbackKind, string> = {
  stale: "Out of date",
  missing: "Missing memory",
  irrelevant: "Not relevant",
  useful: "Useful",
};
export const feedbackKindLabel = (value: string) => lookup(FEEDBACK_KIND, value, "Other feedback");

const FEEDBACK_STATUS: Record<MemoryFeedbackStatus, string> = {
  open: "Open",
  reviewed: "Reviewed",
  dismissed: "Dismissed",
};
export const feedbackStatusLabel = (value: string) => lookup(FEEDBACK_STATUS, value, "Status unknown");

const STRUCTURED_SCOPE: Record<StructuredMemoryScope, string> = {
  global: "Shared across workspaces",
  workspace: "This workspace",
  session: "One conversation",
  run: "One run",
};
export const structuredScopeLabel = (value: string) => lookup(STRUCTURED_SCOPE, value, "Scope unknown");

const STRUCTURED_STATUS: Record<StructuredMemoryStatus, string> = {
  active: "Active",
  forgotten: "Forgotten",
  superseded: "Superseded",
};
export const structuredStatusLabel = (value: string) => lookup(STRUCTURED_STATUS, value, "Status unknown");

const AUTHORITY: Record<StructuredMemoryAuthority, string> = {
  operator: "Recorded by an operator",
  agent_proposed: "Proposed by an agent",
  trusted_lifecycle: "Promoted through review",
  imported_skill: "Imported with a skill",
};
export const authorityLabel = (value: string) => lookup(AUTHORITY, value, "Source not recorded");

const RETROSPECTIVE: Record<MemoryDecisionRetrospective["outcome"], string> = {
  unknown: "Outcome unknown",
  validated: "Validated",
  partially_validated: "Partly validated",
  invalidated: "Did not hold",
};
export const retrospectiveLabel = (value: string) => lookup(RETROSPECTIVE, value, "Outcome unknown");

const RUN_STATUS: Record<MemoryMaintenanceRunStatus, StatusPresentation> = {
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  cancelled: status("Cancelled", "neutral"),
  skipped: status("Skipped", "neutral"),
};
export const presentMaintenanceRun = (value: string) => lookup(RUN_STATUS, value, status("Status unknown", "neutral"));

const RECOMMENDATION: Record<MemoryMaintenanceRecommendationStatus, StatusPresentation> = {
  queued: status("Waiting for review", "waiting"),
  accepted: status("Accepted", "done"),
  rejected: status("Rejected", "neutral"),
  applied: status("Applied", "done"),
};
export const presentRecommendation = (value: string) =>
  lookup(RECOMMENDATION, value, status("Status unknown", "neutral"));

export const RUN_MODE: Record<MemoryMaintenanceRunMode, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  hybrid: "Manual and scheduled",
};
export const runModeLabel = (value: string) => lookup(RUN_MODE, value, "Mode unknown");

const SOURCE_KIND: Record<MemoryMaintenanceSourceKind, string> = {
  transcript: "Conversation transcript",
  file: "File",
  memory_item: "Memory item",
  artifact: "Artifact",
};
export const maintenanceSourceLabel = (value: string) => lookup(SOURCE_KIND, value, "Other source");

export const ADMIN_STATE: Record<"enabled" | "disabled" | "unknown", string> = {
  enabled: "on",
  disabled: "off",
  unknown: "in an unknown state",
};

/** "Memory maintenance is on and runs manually and on a schedule." */
export function maintenancePolicySentence(enabled: boolean, runMode: string) {
  return `Memory maintenance is ${enabled ? "on" : "off"} and runs ${lookup<MemoryMaintenanceRunMode, string>(
    { manual: "only when you start it", scheduled: "on a schedule", hybrid: "manually and on a schedule" },
    runMode,
    "in an unknown mode",
  )}.`;
}

/** Entity and relation types are free text written by the memory owner. */
export const freeformLabel = (value: string, fallback: string) => humanizeToken(value) || fallback;
