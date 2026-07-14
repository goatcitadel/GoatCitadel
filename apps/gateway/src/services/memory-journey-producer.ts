import { createHash } from "node:crypto";
import {
  ConflictError,
  canonicalJsonString,
  isGovernanceJourneyEventRecord,
  type GovernanceJourneyEventRecord,
  type MemoryChangeEvent,
  type MemoryItemRecord,
} from "@goatcitadel/contracts";

export const MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION = "goatcitadel.memory-lifecycle-approval.v1" as const;
export const MEMORY_LIFECYCLE_REQUEST_VERSION = "goatcitadel.memory-lifecycle-request.v1" as const;
const MEMORY_HISTORY_PROVENANCE_OWNER = "memory_change_history" as const;

export type MemoryJourneySubjectKind = "memory_item" | "memory_item_batch";
export type MemoryJourneyApprovalAction = "item_updated" | "items_forgotten" | "batch_mutated";
export type MemoryJourneyEventAction = "item_updated" | "pin_changed" | "ttl_changed" | "forgotten" | "batch_mutated";

export interface ApprovedMemoryMutationContext {
  /** A resolved, canonical `memory.lifecycle` approval. Caller assertions are never sufficient. */
  approvalId: string;
}

export interface MemoryLifecycleApprovalBindingV1 {
  schemaVersion: typeof MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION;
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  subjectKind: MemoryJourneySubjectKind;
  subjectId?: string;
  action: MemoryJourneyApprovalAction;
  requestSha256: string;
  expectedStateSha256: string;
  correctionActionId?: string;
}

export interface ApprovedMemoryMutationAuthority {
  approvalId: string;
  actorId: string;
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  occurredAt: string;
  requestSha256: string;
  expectedStateSha256: string;
  correctionActionId?: string;
}

export interface MemoryJourneySql {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
}

interface ApprovalRow {
  approval_id: string;
  kind: string;
  status: string;
  linkage_json: string | null;
  payload_json: string;
  expires_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface JourneyRow {
  schema_version: string;
  event_id: string;
  idempotency_key: string;
  scope_kind: "workspace" | "global";
  workspace_id: string | null;
  event_type: string;
  subject_kind: string;
  subject_id: string;
  action: string;
  actor_id: string;
  actor_type: "operator" | "system" | "approval_effect";
  session_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  fingerprint: string | null;
  source_kind: string | null;
  source_id: string | null;
  trust_disposition: string | null;
  poisoning_status: "clean" | "blocked" | "quarantined" | "conflicting" | null;
  evidence_refs_json: string;
  provenance_json: string;
  summary_json: string;
  occurred_at: string;
  recorded_at: string;
}

export function buildMemoryLifecycleRequestSha256(input: {
  workspaceId: string;
  subjectKind: MemoryJourneySubjectKind;
  subjectId?: string;
  action: MemoryJourneyApprovalAction;
  mutation: unknown;
}): string {
  const material = canonicalJsonString({
    schemaVersion: MEMORY_LIFECYCLE_REQUEST_VERSION,
    workspaceId: requireCanonicalId(input.workspaceId, "workspace ID"),
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ? requireCanonicalId(input.subjectId, "subject ID") : null,
    action: input.action,
    mutation: input.mutation,
  });
  if (Buffer.byteLength(material, "utf8") > 1_048_576) {
    throw new TypeError("Approved memory mutation material exceeds the one-megabyte hash boundary.");
  }
  return sha256(material);
}

export function buildMemoryLifecycleStateSha256(state: unknown): string {
  const material = canonicalJsonString({ schemaVersion: "goatcitadel.memory-lifecycle-state.v1", state });
  if (Buffer.byteLength(material, "utf8") > 1_048_576) {
    throw new TypeError("Approved memory state material exceeds the one-megabyte hash boundary.");
  }
  return sha256(material);
}

export function buildMemoryItemApprovalStateMaterial(item: MemoryItemRecord): Record<string, unknown> {
  return {
    itemId: item.itemId,
    workspaceId: item.workspaceId ?? null,
    namespace: item.namespace,
    titleSha256: sha256(canonicalJsonString(item.title)),
    contentSha256: sha256(canonicalJsonString(item.content)),
    metadataSha256: sha256(canonicalJsonString(item.metadata)),
    pinned: item.pinned,
    ttlOverrideSeconds: item.ttlOverrideSeconds ?? null,
    expiresAt: item.expiresAt ?? null,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    forgottenAt: item.forgottenAt ?? null,
  };
}

export function buildMemoryItemsApprovalStateMaterial(items: readonly MemoryItemRecord[]): Record<string, unknown> {
  const canonicalItems = [...items]
    .sort((left, right) => compareStrings(left.itemId, right.itemId))
    .map(buildMemoryItemApprovalStateMaterial);
  return {
    itemCount: canonicalItems.length,
    itemsSha256: sha256(canonicalJsonString(canonicalItems)),
  };
}

export function buildMemoryLifecycleApprovalBinding(input: {
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  subjectKind: MemoryJourneySubjectKind;
  subjectId?: string;
  action: MemoryJourneyApprovalAction;
  mutation: unknown;
  expectedState: unknown;
  correctionActionId?: string;
}): MemoryLifecycleApprovalBindingV1 {
  return {
    schemaVersion: MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION,
    workspaceId: requireCanonicalId(input.workspaceId, "workspace ID"),
    sessionId: input.sessionId ? requireCanonicalId(input.sessionId, "session ID") : undefined,
    turnId: input.turnId ? requireCanonicalId(input.turnId, "turn ID") : undefined,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ? requireCanonicalId(input.subjectId, "subject ID") : undefined,
    action: input.action,
    requestSha256: buildMemoryLifecycleRequestSha256(input),
    expectedStateSha256: buildMemoryLifecycleStateSha256(input.expectedState),
    correctionActionId: input.correctionActionId
      ? requireCanonicalId(input.correctionActionId, "correction action ID")
      : undefined,
  };
}

/** Resolve and lock the real approval from canonical storage inside the owning transaction. */
export function resolveApprovedMemoryMutation(
  sql: MemoryJourneySql,
  input: {
    context: ApprovedMemoryMutationContext;
    workspaceId: string;
    actorId: string;
    subjectKind: MemoryJourneySubjectKind;
    subjectId?: string;
    action: MemoryJourneyApprovalAction;
    requestSha256: string;
  },
): ApprovedMemoryMutationAuthority {
  const approvalId = requireCanonicalId(input.context.approvalId, "approval ID");
  const workspaceId = requireCanonicalId(input.workspaceId, "workspace ID");
  const actorId = requireCanonicalId(input.actorId, "actor ID");
  const lockClause = sql.dialect === "postgres" ? " FOR UPDATE" : "";
  const row = sql
    .prepare(
      `SELECT approval_id, kind, status, linkage_json, payload_json, expires_at, resolved_at, resolved_by
       FROM approvals
       WHERE approval_id = @approvalId${lockClause}`,
    )
    .get({ approvalId }) as ApprovalRow | undefined;
  if (!row) failAuthority();

  const linkage = parseRecord(row.linkage_json);
  const payload = parseRecord(row.payload_json);
  const binding = parseBinding(payload?.memoryLifecycle);
  const resolvedAt = canonicalTimestamp(row.resolved_at);
  const expiresAt = row.expires_at === null ? undefined : canonicalTimestamp(row.expires_at);
  const resolvedBy = optionalCanonicalId(row.resolved_by);
  if (
    row.approval_id !== approvalId ||
    row.kind !== "memory.lifecycle" ||
    row.status !== "approved" ||
    (row.expires_at !== null && !expiresAt) ||
    (expiresAt !== undefined && resolvedAt !== undefined && Date.parse(resolvedAt) >= Date.parse(expiresAt)) ||
    linkage?.workspaceId !== workspaceId ||
    !resolvedAt ||
    resolvedBy !== actorId ||
    !binding ||
    binding.workspaceId !== workspaceId ||
    binding.subjectKind !== input.subjectKind ||
    binding.subjectId !== input.subjectId ||
    binding.action !== input.action ||
    binding.requestSha256 !== input.requestSha256
  ) {
    failAuthority();
  }

  const sessionId = optionalCanonicalId(linkage.sessionId);
  const turnId = optionalCanonicalId(linkage.turnId);
  if (
    (linkage.sessionId !== undefined && !sessionId) ||
    (linkage.turnId !== undefined && !turnId) ||
    sessionId !== binding.sessionId ||
    turnId !== binding.turnId
  ) {
    failAuthority();
  }
  return {
    approvalId,
    actorId: resolvedBy,
    workspaceId,
    sessionId,
    turnId,
    occurredAt: resolvedAt,
    requestSha256: binding.requestSha256,
    expectedStateSha256: binding.expectedStateSha256,
    correctionActionId: binding.correctionActionId,
  };
}

export function deriveApprovedMemoryHistoryId(input: {
  approvalId: string;
  subjectId: string;
  action: MemoryJourneyEventAction;
  ordinal?: number;
}): string {
  return `memory-history:${sha256(
    canonicalJsonString({
      schemaVersion: "goatcitadel.memory-history-identity.v1",
      approvalId: requireCanonicalId(input.approvalId, "approval ID"),
      subjectId: requireCanonicalId(input.subjectId, "subject ID"),
      action: input.action,
      ordinal: input.ordinal ?? 0,
    }),
  )}`;
}

export function persistApprovedMemoryJourney(
  sql: MemoryJourneySql,
  input: {
    authority: ApprovedMemoryMutationAuthority;
    change: MemoryChangeEvent;
    subjectId: string;
    action: MemoryJourneyEventAction;
    lifecycleState: string;
    fieldCodes?: string[];
    batchOperationIndex?: number;
  },
): GovernanceJourneyEventRecord {
  const subjectId = requireCanonicalId(input.subjectId, "subject ID");
  if (
    input.change.itemId !== subjectId ||
    input.change.actorId !== input.authority.actorId ||
    input.change.createdAt !== input.authority.occurredAt ||
    !isHistoryActionPair(input.change.changeType, input.action)
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Approved memory history does not match its immutable authority.",
    });
  }
  const eventId = `memory:journey:${input.change.changeId}`;
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId,
    idempotencyKey: `memory:lifecycle:${input.change.changeId}:${input.action}`,
    scopeKind: "workspace",
    workspaceId: input.authority.workspaceId,
    eventType: "memory_item_lifecycle",
    subjectKind: "memory_item",
    subjectId,
    action: input.action,
    actorId: input.authority.actorId,
    actorType: "operator",
    sessionId: input.authority.sessionId,
    turnId: input.authority.turnId,
    approvalId: input.authority.approvalId,
    fingerprint: input.authority.requestSha256,
    sourceKind: MEMORY_HISTORY_PROVENANCE_OWNER,
    sourceId: input.change.changeId,
    trustDisposition: "approved_memory_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.authority.approvalId },
      { owner: "memory_history", refId: input.change.changeId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.authority.requestSha256,
      historyOwner: MEMORY_HISTORY_PROVENANCE_OWNER,
      correctionProvenance: input.authority.correctionActionId ? "explicit" : "not_applicable",
      ...(input.authority.correctionActionId ? { correctionActionId: input.authority.correctionActionId } : {}),
      ...(input.batchOperationIndex === undefined ? {} : { batchOperationIndex: input.batchOperationIndex }),
    },
    summary: {
      changeType: input.change.changeType,
      lifecycleState: requireCanonicalId(input.lifecycleState, "lifecycle state"),
      fieldCodes: normalizeFieldCodes(input.fieldCodes),
      memoryMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError("Approved memory Journey event failed its canonical contract.");
  }
  const evidenceRefsJson = canonicalJsonString(event.evidenceRefs);
  const provenanceJson = canonicalJsonString(event.provenance);
  const summaryJson = canonicalJsonString(event.summary);

  sql
    .prepare(
      `INSERT INTO governance_journey_events (
         schema_version, event_id, idempotency_key, scope_kind, workspace_id, event_type,
         subject_kind, subject_id, action, actor_id, actor_type, session_id, turn_id,
         approval_id, fingerprint, source_kind, source_id, trust_disposition, poisoning_status,
         evidence_refs_json, provenance_json, summary_json, occurred_at, recorded_at
       ) VALUES (
         @schemaVersion, @eventId, @idempotencyKey, @scopeKind, @workspaceId, @eventType,
         @subjectKind, @subjectId, @action, @actorId, @actorType, @sessionId, @turnId,
         @approvalId, @fingerprint, @sourceKind, @sourceId, @trustDisposition, @poisoningStatus,
         @evidenceRefsJson, @provenanceJson, @summaryJson, @occurredAt, @recordedAt
       ) ON CONFLICT DO NOTHING`,
    )
    .run({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      scopeKind: event.scopeKind,
      workspaceId: event.workspaceId ?? null,
      eventType: event.eventType,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      action: event.action,
      actorId: event.actorId,
      actorType: event.actorType,
      sessionId: event.sessionId ?? null,
      turnId: event.turnId ?? null,
      approvalId: event.approvalId ?? null,
      fingerprint: event.fingerprint ?? null,
      sourceKind: event.sourceKind ?? null,
      sourceId: event.sourceId ?? null,
      trustDisposition: event.trustDisposition ?? null,
      poisoningStatus: event.poisoningStatus ?? null,
      evidenceRefsJson,
      provenanceJson,
      summaryJson,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
    });
  const storedRow = sql
    .prepare(
      `SELECT * FROM governance_journey_events
       WHERE event_id = @eventId OR idempotency_key = @idempotencyKey
       ORDER BY CASE WHEN event_id = @eventId THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get({ eventId: event.eventId, idempotencyKey: event.idempotencyKey }) as JourneyRow | undefined;
  const stored = storedRow ? mapJourneyRow(storedRow) : undefined;
  if (
    !stored ||
    storedRow?.evidence_refs_json !== evidenceRefsJson ||
    storedRow.provenance_json !== provenanceJson ||
    storedRow.summary_json !== summaryJson ||
    canonicalJsonString(stored) !== canonicalJsonString(event)
  ) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Approved memory Journey event ${event.eventId} conflicts with immutable evidence.`,
    });
  }
  return stored;
}

function parseBinding(value: unknown): MemoryLifecycleApprovalBindingV1 | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schemaVersion",
    "workspaceId",
    "sessionId",
    "turnId",
    "subjectKind",
    "subjectId",
    "action",
    "requestSha256",
    "expectedStateSha256",
    "correctionActionId",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.schemaVersion !== MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION ||
    !isCanonicalId(value.workspaceId) ||
    (value.sessionId !== undefined && !isCanonicalId(value.sessionId)) ||
    (value.turnId !== undefined && !isCanonicalId(value.turnId)) ||
    (value.subjectKind !== "memory_item" && value.subjectKind !== "memory_item_batch") ||
    (value.subjectId !== undefined && !isCanonicalId(value.subjectId)) ||
    (value.action !== "item_updated" && value.action !== "items_forgotten" && value.action !== "batch_mutated") ||
    !isSha256(value.requestSha256) ||
    !isSha256(value.expectedStateSha256) ||
    (value.correctionActionId !== undefined && !isCanonicalId(value.correctionActionId))
  ) {
    return undefined;
  }
  return value as unknown as MemoryLifecycleApprovalBindingV1;
}

function mapJourneyRow(row: JourneyRow): GovernanceJourneyEventRecord {
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: row.schema_version as GovernanceJourneyEventRecord["schemaVersion"],
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
    evidenceRefs: parseJson(row.evidence_refs_json) as GovernanceJourneyEventRecord["evidenceRefs"],
    provenance: parseJson(row.provenance_json) as Record<string, unknown>,
    summary: parseJson(row.summary_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new Error("Stored approved memory Journey event is malformed.");
  }
  return event;
}

function parseRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed = parseJson(raw);
  return isRecord(parsed) ? parsed : undefined;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeFieldCodes(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  if (values.length > 16) throw new TypeError("Approved memory field codes exceed the bounded limit.");
  return [...new Set(values.map((value) => requireCanonicalId(value, "field code")))].sort(compareStrings);
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function optionalCanonicalId(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : isCanonicalId(value) ? value : undefined;
}

function requireCanonicalId(value: unknown, label: string): string {
  if (!isCanonicalId(value)) throw new TypeError(`Approved memory ${label} is invalid.`);
  return value;
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.normalize("NFKC").trim()
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failAuthority(): never {
  throw new ConflictError({
    code: "STATE_CONFLICT",
    message: "Approved memory mutation authority is missing or does not match the canonical request.",
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isHistoryActionPair(changeType: MemoryChangeEvent["changeType"], action: MemoryJourneyEventAction): boolean {
  if (action === "item_updated") return changeType === "updated";
  if (action === "pin_changed") return changeType === "pin_changed";
  if (action === "ttl_changed") return changeType === "ttl_changed";
  if (action === "forgotten") return changeType === "forgotten";
  return action === "batch_mutated";
}
