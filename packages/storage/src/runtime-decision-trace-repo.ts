import { randomUUID } from "node:crypto";
import type {
  RuntimeDecisionAlternative,
  RuntimeDecisionEvidenceRef,
  RuntimeDecisionEvidenceRefType,
  RuntimeDecisionKind,
  RuntimeDecisionPrimitive,
  RuntimeDecisionSignal,
  RuntimeDecisionSignalSource,
  RuntimeDecisionSignalWeight,
  RuntimeDecisionTraceAppendInput,
  RuntimeDecisionTraceQuery,
  RuntimeDecisionTraceRecord,
  RuntimeDecisionScope,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

const RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES = 16 * 1024;
const RUNTIME_DECISION_TRACE_LIMITS = {
  maxSignals: 12,
  maxAlternatives: 5,
  maxEvidenceRefs: 12,
  maxStringLength: 1_000,
} as const;

const KNOWN_RUNTIME_DECISION_KINDS = [
  "chat_turn_prepared",
  "memory_context",
  "routing_choice",
  "workflow_choice",
  "direct_answer",
  "execution_plan_created",
  "execution_plan_revised",
  "tool_selected",
  "tool_reused",
  "tool_blocked",
  "tool_approval_required",
  "tool_failed",
  "approval_requested",
  "approval_resolved",
  "approval_expired",
  "runtime_paused",
  "runtime_resumed",
  "orchestration_run_started",
  "orchestration_phase_advanced",
  "durable_checkpoint",
  "orchestration_run_completed",
  "orchestration_run_failed",
  "orchestration_run_cancelled",
  "unknown",
] as const satisfies readonly RuntimeDecisionKind[];

interface RuntimeDecisionTraceRow {
  decision_id: string;
  kind: string;
  citadel_id: string | null;
  workspace_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  plan_id: string | null;
  step_id: string | null;
  tool_run_id: string | null;
  approval_id: string | null;
  task_id: string | null;
  durable_run_id: string | null;
  payload_json: string;
  created_at: string;
}

interface RuntimeDecisionTracePayload {
  selected: string;
  rationale: string;
  alternatives: RuntimeDecisionAlternative[];
  signals: RuntimeDecisionSignal[];
  evidenceRefs: RuntimeDecisionEvidenceRef[];
  previousDecisionId?: string;
  planRevision?: number;
  latencyMs?: number;
}

export class RuntimeDecisionTraceRepository {
  private readonly insertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO runtime_decision_traces (
        decision_id, kind, citadel_id, workspace_id, session_id, turn_id, run_id, plan_id, step_id,
        tool_run_id, approval_id, task_id, durable_run_id, payload_json, created_at
      ) VALUES (
        @decisionId, @kind, @citadelId, @workspaceId, @sessionId, @turnId, @runId, @planId, @stepId,
        @toolRunId, @approvalId, @taskId, @durableRunId, @payloadJson, @createdAt
      )
    `);
  }

  public append(input: RuntimeDecisionTraceAppendInput): RuntimeDecisionTraceRecord {
    const record = sanitizeRecord({
      decisionId: input.decisionId ?? randomUUID(),
      kind: normalizeKind(input.kind),
      scope: normalizeScope(input.scope),
      selected: input.selected,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      signals: input.signals ?? [],
      evidenceRefs: input.evidenceRefs ?? [],
      previousDecisionId: normalizeOptionalString(input.previousDecisionId),
      planRevision: normalizeOptionalNumber(input.planRevision),
      latencyMs: normalizeOptionalNumber(input.latencyMs),
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    const payloadJson = serializePayload(record);
    this.insertStmt.run({
      decisionId: record.decisionId,
      kind: record.kind,
      citadelId: record.scope.citadelId ?? null,
      workspaceId: record.scope.workspaceId ?? null,
      sessionId: record.scope.sessionId ?? null,
      turnId: record.scope.turnId ?? null,
      runId: record.scope.runId ?? null,
      planId: record.scope.planId ?? null,
      stepId: record.scope.stepId ?? null,
      toolRunId: record.scope.toolRunId ?? null,
      approvalId: record.scope.approvalId ?? null,
      taskId: record.scope.taskId ?? null,
      durableRunId: record.scope.durableRunId ?? null,
      payloadJson,
      createdAt: record.createdAt,
    });
    return record;
  }

  public list(query: RuntimeDecisionTraceQuery = {}): RuntimeDecisionTraceRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    addOptionalFilter(clauses, params, "citadel_id", query.citadelId);
    addOptionalFilter(clauses, params, "workspace_id", query.workspaceId);
    addOptionalFilter(clauses, params, "session_id", query.sessionId);
    addOptionalFilter(clauses, params, "turn_id", query.turnId);
    addOptionalFilter(clauses, params, "run_id", query.runId);
    addOptionalFilter(clauses, params, "plan_id", query.planId);
    addOptionalFilter(clauses, params, "step_id", query.stepId);
    addOptionalFilter(clauses, params, "tool_run_id", query.toolRunId);
    addOptionalFilter(clauses, params, "approval_id", query.approvalId);
    addOptionalFilter(clauses, params, "task_id", query.taskId);
    addOptionalFilter(clauses, params, "durable_run_id", query.durableRunId);

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = normalizeLimit(query.limit);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM runtime_decision_traces
        ${whereSql}
        ORDER BY created_at ASC, decision_id ASC
        LIMIT ?
      `,
      )
      .all(...params, limit) as RuntimeDecisionTraceRow[];
    return rows.map(mapRow);
  }

  public deleteBySession(sessionId: string): number {
    const normalized = sessionId.trim();
    if (!normalized) {
      return 0;
    }
    return this.db.prepare("DELETE FROM runtime_decision_traces WHERE session_id = ?").run(normalized).changes;
  }
}

function addOptionalFilter(clauses: string[], params: unknown[], column: string, value: string | undefined): void {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(normalized);
}

function mapRow(row: RuntimeDecisionTraceRow): RuntimeDecisionTraceRecord {
  const kind = normalizeKind(row.kind);
  const scope = normalizeScope({
    citadelId: row.citadel_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    runId: row.run_id ?? undefined,
    planId: row.plan_id ?? undefined,
    stepId: row.step_id ?? undefined,
    toolRunId: row.tool_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    taskId: row.task_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
  });
  const payload = safeJsonParse<unknown>(row.payload_json, undefined);
  if (!isRecord(payload)) {
    return {
      decisionId: row.decision_id,
      kind,
      scope,
      selected: "Decision payload unavailable",
      rationale: "Stored decision payload could not be parsed; indexed linkage columns were preserved.",
      alternatives: [],
      signals: [
        {
          source: "system",
          key: "payload_malformed",
          value: true,
          weight: "informational",
        },
      ],
      evidenceRefs: [],
      createdAt: row.created_at,
    };
  }

  return sanitizeRecord({
    decisionId: row.decision_id,
    kind,
    scope,
    selected: readString(payload.selected) ?? "Decision selected action unavailable",
    rationale: readString(payload.rationale) ?? "Decision rationale unavailable.",
    alternatives: readAlternatives(payload.alternatives),
    signals: readSignals(payload.signals),
    evidenceRefs: readEvidenceRefs(payload.evidenceRefs),
    previousDecisionId: readString(payload.previousDecisionId),
    planRevision: readNumber(payload.planRevision),
    latencyMs: readNumber(payload.latencyMs),
    createdAt: row.created_at,
  });
}

function serializePayload(record: RuntimeDecisionTraceRecord): string {
  const basePayload: RuntimeDecisionTracePayload = {
    selected: record.selected,
    rationale: record.rationale,
    alternatives: record.alternatives,
    signals: record.signals,
    evidenceRefs: record.evidenceRefs,
    previousDecisionId: record.previousDecisionId,
    planRevision: record.planRevision,
    latencyMs: record.latencyMs,
  };
  const baseJson = JSON.stringify(basePayload);
  if (Buffer.byteLength(baseJson, "utf8") <= RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES) {
    return baseJson;
  }

  const truncatedPayload: RuntimeDecisionTracePayload = {
    selected: truncateString(record.selected, 240),
    rationale: truncateString(record.rationale, 512),
    alternatives: record.alternatives.slice(0, 2).map((alternative) => ({
      label: truncateString(alternative.label, 160),
      outcome: alternative.outcome,
      reasonNotChosen: truncateString(alternative.reasonNotChosen, 240),
      blockedBy: truncateOptionalString(alternative.blockedBy, 160),
    })),
    signals: record.signals.slice(0, 4).map((signal) => ({
      source: signal.source,
      key: truncateString(signal.key, 160),
      value: normalizePrimitive(signal.value),
      weight: signal.weight,
      evidence: signal.evidence,
    })),
    evidenceRefs: record.evidenceRefs.slice(0, 4).map((evidence) => ({
      refType: evidence.refType,
      refId: evidence.refId,
      label: truncateOptionalString(evidence.label, 160),
    })),
    previousDecisionId: record.previousDecisionId,
    planRevision: record.planRevision,
    latencyMs: record.latencyMs,
  };
  const truncatedJson = JSON.stringify(truncatedPayload);
  if (Buffer.byteLength(truncatedJson, "utf8") <= RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES) {
    return truncatedJson;
  }

  return JSON.stringify({
    selected: truncateString(record.selected, 160),
    rationale: "Decision payload exceeded the fixed 16 KB budget and was compacted. [truncated]",
    alternatives: [],
    signals: [
      {
        source: "system",
        key: "payload_truncated",
        value: true,
        weight: "informational",
      },
    ],
    evidenceRefs: [],
    previousDecisionId: record.previousDecisionId,
    planRevision: record.planRevision,
    latencyMs: record.latencyMs,
  } satisfies RuntimeDecisionTracePayload);
}

function sanitizeRecord(record: RuntimeDecisionTraceRecord): RuntimeDecisionTraceRecord {
  return {
    decisionId: truncateString(record.decisionId, 128),
    kind: normalizeKind(record.kind),
    scope: normalizeScope(record.scope),
    selected: truncateString(record.selected, RUNTIME_DECISION_TRACE_LIMITS.maxStringLength),
    rationale: truncateString(record.rationale, RUNTIME_DECISION_TRACE_LIMITS.maxStringLength),
    alternatives: sanitizeAlternatives(record.alternatives),
    signals: sanitizeSignals(record.signals),
    evidenceRefs: sanitizeEvidenceRefs(record.evidenceRefs),
    previousDecisionId: truncateOptionalString(record.previousDecisionId, 128),
    planRevision: normalizeOptionalNumber(record.planRevision),
    latencyMs: normalizeOptionalNumber(record.latencyMs),
    createdAt: truncateString(record.createdAt, 64),
  };
}

function sanitizeAlternatives(alternatives: RuntimeDecisionAlternative[]): RuntimeDecisionAlternative[] {
  return alternatives.slice(0, RUNTIME_DECISION_TRACE_LIMITS.maxAlternatives).map((alternative) => ({
    label: truncateString(alternative.label, 320),
    outcome: normalizeAlternativeOutcome(alternative.outcome),
    reasonNotChosen: truncateString(alternative.reasonNotChosen, 640),
    blockedBy: truncateOptionalString(alternative.blockedBy, 320),
  }));
}

function sanitizeSignals(signals: RuntimeDecisionSignal[]): RuntimeDecisionSignal[] {
  return signals.slice(0, RUNTIME_DECISION_TRACE_LIMITS.maxSignals).map((signal) => ({
    source: normalizeSignalSource(signal.source),
    key: truncateString(signal.key, 320),
    value: normalizePrimitive(signal.value),
    weight: normalizeSignalWeight(signal.weight),
    evidence: signal.evidence ? sanitizeEvidenceRef(signal.evidence) : undefined,
  }));
}

function sanitizeEvidenceRefs(evidenceRefs: RuntimeDecisionEvidenceRef[]): RuntimeDecisionEvidenceRef[] {
  return evidenceRefs.slice(0, RUNTIME_DECISION_TRACE_LIMITS.maxEvidenceRefs).map(sanitizeEvidenceRef);
}

function sanitizeEvidenceRef(evidence: RuntimeDecisionEvidenceRef): RuntimeDecisionEvidenceRef {
  return {
    refType: normalizeEvidenceRefType(evidence.refType),
    refId: truncateString(evidence.refId, 320),
    label: truncateOptionalString(evidence.label, 320),
  };
}

function normalizeScope(scope: RuntimeDecisionScope): RuntimeDecisionScope {
  return {
    citadelId: normalizeOptionalString(scope.citadelId),
    workspaceId: normalizeOptionalString(scope.workspaceId),
    sessionId: normalizeOptionalString(scope.sessionId),
    turnId: normalizeOptionalString(scope.turnId),
    runId: normalizeOptionalString(scope.runId),
    planId: normalizeOptionalString(scope.planId),
    stepId: normalizeOptionalString(scope.stepId),
    toolRunId: normalizeOptionalString(scope.toolRunId),
    approvalId: normalizeOptionalString(scope.approvalId),
    taskId: normalizeOptionalString(scope.taskId),
    durableRunId: normalizeOptionalString(scope.durableRunId),
  };
}

function normalizeLimit(limit: number | undefined): number {
  const safeLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : 100;
  return Math.max(1, Math.min(Math.floor(safeLimit), 500));
}

function normalizeKind(kind: string): RuntimeDecisionKind {
  return (KNOWN_RUNTIME_DECISION_KINDS as readonly string[]).includes(kind) ? (kind as RuntimeDecisionKind) : "unknown";
}

function normalizeSignalSource(source: string): RuntimeDecisionSignalSource {
  return SIGNAL_SOURCES.has(source) ? (source as RuntimeDecisionSignalSource) : "system";
}

function normalizeSignalWeight(weight: string | undefined): RuntimeDecisionSignalWeight | undefined {
  return weight && SIGNAL_WEIGHTS.has(weight) ? (weight as RuntimeDecisionSignalWeight) : undefined;
}

function normalizeEvidenceRefType(refType: string): RuntimeDecisionEvidenceRefType {
  return EVIDENCE_REF_TYPES.has(refType) ? (refType as RuntimeDecisionEvidenceRefType) : "event";
}

function normalizeAlternativeOutcome(outcome: string): RuntimeDecisionAlternative["outcome"] {
  return ALTERNATIVE_OUTCOMES.has(outcome) ? (outcome as RuntimeDecisionAlternative["outcome"]) : "not_chosen";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncateOptionalString(value: string | undefined, maxLength: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? truncateString(normalized, maxLength) : undefined;
}

function truncateString(value: string, maxLength: number): string {
  const normalized = String(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const suffix = " [truncated]";
  const sliceLength = Math.max(0, maxLength - suffix.length);
  return `${normalized.slice(0, sliceLength)}${suffix}`;
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePrimitive(value: RuntimeDecisionPrimitive | undefined): RuntimeDecisionPrimitive | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return truncateString(value, 640);
}

function readAlternatives(value: unknown): RuntimeDecisionAlternative[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return sanitizeAlternatives(
    value.filter(isRecord).map((item) => ({
      label: readString(item.label) ?? "Alternative",
      outcome: normalizeAlternativeOutcome(readString(item.outcome) ?? "not_chosen"),
      reasonNotChosen: readString(item.reasonNotChosen) ?? "No reason recorded.",
      blockedBy: readString(item.blockedBy),
    })),
  );
}

function readSignals(value: unknown): RuntimeDecisionSignal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return sanitizeSignals(
    value.filter(isRecord).map((item) => ({
      source: normalizeSignalSource(readString(item.source) ?? "system"),
      key: readString(item.key) ?? "unknown",
      value: readPrimitive(item.value),
      weight: normalizeSignalWeight(readString(item.weight)),
      evidence: readEvidenceRef(item.evidence),
    })),
  );
}

function readEvidenceRefs(value: unknown): RuntimeDecisionEvidenceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return sanitizeEvidenceRefs(value.map(readEvidenceRef).filter((item): item is RuntimeDecisionEvidenceRef => !!item));
}

function readEvidenceRef(value: unknown): RuntimeDecisionEvidenceRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const refId = readString(value.refId);
  if (!refId) {
    return undefined;
  }
  return sanitizeEvidenceRef({
    refType: normalizeEvidenceRefType(readString(value.refType) ?? "event"),
    refId,
    label: readString(value.label),
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPrimitive(value: unknown): RuntimeDecisionPrimitive | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIGNAL_SOURCES = new Set<string>([
  "policy",
  "capability",
  "memory",
  "routing",
  "operator_pref",
  "durable",
  "tool_result",
  "model_router",
  "context",
  "orchestration",
  "approval",
  "execution_plan",
  "system",
]);

const SIGNAL_WEIGHTS = new Set<string>(["blocking", "strong", "weak", "informational"]);

const EVIDENCE_REF_TYPES = new Set<string>([
  "turn",
  "session",
  "run",
  "plan",
  "step",
  "tool_run",
  "approval",
  "checkpoint",
  "event",
  "memory",
  "capability_snapshot",
  "durable_run",
  "task",
]);

const ALTERNATIVE_OUTCOMES = new Set<string>(["not_chosen", "blocked", "deferred", "fallback"]);
