import type {
  BrowserSessionEventType,
  BudgetState,
  CuratorReviewItem,
  DecisionAutoTuneRecord,
  DecisionReplayRunStatus,
  DevDiagnosticsCategory,
  DevDiagnosticsLevel,
  ImprovementCandidateStatus,
  LlmEvalProofRunRecord,
  LlmRuntimeMeasurementSource,
  PromptPackSecurityEvalPackStatus,
  RuntimeAuthorityClass,
  RuntimeAuthorityDomain,
  RuntimeAuthorityFreshness,
  RuntimeAuthorityPosture,
  SessionHealth,
  SessionKind,
} from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  humanizeToken,
  type StatusPresentation,
  type StatusTone,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** System-only wording for wire values that have no shared presenter. Raw values stay in technical details. */
const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });

/** Classification is a description of the record, not a health signal, so it is plain text and never a badge. */
export const AUTHORITY_CLASS_LABELS: Readonly<Record<RuntimeAuthorityClass, string>> = {
  canonical_record: "Saved record",
  derived_projection: "Computed",
  retained_signal: "Recorded signal",
  inferred: "Inferred",
  unavailable: "Unavailable",
};

export const AUTHORITY_DOMAIN: Readonly<Record<RuntimeAuthorityDomain, string>> = {
  runs: "Runs",
  approvals: "Approvals",
  workers: "Workers",
  backups: "Backups",
  reconciliation: "Reconciliation",
};

export const AUTHORITY_FRESHNESS: Readonly<Record<RuntimeAuthorityFreshness, StatusPresentation>> = {
  current: status("Current", "done"),
  stale: status("Stale", "waiting"),
  contradictory: status("Contradictory", "failed"),
  missing: status("Missing", "neutral"),
  unknown: status("Unknown", "neutral"),
};

export const AUTHORITY_POSTURE: Readonly<Record<RuntimeAuthorityPosture, StatusPresentation>> = {
  ok: status("OK", "done"),
  neutral: status("Informational", "neutral"),
  attention: status("Needs attention", "waiting"),
  critical: status("Critical", "failed"),
  unavailable: status("Unavailable", "neutral"),
};

export const SESSION_HEALTH: Readonly<Record<SessionHealth, StatusPresentation>> = {
  healthy: status("Healthy", "done"),
  degraded: status("Degraded", "waiting"),
  blocked: status("Blocked", "failed"),
};

export const SESSION_BUDGET: Readonly<Record<BudgetState, string>> = {
  ok: "within limits",
  warning: "near its limit",
  hard_cap: "hard cap reached",
};

export const SESSION_KIND: Readonly<Record<SessionKind, string>> = {
  dm: "Direct message",
  group: "Group",
  thread: "Thread",
};

const KNOWN_CHANNELS: Readonly<Record<string, string>> = {
  webchat: "Web chat",
  web: "Web chat",
  cli: "Command line",
  tui: "Terminal",
  sms: "SMS",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
};

/** Channels are an open set of connector names, so unknown ones fall back to a readable form of their name. */
export function presentChannel(channel: string): string {
  return KNOWN_CHANNELS[channel.toLowerCase()] ?? (humanizeToken(channel) || "Unknown channel");
}

export const BUDGET_MODE: Readonly<Record<RuntimeSettingsResponse["budgetMode"], string>> = {
  saver: "Saver",
  balanced: "Balanced",
  power: "Power",
};

export const DIAGNOSTIC_LEVEL: Readonly<Record<DevDiagnosticsLevel, string>> = {
  debug: "Debug",
  info: "Info",
  warn: "Warning",
  error: "Error",
};

const DIAGNOSTIC_CATEGORY: Readonly<Record<DevDiagnosticsCategory, string>> = {
  ui: "Interface",
  api: "API",
  sse: "Live updates",
  refresh: "Refresh",
  chat: "Chat",
  orchestration: "Orchestration",
  gateway: "GoatCitadel server",
  tools: "Tools",
  model: "Model",
  runtime: "Runtime",
  voice: "Voice",
  meet: "Meetings",
  mcp: "MCP",
  office: "Office",
  dependency: "Dependency",
};

/** The category field also accepts open strings from newer emitters; those keep a readable form of their name. */
export function presentDiagnosticCategory(category: string): string {
  return DIAGNOSTIC_CATEGORY[category as DevDiagnosticsCategory] ?? humanizeToken(category);
}

/** Diagnostic event names are free-form dotted identifiers ("chat.stream.failed") with no enum to map. */
export function presentDiagnosticEvent(event: string): string {
  return humanizeToken(event) || "Diagnostic event";
}

export const EVAL_PACK_STATUS: Readonly<Record<PromptPackSecurityEvalPackStatus, string>> = {
  available: "Available",
  imported: "Imported",
  unavailable: "Unavailable",
};

export const EVAL_RUN_STATUS: Readonly<Record<LlmEvalProofRunRecord["status"], string>> = {
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
};

export const MEASUREMENT_SOURCE: Readonly<Record<LlmRuntimeMeasurementSource, string>> = {
  live: "Live",
  cached: "Cached",
  estimated: "Estimated",
  unavailable: "Unavailable",
};

export const REPLAY_RUN_STATUS: Readonly<Record<DecisionReplayRunStatus, string>> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const CANDIDATE_STATUS: Readonly<Record<ImprovementCandidateStatus, string>> = {
  proposed: "Proposed",
  evaluating: "Evaluating",
  ready_for_approval: "Ready for approval",
  approval_pending: "Approval pending",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const CANDIDATE_RISK: Readonly<Record<CuratorReviewItem["risk"], string>> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

export const AUTO_TUNE_STATUS: Readonly<Record<DecisionAutoTuneRecord["status"], string>> = {
  queued: "Queued",
  applied: "Applied",
  reverted: "Reverted",
  rejected: "Rejected",
  blocked: "Blocked",
};

export const BROWSER_SESSION_EVENT: Readonly<Record<BrowserSessionEventType, string>> = {
  session_created: "Session created",
  session_closed: "Session closed",
  grant_created: "Grant created",
  grant_revoked: "Grant revoked",
  grant_rotated: "Grant rotated",
  tool_access_granted: "Tool access granted",
  tool_guard_blocked: "Tool blocked by a guard",
};
