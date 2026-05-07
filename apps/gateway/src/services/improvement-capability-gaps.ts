import type {
  CapabilityGapCauseClass,
  CapabilityGapEventRecord,
  DecisionReplayCauseClass,
  ImprovementStrategyTag,
  RepairCandidateRecord,
  RepairValidationStatus,
} from "@goatcitadel/contracts";
import { clamp01, isRecord, safeJsonParse } from "./improvement-common.js";

export const CAPABILITY_GAP_CAUSE_CLASSES = new Set<CapabilityGapCauseClass>([
  "tool_exists_but_not_in_profile",
  "tool_requires_approval_but_not_exposed",
  "skill_missing",
  "provider_tool_mismatch",
  "retryable_network_failure",
  "policy_denied_by_config",
  "missing_required_tool_evidence",
  "routing_profile_mismatch",
]);

export const REPAIR_VALIDATION_STATUSES = new Set<RepairValidationStatus>([
  "not_started",
  "queued",
  "running",
  "needs_review",
  "passed",
  "failed",
]);

export interface CapabilityGapEventUpsertInput {
  sessionId: string;
  turnId?: string;
  runId?: string;
  causeClass: CapabilityGapCauseClass;
  failureClass?: string;
  promptExcerpt?: string;
  promptRef?: string;
  requestedTool?: string;
  toolFamily?: string;
  toolProfile?: string;
  policyReason?: string;
  providerId?: string;
  model?: string;
  configArea?: string;
  suggestedRepairClass?: string;
  confidence?: number;
  recoveryOptions?: string[];
}

export interface RepairCandidateValidationUpdateInput {
  status: RepairValidationStatus;
  summary?: string;
}

export interface CapabilityGapEventRow {
  event_id: string;
  session_id: string;
  turn_id: string | null;
  run_id: string | null;
  cause_class: string;
  failure_class: string | null;
  prompt_excerpt: string | null;
  prompt_ref: string | null;
  requested_tool: string | null;
  tool_family: string | null;
  tool_profile: string | null;
  policy_reason: string | null;
  provider_id: string | null;
  model: string | null;
  config_area: string | null;
  suggested_repair_class: string | null;
  confidence: number;
  repeat_count: number;
  recovery_options_json: string;
  replay_run_id: string | null;
  replay_status: string | null;
  repair_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepairCandidateRow {
  candidate_id: string;
  fingerprint: string;
  cause_class: string;
  title: string;
  summary: string;
  requested_tool: string | null;
  tool_profile: string | null;
  provider_id: string | null;
  config_area: string | null;
  suggested_patch: string | null;
  replay_run_id: string | null;
  validation_status: string;
  validation_summary: string | null;
  event_count: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export function mapCapabilityGapEventRow(row: CapabilityGapEventRow): CapabilityGapEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? undefined,
    runId: row.run_id ?? undefined,
    causeClass: normalizeCapabilityGapCauseClass(row.cause_class),
    failureClass: row.failure_class ?? undefined,
    promptExcerpt: row.prompt_excerpt ?? undefined,
    promptRef: row.prompt_ref ?? undefined,
    requestedTool: row.requested_tool ?? undefined,
    toolFamily: row.tool_family ?? undefined,
    toolProfile: row.tool_profile ?? undefined,
    policyReason: row.policy_reason ?? undefined,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    configArea: row.config_area ?? undefined,
    suggestedRepairClass: row.suggested_repair_class ?? undefined,
    confidence: clamp01(row.confidence),
    repeatCount: Math.max(1, row.repeat_count),
    recoveryOptions: normalizeRecoveryOptions(safeJsonParse<string[]>(row.recovery_options_json, [])),
    replayRunId: row.replay_run_id ?? undefined,
    replayStatus: normalizeReplayStatus(row.replay_status),
    repairCandidateId: row.repair_candidate_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRepairCandidateRow(row: RepairCandidateRow): RepairCandidateRecord {
  return {
    candidateId: row.candidate_id,
    fingerprint: row.fingerprint,
    causeClass: normalizeCapabilityGapCauseClass(row.cause_class),
    title: row.title,
    summary: row.summary,
    requestedTool: row.requested_tool ?? undefined,
    toolProfile: row.tool_profile ?? undefined,
    providerId: row.provider_id ?? undefined,
    configArea: row.config_area ?? undefined,
    suggestedPatch: row.suggested_patch ?? undefined,
    replayRunId: row.replay_run_id ?? undefined,
    validationStatus: normalizeRepairValidationStatus(row.validation_status),
    validationSummary: row.validation_summary ?? undefined,
    eventCount: Math.max(1, row.event_count),
    confidence: clamp01(row.confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function normalizeCapabilityGapCauseClass(value: string): CapabilityGapCauseClass {
  return CAPABILITY_GAP_CAUSE_CLASSES.has(value as CapabilityGapCauseClass)
    ? (value as CapabilityGapCauseClass)
    : "policy_denied_by_config";
}

export function classifyReplayCauseStrategy(causeClass: DecisionReplayCauseClass): ImprovementStrategyTag {
  switch (causeClass) {
    case "tool_mismatch":
    case "incomplete_retry_repair":
      return "repair";
    case "retrieval_miss":
    case "false_refusal_tone":
    case "weak_blocker_explanation":
      return "harden";
    case "other":
    default:
      return "stabilize";
  }
}

export function classifyCapabilityGapStrategy(causeClass: CapabilityGapCauseClass): ImprovementStrategyTag {
  switch (causeClass) {
    case "retryable_network_failure":
    case "skill_missing":
      return "repair";
    case "tool_exists_but_not_in_profile":
    case "tool_requires_approval_but_not_exposed":
    case "provider_tool_mismatch":
    case "policy_denied_by_config":
      return "harden";
    case "missing_required_tool_evidence":
    case "routing_profile_mismatch":
    default:
      return "stabilize";
  }
}

export function improvementStrategyRationale(tag: ImprovementStrategyTag): string {
  switch (tag) {
    case "repair":
      return "Fix recurring failures with bounded proposal drafts and replay-backed follow-up checks.";
    case "harden":
      return "Tighten guardrails, routing rules, and trust posture before widening runtime behavior.";
    case "stabilize":
    default:
      return "Turn repeated drift into inspectable review artifacts so operators can decide what becomes durable.";
  }
}

export function normalizeRecoveryOptions(values: string[] | undefined): CapabilityGapEventRecord["recoveryOptions"] {
  const allowed = new Set<CapabilityGapEventRecord["recoveryOptions"][number]>([
    "temporary_session_allow",
    "switch_tool_profile",
    "request_approval",
    "install_skill",
    "reroute_provider",
    "retry_once",
    "replay_failed_turn",
    "patch_config",
  ]);
  return [
    ...new Set(
      (values ?? []).filter((value): value is CapabilityGapEventRecord["recoveryOptions"][number] =>
        allowed.has(value as CapabilityGapEventRecord["recoveryOptions"][number]),
      ),
    ),
  ];
}

export function normalizeReplayStatus(value: string | null | undefined): CapabilityGapEventRecord["replayStatus"] {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  return "not_run";
}

export function normalizeRepairValidationStatus(
  value: string | null | undefined,
): RepairCandidateRecord["validationStatus"] {
  if (
    value === "not_started" ||
    value === "queued" ||
    value === "running" ||
    value === "needs_review" ||
    value === "passed" ||
    value === "failed"
  ) {
    return value;
  }
  return "not_started";
}

export function buildCapabilityGapFingerprint(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  providerId?: string;
}): string {
  return [
    input.causeClass,
    input.requestedTool?.trim().toLowerCase() ?? "",
    input.toolProfile?.trim().toLowerCase() ?? "",
    input.providerId?.trim().toLowerCase() ?? "",
  ].join("|");
}

export function buildRepairCandidateTitle(causeClass: CapabilityGapCauseClass, requestedTool?: string): string {
  const toolLabel = requestedTool ? ` for ${requestedTool}` : "";
  switch (causeClass) {
    case "tool_exists_but_not_in_profile":
      return `Tool approval mismatch${toolLabel}`;
    case "tool_requires_approval_but_not_exposed":
      return `Approval path missing${toolLabel}`;
    case "skill_missing":
      return `Missing skill capability${toolLabel}`;
    case "provider_tool_mismatch":
      return `Provider/tool mismatch${toolLabel}`;
    case "retryable_network_failure":
      return `Retryable network failure${toolLabel}`;
    case "missing_required_tool_evidence":
      return `Missing tool evidence${toolLabel}`;
    case "routing_profile_mismatch":
      return `Routing/profile mismatch${toolLabel}`;
    case "policy_denied_by_config":
    default:
      return `Config policy block${toolLabel}`;
  }
}

export function buildRepairCandidateSummary(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  providerId?: string;
  configArea?: string;
  eventCount: number;
}): string {
  const fragments = [
    `${input.eventCount} recurring event${input.eventCount === 1 ? "" : "s"} detected`,
    input.requestedTool ? `tool ${input.requestedTool}` : undefined,
    input.toolProfile ? `profile ${input.toolProfile}` : undefined,
    input.providerId ? `provider ${input.providerId}` : undefined,
    input.configArea ? `config ${input.configArea}` : undefined,
  ].filter(Boolean);
  return `${fragments.join(" · ")}. Validate with replay before apply.`;
}

export function toCapabilityGapEventRow(value: unknown): CapabilityGapEventRow | undefined {
  return isCapabilityGapEventRow(value) ? value : undefined;
}

export function toCapabilityGapEventRows(value: unknown): CapabilityGapEventRow[] {
  return Array.isArray(value) ? value.filter(isCapabilityGapEventRow) : [];
}

export function toRepairCandidateRow(value: unknown): RepairCandidateRow | undefined {
  return isRepairCandidateRow(value) ? value : undefined;
}

export function toRepairCandidateRows(value: unknown): RepairCandidateRow[] {
  return Array.isArray(value) ? value.filter(isRepairCandidateRow) : [];
}

export function isCapabilityGapEventRow(value: unknown): value is CapabilityGapEventRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.event_id === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.turn_id === "string" || value.turn_id === null) &&
    (typeof value.run_id === "string" || value.run_id === null) &&
    typeof value.cause_class === "string" &&
    (typeof value.failure_class === "string" || value.failure_class === null) &&
    (typeof value.prompt_excerpt === "string" || value.prompt_excerpt === null) &&
    (typeof value.prompt_ref === "string" || value.prompt_ref === null) &&
    (typeof value.requested_tool === "string" || value.requested_tool === null) &&
    (typeof value.tool_family === "string" || value.tool_family === null) &&
    (typeof value.tool_profile === "string" || value.tool_profile === null) &&
    (typeof value.policy_reason === "string" || value.policy_reason === null) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.config_area === "string" || value.config_area === null) &&
    (typeof value.suggested_repair_class === "string" || value.suggested_repair_class === null) &&
    typeof value.confidence === "number" &&
    typeof value.repeat_count === "number" &&
    typeof value.recovery_options_json === "string" &&
    (typeof value.replay_run_id === "string" || value.replay_run_id === null) &&
    (typeof value.replay_status === "string" || value.replay_status === null) &&
    (typeof value.repair_candidate_id === "string" || value.repair_candidate_id === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

export function isRepairCandidateRow(value: unknown): value is RepairCandidateRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.candidate_id === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.cause_class === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    (typeof value.requested_tool === "string" || value.requested_tool === null) &&
    (typeof value.tool_profile === "string" || value.tool_profile === null) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.config_area === "string" || value.config_area === null) &&
    (typeof value.suggested_patch === "string" || value.suggested_patch === null) &&
    (typeof value.replay_run_id === "string" || value.replay_run_id === null) &&
    typeof value.validation_status === "string" &&
    (typeof value.validation_summary === "string" || value.validation_summary === null) &&
    typeof value.event_count === "number" &&
    typeof value.confidence === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.last_seen_at === "string"
  );
}

export function buildSuggestedRepairPatch(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  configArea?: string;
}): string | undefined {
  if (!input.configArea) {
    return undefined;
  }
  switch (input.causeClass) {
    case "tool_exists_but_not_in_profile":
      return `Review ${input.configArea} and allow ${input.requestedTool ?? "the blocked tool"} in profile ${input.toolProfile ?? "current"}.`;
    case "tool_requires_approval_but_not_exposed":
      return `Review ${input.configArea} and expose an approval-required path for ${input.requestedTool ?? "the blocked tool"}.`;
    case "skill_missing":
      return `Review ${input.configArea} and add an installable source or workflow for the missing skill capability.`;
    default:
      return `Review ${input.configArea} for the minimal config-only repair.`;
  }
}
