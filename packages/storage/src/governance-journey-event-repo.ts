import { ConflictError, NotFoundError, canonicalJsonString } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export type GovernanceJourneyScopeKind = "workspace" | "global";
export type GovernanceJourneyActorType = "operator" | "system" | "approval_effect";
export type GovernanceJourneyPoisoningStatus = "clean" | "blocked" | "quarantined" | "conflicting";

export interface GovernanceJourneyEvidenceRef {
  owner: "artifact" | "approval" | "candidate" | "evaluation" | "memory_history" | "upstream_snapshot";
  refId: string;
}

export interface GovernanceJourneyEventRecord {
  schemaVersion: "goatcitadel.journey-event.v1";
  eventId: string;
  idempotencyKey: string;
  scopeKind: GovernanceJourneyScopeKind;
  workspaceId?: string;
  eventType: string;
  subjectKind: string;
  subjectId: string;
  action: string;
  actorId: string;
  actorType: GovernanceJourneyActorType;
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  fingerprint?: string;
  sourceKind?: string;
  sourceId?: string;
  trustDisposition?: string;
  poisoningStatus?: GovernanceJourneyPoisoningStatus;
  evidenceRefs: GovernanceJourneyEvidenceRef[];
  provenance: Record<string, unknown>;
  summary: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export interface GovernanceJourneyPosition {
  recordedAt: string;
  eventId: string;
}

export interface GovernanceJourneyListInput {
  workspaceId: string;
  includeGlobal?: boolean;
  eventTypes?: string[];
  subjectKinds?: string[];
  actions?: string[];
  subjectId?: string;
  fingerprint?: string;
  sessionId?: string;
  trustDispositions?: string[];
  poisoningStatuses?: GovernanceJourneyPoisoningStatus[];
  highWater?: GovernanceJourneyPosition;
  position?: GovernanceJourneyPosition;
  limit?: number;
}

export interface GovernanceJourneyPage {
  items: GovernanceJourneyEventRecord[];
  highWater?: GovernanceJourneyPosition;
  nextPosition?: GovernanceJourneyPosition;
}

interface GovernanceJourneyEventRow {
  schema_version: "goatcitadel.journey-event.v1";
  event_id: string;
  idempotency_key: string;
  scope_kind: GovernanceJourneyScopeKind;
  workspace_id: string | null;
  event_type: string;
  subject_kind: string;
  subject_id: string;
  action: string;
  actor_id: string;
  actor_type: GovernanceJourneyActorType;
  session_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  fingerprint: string | null;
  source_kind: string | null;
  source_id: string | null;
  trust_disposition: string | null;
  poisoning_status: GovernanceJourneyPoisoningStatus | null;
  evidence_refs_json: string;
  provenance_json: string;
  summary_json: string;
  occurred_at: string;
  recorded_at: string;
}

interface GovernanceJourneyPositionRow {
  recorded_at: string;
  event_id: string;
}

export class GovernanceJourneyEventRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByIdempotencyKeyStmt;
  private readonly highWaterStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO governance_journey_events (
        schema_version, event_id, idempotency_key, scope_kind, workspace_id, event_type,
        subject_kind, subject_id, action, actor_id, actor_type, session_id, turn_id,
        approval_id, fingerprint, source_kind, source_id, trust_disposition, poisoning_status,
        evidence_refs_json, provenance_json, summary_json, occurred_at, recorded_at
      ) VALUES (
        @schemaVersion, @eventId, @idempotencyKey, @scopeKind, @workspaceId, @eventType,
        @subjectKind, @subjectId, @action, @actorId, @actorType, @sessionId, @turnId,
        @approvalId, @fingerprint, @sourceKind, @sourceId, @trustDisposition, @poisoningStatus,
        @evidenceRefsJson, @provenanceJson, @summaryJson, @occurredAt, @recordedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM governance_journey_events WHERE event_id = ?");
    this.getByIdempotencyKeyStmt = db.prepare("SELECT * FROM governance_journey_events WHERE idempotency_key = ?");
    this.highWaterStmt = db.prepare(`
      SELECT recorded_at, event_id
      FROM governance_journey_events
      WHERE (
        (scope_kind = 'workspace' AND workspace_id = @workspaceId)
        OR (@includeGlobal = 1 AND scope_kind = 'global' AND workspace_id IS NULL)
      )
      ORDER BY recorded_at DESC, event_id DESC
      LIMIT 1
    `);
  }

  public create(input: GovernanceJourneyEventRecord): GovernanceJourneyEventRecord {
    validateEvent(input);
    this.insertStmt.run(toBindings(input));
    const stored = this.findByIdempotencyKey(input.idempotencyKey) ?? this.find(input.eventId);
    if (!stored) throw new Error(`Governance Journey event ${input.eventId} was not persisted.`);
    assertImmutableReplay(stored, input);
    return stored;
  }

  public get(eventId: string): GovernanceJourneyEventRecord {
    const found = this.find(eventId);
    if (!found) throw new NotFoundError({ entity: "governance Journey event", id: eventId });
    return found;
  }

  public find(eventId: string): GovernanceJourneyEventRecord | undefined {
    assertCanonicalIdentity(eventId, "event ID", 256);
    const row = this.getStmt.get(eventId) as GovernanceJourneyEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public findByIdempotencyKey(idempotencyKey: string): GovernanceJourneyEventRecord | undefined {
    assertCanonicalIdentity(idempotencyKey, "idempotency key", 512);
    const row = this.getByIdempotencyKeyStmt.get(idempotencyKey) as GovernanceJourneyEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public findScoped(
    eventId: string,
    workspaceId: string,
    includeGlobal = false,
  ): GovernanceJourneyEventRecord | undefined {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    const event = this.find(eventId);
    if (!event) return undefined;
    if (event.scopeKind === "global") return includeGlobal ? event : undefined;
    return event.workspaceId === workspaceId ? event : undefined;
  }

  public captureHighWater(workspaceId: string, includeGlobal = false): GovernanceJourneyPosition | undefined {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    const row = this.highWaterStmt.get({
      workspaceId,
      includeGlobal: includeGlobal ? 1 : 0,
    }) as GovernanceJourneyPositionRow | undefined;
    return row ? { recordedAt: row.recorded_at, eventId: row.event_id } : undefined;
  }

  public listPage(input: GovernanceJourneyListInput): GovernanceJourneyPage {
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
    const highWater = input.highWater ?? this.captureHighWater(input.workspaceId, input.includeGlobal === true);
    if (!highWater) return { items: [] };
    validatePosition(highWater, "high-water");
    if (input.position) {
      validatePosition(input.position, "cursor");
      if (comparePositions(input.position, highWater) > 0) {
        throw new TypeError("Journey cursor position cannot be newer than its high-water mark.");
      }
    }

    const limit = normalizeLimit(input.limit);
    const bindings: Record<string, unknown> = {
      workspaceId: input.workspaceId,
      includeGlobal: input.includeGlobal === true ? 1 : 0,
      highWaterRecordedAt: highWater.recordedAt,
      highWaterEventId: highWater.eventId,
      limit: limit + 1,
    };
    const conditions = [
      `(
        (scope_kind = 'workspace' AND workspace_id = @workspaceId)
        OR (@includeGlobal = 1 AND scope_kind = 'global' AND workspace_id IS NULL)
      )`,
      `(recorded_at < @highWaterRecordedAt OR (recorded_at = @highWaterRecordedAt AND event_id <= @highWaterEventId))`,
    ];
    if (input.position) {
      conditions.push(
        `(recorded_at < @positionRecordedAt OR (recorded_at = @positionRecordedAt AND event_id < @positionEventId))`,
      );
      bindings.positionRecordedAt = input.position.recordedAt;
      bindings.positionEventId = input.position.eventId;
    }
    addListFilter(conditions, bindings, "event_type", "eventType", input.eventTypes, 128);
    addListFilter(conditions, bindings, "subject_kind", "subjectKind", input.subjectKinds, 128);
    addListFilter(conditions, bindings, "action", "action", input.actions, 128);
    addListFilter(conditions, bindings, "trust_disposition", "trustDisposition", input.trustDispositions, 128);
    if (input.poisoningStatuses?.some((status) => !isPoisoningStatus(status))) {
      throw new TypeError("Journey poisoning-status filter contains an unsupported value.");
    }
    addListFilter(conditions, bindings, "poisoning_status", "poisoningStatus", input.poisoningStatuses, 32);
    addSingleFilter(conditions, bindings, "subject_id", "subjectId", input.subjectId, 256);
    addSingleFilter(conditions, bindings, "fingerprint", "fingerprint", input.fingerprint, 64);
    addSingleFilter(conditions, bindings, "session_id", "sessionId", input.sessionId, 256);

    const statement = this.db.prepare(`
      SELECT * FROM governance_journey_events
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY recorded_at DESC, event_id DESC
      LIMIT @limit
    `);
    const rows = statement.all(bindings) as unknown as GovernanceJourneyEventRow[];
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map(mapRow);
    const last = items.at(-1);
    return {
      items,
      highWater,
      nextPosition: hasNext && last ? { recordedAt: last.recordedAt, eventId: last.eventId } : undefined,
    };
  }
}

function toBindings(input: GovernanceJourneyEventRecord): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    scopeKind: input.scopeKind,
    workspaceId: input.workspaceId ?? null,
    eventType: input.eventType,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    action: input.action,
    actorId: input.actorId,
    actorType: input.actorType,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    approvalId: input.approvalId ?? null,
    fingerprint: input.fingerprint ?? null,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    trustDisposition: input.trustDisposition ?? null,
    poisoningStatus: input.poisoningStatus ?? null,
    evidenceRefsJson: canonicalJsonString(normalizeEvidenceRefs(input.evidenceRefs)),
    provenanceJson: canonicalJsonString(input.provenance),
    summaryJson: canonicalJsonString(input.summary),
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
  };
}

function mapRow(row: GovernanceJourneyEventRow): GovernanceJourneyEventRecord {
  const record: GovernanceJourneyEventRecord = {
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    scopeKind: row.scope_kind,
    workspaceId: row.workspace_id ?? undefined,
    eventType: row.event_type,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    fingerprint: row.fingerprint ?? undefined,
    sourceKind: row.source_kind ?? undefined,
    sourceId: row.source_id ?? undefined,
    trustDisposition: row.trust_disposition ?? undefined,
    poisoningStatus: row.poisoning_status ?? undefined,
    evidenceRefs: parseEvidenceRefs(row.evidence_refs_json),
    provenance: parseObject(row.provenance_json, "provenance"),
    summary: parseObject(row.summary_json, "summary"),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  validateEvent(record);
  return record;
}

function validateEvent(input: GovernanceJourneyEventRecord): void {
  if (input.schemaVersion !== "goatcitadel.journey-event.v1")
    throw new TypeError("Unsupported Journey schema version.");
  assertCanonicalIdentity(input.eventId, "event ID", 256);
  assertCanonicalIdentity(input.idempotencyKey, "idempotency key", 512);
  if (input.scopeKind === "workspace") {
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  } else if (input.scopeKind === "global") {
    if (input.workspaceId !== undefined) throw new TypeError("Global Journey events cannot claim a workspace ID.");
  } else {
    throw new TypeError("Unsupported Journey scope kind.");
  }
  assertCanonicalIdentity(input.eventType, "event type", 128);
  assertCanonicalIdentity(input.subjectKind, "subject kind", 128);
  assertCanonicalIdentity(input.subjectId, "subject ID", 256);
  assertCanonicalIdentity(input.action, "action", 128);
  assertCanonicalIdentity(input.actorId, "actor ID", 256);
  if (input.actorType !== "operator" && input.actorType !== "system" && input.actorType !== "approval_effect") {
    throw new TypeError("Unsupported Journey actor type.");
  }
  validateOptionalCanonical(input.sessionId, "session ID", 256);
  validateOptionalCanonical(input.turnId, "turn ID", 256);
  validateOptionalCanonical(input.approvalId, "approval ID", 256);
  validateOptionalCanonical(input.sourceKind, "source kind", 128);
  validateOptionalCanonical(input.sourceId, "source ID", 256);
  validateOptionalCanonical(input.trustDisposition, "trust disposition", 128);
  if (input.fingerprint && !/^[a-f0-9]{64}$/u.test(input.fingerprint)) {
    throw new TypeError("Journey fingerprint must be SHA-256 hex.");
  }
  if (input.poisoningStatus !== undefined && !isPoisoningStatus(input.poisoningStatus)) {
    throw new TypeError("Unsupported Journey poisoning status.");
  }
  normalizeEvidenceRefs(input.evidenceRefs);
  assertBoundedContentFreeMetadata(input.provenance, "provenance");
  assertBoundedContentFreeMetadata(input.summary, "summary");
  validateTimestamp(input.occurredAt, "occurred-at");
  validateTimestamp(input.recordedAt, "recorded-at");
}

function normalizeEvidenceRefs(input: readonly GovernanceJourneyEvidenceRef[]): GovernanceJourneyEvidenceRef[] {
  if (!Array.isArray(input) || input.length > 64) throw new TypeError("Journey evidence references are bounded to 64.");
  const byKey = new Map<string, GovernanceJourneyEvidenceRef>();
  for (const item of input) {
    if (
      !item ||
      !new Set(["artifact", "approval", "candidate", "evaluation", "memory_history", "upstream_snapshot"]).has(
        item.owner,
      )
    ) {
      throw new TypeError("Journey evidence reference has an unsupported owner.");
    }
    assertCanonicalIdentity(item.refId, "evidence reference ID", 256);
    if (Object.keys(item).some((key) => key !== "owner" && key !== "refId")) {
      throw new TypeError("Journey evidence references cannot embed payload content.");
    }
    byKey.set(`${item.owner}:${item.refId}`, { owner: item.owner, refId: item.refId });
  }
  return [...byKey.values()].sort((left, right) =>
    compareStrings(`${left.owner}:${left.refId}`, `${right.owner}:${right.refId}`),
  );
}

function parseEvidenceRefs(value: string): GovernanceJourneyEvidenceRef[] {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!Array.isArray(parsed)) throw new Error("Journey event contains malformed evidence reference JSON.");
  return normalizeEvidenceRefs(parsed as GovernanceJourneyEvidenceRef[]);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, undefined);
  assertBoundedContentFreeMetadata(parsed, label);
  return parsed;
}

function assertImmutableReplay(stored: GovernanceJourneyEventRecord, attempted: GovernanceJourneyEventRecord): void {
  const normalizedAttempt = {
    ...attempted,
    workspaceId: attempted.workspaceId ?? undefined,
    sessionId: attempted.sessionId ?? undefined,
    turnId: attempted.turnId ?? undefined,
    approvalId: attempted.approvalId ?? undefined,
    fingerprint: attempted.fingerprint ?? undefined,
    sourceKind: attempted.sourceKind ?? undefined,
    sourceId: attempted.sourceId ?? undefined,
    trustDisposition: attempted.trustDisposition ?? undefined,
    poisoningStatus: attempted.poisoningStatus ?? undefined,
    evidenceRefs: normalizeEvidenceRefs(attempted.evidenceRefs),
  };
  if (canonicalJsonString(stored) !== canonicalJsonString(normalizedAttempt)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Governance Journey event ${attempted.eventId} conflicts with an existing immutable record.`,
    });
  }
}

function addListFilter(
  conditions: string[],
  bindings: Record<string, unknown>,
  column: string,
  bindingPrefix: string,
  values: readonly string[] | undefined,
  maxLength: number,
): void {
  if (!values?.length) return;
  if (values.length > 64) throw new TypeError("Journey list filters are bounded to 64 values.");
  const unique = [...new Set(values.map((value) => normalizeFilterValue(value, maxLength)))].sort(compareStrings);
  const placeholders = unique.map((value, index) => {
    const key = `${bindingPrefix}${index}`;
    bindings[key] = value;
    return `@${key}`;
  });
  conditions.push(`${column} IN (${placeholders.join(", ")})`);
}

function addSingleFilter(
  conditions: string[],
  bindings: Record<string, unknown>,
  column: string,
  binding: string,
  value: string | undefined,
  maxLength: number,
): void {
  if (value === undefined) return;
  bindings[binding] = normalizeFilterValue(value, maxLength);
  conditions.push(`${column} = @${binding}`);
}

function validatePosition(input: GovernanceJourneyPosition, label: string): void {
  validateTimestamp(input.recordedAt, `${label} timestamp`);
  assertCanonicalIdentity(input.eventId, `${label} event ID`, 256);
}

function comparePositions(left: GovernanceJourneyPosition, right: GovernanceJourneyPosition): number {
  const time = compareStrings(left.recordedAt, right.recordedAt);
  return time === 0 ? compareStrings(left.eventId, right.eventId) : time;
}

function validateTimestamp(value: string, label: string): void {
  const canonical = (() => {
    try {
      return typeof value === "string" && new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  })();
  if (!canonical) {
    throw new TypeError(`Journey ${label} must be a canonical ISO timestamp.`);
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(Math.trunc(value), 500));
}

function normalizeFilterValue(value: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError("Journey filter values must be strings.");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError("Journey filter value is missing or too long.");
  }
  return normalized;
}

function isPoisoningStatus(value: unknown): value is GovernanceJourneyPoisoningStatus {
  return value === "clean" || value === "blocked" || value === "quarantined" || value === "conflicting";
}

function validateOptionalCanonical(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertCanonicalIdentity(value, label, maxLength);
}

function assertBounded(value: string | undefined, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Journey ${label} is missing or too long.`);
  }
}

function assertCanonicalIdentity(value: string | undefined, label: string, maxLength: number): asserts value is string {
  assertBounded(value, label, maxLength);
  if (value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Journey ${label} must use its canonical identity form.`);
  }
}

function assertBoundedContentFreeMetadata(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Journey ${label} must be an object.`);
  }
  const counter = { entries: 0 };
  inspectMetadata(value, 0, counter, label);
  if (Buffer.byteLength(canonicalJsonString(value), "utf8") > 16_384) {
    throw new TypeError(`Journey ${label} exceeds the canonical byte limit.`);
  }
}

function inspectMetadata(value: unknown, depth: number, counter: { entries: number }, label: string): void {
  if (depth > 6) throw new TypeError(`Journey ${label} exceeds the nesting depth limit.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Journey ${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_048) throw new TypeError(`Journey ${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    counter.entries += value.length;
    assertEntryBudget(counter, label);
    for (const item of value) inspectMetadata(item, depth + 1, counter, label);
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError(`Journey ${label} contains an unsupported value.`);
  const entries = Object.entries(value);
  counter.entries += entries.length;
  assertEntryBudget(counter, label);
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || FORBIDDEN_METADATA_KEYS.has(normalizeMetadataKey(key))) {
      throw new TypeError(`Journey ${label} contains forbidden or invalid key '${key}'.`);
    }
    inspectMetadata(item, depth + 1, counter, label);
  }
}

function assertEntryBudget(counter: { entries: number }, label: string): void {
  if (counter.entries > 128) throw new TypeError(`Journey ${label} exceeds the entry limit.`);
}

function normalizeMetadataKey(key: string): string {
  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

const FORBIDDEN_METADATA_KEYS = new Set([
  "apikey",
  "authorization",
  "body",
  "content",
  "cookie",
  "cookies",
  "correctedbehavior",
  "credential",
  "credentials",
  "message",
  "messages",
  "password",
  "plaintext",
  "privatekey",
  "prompt",
  "raw",
  "rawcontent",
  "rawtext",
  "response",
  "secret",
  "secrets",
  "sourcetext",
  "text",
  "token",
  "tokens",
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
