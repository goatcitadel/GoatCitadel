import { createHash } from "node:crypto";
import {
  assertGovernedLifecycleEventRecord,
  canonicalJsonString,
  computeGovernedMutationMaterialSha256,
  ConflictError,
  GOVERNED_LIFECYCLE_EVENT_VERSION,
  isGovernanceJourneyEventRecord,
  type ApprovalRequest,
  type GovernanceJourneyEvidenceRef,
  type GovernanceJourneyEventRecord,
  type GovernedLifecycleEventRecord,
  type MemoryChangeEvent,
  type MemoryGovernedOperation,
  type MemoryItemRecord,
} from "@goatcitadel/contracts";
import type { AsyncGatewaySqlRepository } from "@goatcitadel/storage";
import {
  buildApprovedMemoryJourneyEvent,
  MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION,
  type ApprovedMemoryJourneyEventInput,
  type MemoryLifecycleApprovalBindingV1,
} from "./memory-journey-producer.js";

/**
 * HX-402 P1 — memory-domain producer for the immutable P0 governed lifecycle
 * owner. Every approved operator memory-item mutation and every scheduled
 * maintenance expiry writes its governed lifecycle event AND its Journey event
 * through `GovernedLifecycleEventRepository.createWithJourney`, inside the
 * canonical mutation transaction, so the trigger-protected owner (SQLite 175 /
 * PostgreSQL 117) is the immutability backstop for memory history in both
 * dialects without any new migration.
 */

export const MEMORY_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION = "goatcitadel.memory-lifecycle-approval-id.v1" as const;
export const MEMORY_LIFECYCLE_REQUEST_ENVELOPE_VERSION = "goatcitadel.memory-lifecycle-request-envelope.v1" as const;
export const MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID = "system:memory-maintenance" as const;

const MEMORY_HISTORY_SOURCE_KIND = "memory_change_history" as const;

export interface MemoryGovernedLifecycleRepository {
  createWithJourney(
    input: GovernedLifecycleEventRecord,
    buildJourneyEvents: (stored: GovernedLifecycleEventRecord) => readonly GovernanceJourneyEventRecord[],
  ): Promise<{ event: GovernedLifecycleEventRecord; journeyEvents: GovernanceJourneyEventRecord[] }>;
}

/**
 * Preserve the P0 repository's append-and-Journey atomicity directly on the
 * Promise-native gateway SQL surface. Both async dialect adapters make the
 * inner immediate transaction a nested-safe savepoint, so
 * `createWithJourney` composes inside the producer's owning mutation.
 */
export function createMemoryGovernedLifecycleRepository(
  host: AsyncGatewaySqlRepository,
): MemoryGovernedLifecycleRepository {
  if (typeof host.runImmediateTransaction !== "function") {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Governed memory lifecycle evidence requires transactional gateway storage.",
    });
  }
  return {
    createWithJourney: async (input, buildJourneyEvents) =>
      await host.runImmediateTransaction(async () => {
        const event = await createGovernedLifecycleEvent(host, input);
        const journeyEvents: GovernanceJourneyEventRecord[] = [];
        for (const journeyEvent of buildJourneyEvents(event)) {
          journeyEvents.push(await createGovernanceJourneyEvent(host, journeyEvent));
        }
        return { event, journeyEvents };
      }),
  };
}

/**
 * Deterministic server-owned approval identity for one exact memory mutation
 * request against one exact reviewed state (C4a/M2 discipline): the canonical
 * material digest formatted as a UUID so the shipped
 * `POST /api/v1/approvals/:approvalId/resolve` surface can resolve it. The
 * request hash AND the expected-state hash are both identity material, so the
 * same mutation over drifted state is a different approval, while byte-exact
 * replays converge on the original approval row.
 */
export function deriveMemoryLifecycleApprovalId(
  binding: Pick<
    MemoryLifecycleApprovalBindingV1,
    "workspaceId" | "subjectKind" | "subjectId" | "action" | "requestSha256" | "expectedStateSha256"
  >,
): string {
  const digest = createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: MEMORY_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION,
        workspaceId: binding.workspaceId,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId ?? null,
        action: binding.action,
        requestSha256: binding.requestSha256,
        expectedStateSha256: binding.expectedStateSha256,
      }),
      "utf8",
    )
    .digest("hex");
  const material = digest.slice(0, 32);
  return [
    material.slice(0, 8),
    material.slice(8, 12),
    material.slice(12, 16),
    material.slice(16, 20),
    material.slice(20, 32),
  ].join("-");
}

export interface MemoryLifecycleRequestEnvelopeV1 {
  schemaVersion: typeof MEMORY_LIFECYCLE_REQUEST_ENVELOPE_VERSION;
  requesterId: string;
  mutation: unknown;
}

export function buildMemoryLifecycleApprovalPayload(input: {
  binding: MemoryLifecycleApprovalBindingV1;
  requesterId: string;
  mutation: unknown;
}): Record<string, unknown> {
  return JSON.parse(
    canonicalJsonString({
      memoryLifecycle: input.binding,
      request: {
        schemaVersion: MEMORY_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: requireCanonicalId(input.requesterId, "requester ID"),
        mutation: input.mutation,
      } satisfies MemoryLifecycleRequestEnvelopeV1,
    }),
  ) as Record<string, unknown>;
}

/** Fail-closed parse of the immutable request envelope stored on the approval payload. */
export function parseMemoryLifecycleRequestEnvelope(payload: unknown): MemoryLifecycleRequestEnvelopeV1 | undefined {
  if (!isRecord(payload)) return undefined;
  const request = payload.request;
  if (!isRecord(request)) return undefined;
  const keys = Object.keys(request).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["mutation", "requesterId", "schemaVersion"])) {
    return undefined;
  }
  if (
    request.schemaVersion !== MEMORY_LIFECYCLE_REQUEST_ENVELOPE_VERSION ||
    !isCanonicalId(request.requesterId) ||
    request.mutation === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: MEMORY_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
    requesterId: request.requesterId,
    mutation: request.mutation,
  };
}

export function memoryLifecycleRequestJourneyIdempotencyKey(approvalId: string): string {
  return `memory:lifecycle:request:${requireCanonicalId(approvalId, "approval ID")}`;
}

/**
 * The content-free request Journey evidence committed atomically with the
 * `memory.lifecycle` approval row. It is the durable requester-identity record
 * the recovered effect replays (M2's Journey-evidence pattern): approval
 * linkage cannot carry the requesting actor, so the executor recovers it from
 * this immutable event and fails closed when the evidence is missing.
 */
export function buildMemoryLifecycleRequestJourneyEvent(input: {
  approval: Pick<ApprovalRequest, "approvalId" | "createdAt">;
  binding: MemoryLifecycleApprovalBindingV1;
  requesterId: string;
  itemCount: number;
}): GovernanceJourneyEventRecord {
  const approvalId = requireCanonicalId(input.approval.approvalId, "approval ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `memory:journey:request:${approvalId}`,
    idempotencyKey: memoryLifecycleRequestJourneyIdempotencyKey(approvalId),
    scopeKind: "workspace",
    workspaceId: input.binding.workspaceId,
    eventType: "memory_item_lifecycle",
    subjectKind: input.binding.subjectKind,
    subjectId: input.binding.subjectId ?? `memory-batch:${input.binding.requestSha256.slice(0, 32)}`,
    action: "mutation_requested",
    actorId: requireCanonicalId(input.requesterId, "requester ID"),
    actorType: "operator",
    sessionId: input.binding.sessionId,
    turnId: input.binding.turnId,
    approvalId,
    fingerprint: input.binding.requestSha256,
    sourceKind: "approval",
    sourceId: approvalId,
    trustDisposition: "memory_mutation_requested",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: approvalId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: MEMORY_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      phase: "requested",
    },
    summary: {
      action: input.binding.action,
      subjectKind: input.binding.subjectKind,
      itemCount: requireBoundedCount(input.itemCount),
      memoryMutationObserved: false,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.approval.createdAt,
    recordedAt: input.approval.createdAt,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError("Memory lifecycle request Journey event failed its canonical contract.");
  }
  return event;
}

export interface ApprovedMemoryLifecycleEvidenceInput extends ApprovedMemoryJourneyEventInput {
  /** Required when `action` is `batch_mutated`: the canonical batch action id. */
  batchActionId?: string;
}

export interface ApprovedMemoryLifecycleEvidence {
  event: GovernedLifecycleEventRecord;
  journeyEvent: GovernanceJourneyEventRecord;
}

/**
 * Write one approved memory mutation's immutable evidence pair: the governed
 * lifecycle event (P0 owner) and its Journey event, coupled transactionally by
 * `createWithJourney`. Exact replays converge byte-identically; the same
 * identity with different material conflicts inside the owner.
 */
export async function persistApprovedMemoryMutationEvidence(
  repository: MemoryGovernedLifecycleRepository,
  input: ApprovedMemoryLifecycleEvidenceInput,
): Promise<ApprovedMemoryLifecycleEvidence> {
  const operation = governedOperationForApprovedChange(input);
  const eventId = governedMemoryLifecycleEventId(input.change.changeId);
  const journeyEvent = buildApprovedMemoryJourneyEvent({ ...input, governedLifecycleEventId: eventId });
  const target = governedTargetForApprovedChange(input);
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "memory",
    operation,
    targetKind: target.targetKind,
    targetId: target.targetId,
    materialSha256: computeGovernedMutationMaterialSha256({
      approvalId: input.authority.approvalId,
      changeId: input.change.changeId,
      changeType: input.change.changeType,
      subjectId: input.subjectId,
      action: input.action,
      requestSha256: input.authority.requestSha256,
      expectedStateSha256: input.authority.expectedStateSha256,
      lifecycleState: input.lifecycleState,
      fieldCodes: [...(input.fieldCodes ?? [])].sort(),
      ...(input.batchOperationIndex === undefined ? {} : { batchOperationIndex: input.batchOperationIndex }),
    }),
    scopeKind: "workspace",
    workspaceId: input.authority.workspaceId,
    actorId: input.authority.actorId,
    actorType: "operator",
    ...(input.authority.sessionId === undefined ? {} : { sessionId: input.authority.sessionId }),
    ...(input.authority.turnId === undefined ? {} : { turnId: input.authority.turnId }),
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: MEMORY_HISTORY_SOURCE_KIND,
    sourceId: input.change.changeId,
    approvalId: input.authority.approvalId,
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  const { event, journeyEvents } = await repository.createWithJourney(record, () => [journeyEvent]);
  const storedJourney = journeyEvents[0];
  if (!storedJourney) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Approved memory lifecycle event ${eventId} lost its transactional Journey coupling.`,
    });
  }
  return { event, journeyEvent: storedJourney };
}

// ── structured memory Journey evidence ────────────────────────────────

const STRUCTURED_HISTORY_SOURCE_KIND = "memory_structured_change_history" as const;

export interface StructuredMemoryJourneyEventInput {
  recordKind: "entity" | "relation" | "decision";
  recordId: string;
  changeId: string;
  changeType: string;
  actorId: string;
  workspaceId: string;
  occurredAt: string;
  /** Explicit correction provenance (retrospectives, supersessions). */
  correctionRefId?: string;
}

/**
 * Journey evidence for one structured memory mutation, committed inside the
 * same transaction as the record and its history row. Structured writes are
 * not yet approval-governed, so the event declares `approvalRequired: false`
 * explicitly and can never read as promotion or callability authority.
 */
export function buildStructuredMemoryJourneyEvent(
  input: StructuredMemoryJourneyEventInput,
): GovernanceJourneyEventRecord {
  const changeId = requireCanonicalId(input.changeId, "change ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `memory:journey:structured:${changeId}`,
    idempotencyKey: `memory:structured:${changeId}:${requireCanonicalId(input.changeType, "change type")}`,
    scopeKind: "workspace",
    workspaceId: requireCanonicalId(input.workspaceId, "workspace ID"),
    eventType: "memory_structured_lifecycle",
    subjectKind: `memory_${input.recordKind}`,
    subjectId: requireCanonicalId(input.recordId, "record ID"),
    action: input.changeType,
    actorId: requireCanonicalId(input.actorId, "actor ID"),
    actorType: "operator",
    fingerprint: createHash("sha256")
      .update(
        canonicalJsonString({
          schemaVersion: "goatcitadel.memory-structured-journey.v1",
          recordKind: input.recordKind,
          recordId: input.recordId,
          changeId,
          changeType: input.changeType,
        }),
        "utf8",
      )
      .digest("hex"),
    sourceKind: STRUCTURED_HISTORY_SOURCE_KIND,
    sourceId: changeId,
    trustDisposition: "structured_memory_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "memory_history", refId: changeId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      historyOwner: STRUCTURED_HISTORY_SOURCE_KIND,
      correctionProvenance: input.correctionRefId ? "explicit" : "not_applicable",
      ...(input.correctionRefId
        ? { correctionRefId: requireCanonicalId(input.correctionRefId, "correction reference") }
        : {}),
    },
    summary: {
      changeType: input.changeType,
      recordKind: input.recordKind,
      memoryMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError("Structured memory Journey event failed its canonical contract.");
  }
  return event;
}

// ── module-private system maintenance authority (HX-411/HX-415 brand) ──

const memoryMaintenanceAuthorityBrand: unique symbol = Symbol("goatcitadel.memory.maintenance-system-authority");
const memoryMaintenanceAuthorityToken: unique symbol = Symbol("goatcitadel.memory.maintenance-authority-construction");
const mintedMemoryMaintenanceAuthorities = new WeakSet<object>();

/**
 * Unforgeable module-private authority for scheduled memory maintenance. Route
 * inputs can never mint one: instances only exist through this module's
 * construction token, membership is tracked in a module-private WeakSet (JSON,
 * spread, and structured clones all fail the check), and serialization throws.
 */
export interface MemoryMaintenanceSystemAuthority {
  readonly actorId: typeof MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID;
  readonly [memoryMaintenanceAuthorityBrand]: true;
  toJSON(): never;
}

class MemoryMaintenanceSystemAuthorityValue {
  public readonly actorId = MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID;

  public constructor(token: typeof memoryMaintenanceAuthorityToken) {
    if (token !== memoryMaintenanceAuthorityToken) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Memory maintenance system authority cannot be constructed outside its owning module.",
      });
    }
    mintedMemoryMaintenanceAuthorities.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Memory maintenance system authority never serializes.",
    });
  }
}

export function mintMemoryMaintenanceSystemAuthority(): MemoryMaintenanceSystemAuthority {
  return new MemoryMaintenanceSystemAuthorityValue(
    memoryMaintenanceAuthorityToken,
  ) as unknown as MemoryMaintenanceSystemAuthority;
}

export function isMemoryMaintenanceSystemAuthority(value: unknown): value is MemoryMaintenanceSystemAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    mintedMemoryMaintenanceAuthorities.has(value) &&
    (value as { actorId?: unknown }).actorId === MEMORY_MAINTENANCE_SYSTEM_ACTOR_ID
  );
}

export interface MemorySystemExpiryEvidenceInput {
  authority: MemoryMaintenanceSystemAuthority;
  change: MemoryChangeEvent;
  item: Pick<MemoryItemRecord, "itemId" | "workspaceId" | "lifecycleState" | "expiresAt">;
  occurredAt: string;
}

/**
 * Scheduled-maintenance expiry evidence: the `maintenance_expired` governed
 * event is system-actor-only in the frozen registry, and this producer only
 * writes it for a WeakSet-verified module-private authority — an operator or
 * approval-effect payload can never reach it.
 */
export async function persistMemorySystemExpiryEvidence(
  repository: MemoryGovernedLifecycleRepository,
  input: MemorySystemExpiryEvidenceInput,
): Promise<ApprovedMemoryLifecycleEvidence> {
  if (!isMemoryMaintenanceSystemAuthority(input.authority)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Memory maintenance expiry requires the module-private system authority.",
    });
  }
  const workspaceId = input.item.workspaceId?.normalize("NFKC").trim();
  const scope: Pick<GovernedLifecycleEventRecord, "scopeKind"> & { workspaceId?: string } =
    workspaceId && workspaceId === input.item.workspaceId
      ? { scopeKind: "workspace", workspaceId }
      : { scopeKind: "global" };
  const eventId = governedMemoryLifecycleEventId(input.change.changeId);
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "memory",
    operation: "maintenance_expired",
    targetKind: "memory_item",
    targetId: requireCanonicalId(input.item.itemId, "item ID"),
    materialSha256: computeGovernedMutationMaterialSha256({
      changeId: input.change.changeId,
      itemId: input.item.itemId,
      expiresAt: input.item.expiresAt ?? null,
      lifecycleState: input.item.lifecycleState,
    }),
    ...scope,
    actorId: input.authority.actorId,
    actorType: "system",
    sourceRequired: true,
    approvalRequired: false,
    sourceKind: MEMORY_HISTORY_SOURCE_KIND,
    sourceId: input.change.changeId,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `memory:journey:${input.change.changeId}`,
    idempotencyKey: `memory:lifecycle:${input.change.changeId}:maintenance_expired`,
    ...(scope.scopeKind === "workspace"
      ? { scopeKind: "workspace" as const, workspaceId: scope.workspaceId }
      : { scopeKind: "global" as const }),
    eventType: "memory_item_lifecycle",
    subjectKind: "memory_item",
    subjectId: input.item.itemId,
    action: "maintenance_expired",
    actorId: input.authority.actorId,
    actorType: "system",
    fingerprint: record.materialSha256,
    sourceKind: MEMORY_HISTORY_SOURCE_KIND,
    sourceId: input.change.changeId,
    trustDisposition: "system_memory_maintenance",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "memory_history", refId: input.change.changeId },
      { owner: "governed_lifecycle", refId: eventId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      systemAuthority: "memory_maintenance",
      historyOwner: MEMORY_HISTORY_SOURCE_KIND,
    },
    summary: {
      changeType: input.change.changeType,
      lifecycleState: requireCanonicalId(input.item.lifecycleState, "lifecycle state"),
      memoryMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  if (!isGovernanceJourneyEventRecord(journeyEvent)) {
    throw new TypeError("Memory maintenance expiry Journey event failed its canonical contract.");
  }
  const { event, journeyEvents } = await repository.createWithJourney(record, () => [journeyEvent]);
  const storedJourney = journeyEvents[0];
  if (!storedJourney) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Memory maintenance expiry event ${eventId} lost its transactional Journey coupling.`,
    });
  }
  return { event, journeyEvent: storedJourney };
}

// ── recovered-effect error taxonomy (M3's narrowed retry/terminal split) ──

export type MemoryLifecycleApplyErrorCode =
  | "memory_lifecycle_approval_not_executable"
  | "memory_lifecycle_approval_expired"
  | "memory_lifecycle_request_evidence_missing"
  | "memory_lifecycle_request_drift"
  | "memory_lifecycle_policy_blocked"
  | "memory_lifecycle_apply_conflict";

const APPLY_ERROR_MESSAGES: Record<MemoryLifecycleApplyErrorCode, string> = {
  memory_lifecycle_approval_not_executable:
    "Memory lifecycle approval is missing, foreign, malformed, or not approved.",
  memory_lifecycle_approval_expired: "Memory lifecycle approval expired before its recovered effect executed.",
  memory_lifecycle_request_evidence_missing: "Memory lifecycle request Journey evidence is missing or mismatched.",
  memory_lifecycle_request_drift: "Memory lifecycle request material does not reproduce its approved hash.",
  memory_lifecycle_policy_blocked: "Memory lifecycle policy blocks this mutation at execution time.",
  memory_lifecycle_apply_conflict: "Memory lifecycle mutation conflicts with canonical state.",
};

/** Terminal governance failure of one approved memory mutation effect: fail closed, never retried. */
export class MemoryLifecycleApplyError extends Error {
  public readonly code: MemoryLifecycleApplyErrorCode;

  public constructor(code: MemoryLifecycleApplyErrorCode) {
    super(APPLY_ERROR_MESSAGES[code]);
    this.name = "MemoryLifecycleApplyError";
    this.code = code;
  }
}

interface GovernedLifecycleRow {
  schema_version: GovernedLifecycleEventRecord["schemaVersion"];
  event_id: string;
  idempotency_key: string;
  domain: GovernedLifecycleEventRecord["domain"];
  operation: GovernedLifecycleEventRecord["operation"];
  target_kind: GovernedLifecycleEventRecord["targetKind"];
  target_id: string;
  material_sha256: string;
  scope_kind: GovernedLifecycleEventRecord["scopeKind"];
  workspace_id: string | null;
  actor_id: string;
  actor_type: GovernedLifecycleEventRecord["actorType"];
  session_id: string | null;
  turn_id: string | null;
  source_required: number | string;
  approval_required: number | string;
  source_kind: string | null;
  source_id: string | null;
  approval_id: string | null;
  occurred_at: string;
  recorded_at: string;
}

interface GovernanceJourneyRow {
  schema_version: GovernanceJourneyEventRecord["schemaVersion"];
  event_id: string;
  idempotency_key: string;
  scope_kind: GovernanceJourneyEventRecord["scopeKind"];
  workspace_id: string | null;
  event_type: string;
  subject_kind: string;
  subject_id: string;
  action: string;
  actor_id: string;
  actor_type: GovernanceJourneyEventRecord["actorType"];
  session_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  fingerprint: string | null;
  source_kind: string | null;
  source_id: string | null;
  trust_disposition: string | null;
  poisoning_status: GovernanceJourneyEventRecord["poisoningStatus"] | null;
  evidence_refs_json: string;
  provenance_json: string;
  summary_json: string;
  occurred_at: string;
  recorded_at: string;
}

async function createGovernedLifecycleEvent(
  host: AsyncGatewaySqlRepository,
  input: GovernedLifecycleEventRecord,
): Promise<GovernedLifecycleEventRecord> {
  assertGovernedLifecycleEventRecord(input);
  await host
    .prepare(
      `INSERT INTO governed_lifecycle_events (
        schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
        material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
        source_required, approval_required, source_kind, source_id, approval_id, occurred_at, recorded_at
      ) VALUES (
        @schemaVersion, @eventId, @idempotencyKey, @domain, @operation, @targetKind, @targetId,
        @materialSha256, @scopeKind, @workspaceId, @actorId, @actorType, @sessionId, @turnId,
        @sourceRequired, @approvalRequired, @sourceKind, @sourceId, @approvalId, @occurredAt, @recordedAt
      ) ON CONFLICT DO NOTHING`,
    )
    .run({
      schemaVersion: input.schemaVersion,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      domain: input.domain,
      operation: input.operation,
      targetKind: input.targetKind,
      targetId: input.targetId,
      materialSha256: input.materialSha256,
      scopeKind: input.scopeKind,
      workspaceId: input.workspaceId ?? null,
      actorId: input.actorId,
      actorType: input.actorType,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      sourceRequired: input.sourceRequired ? 1 : 0,
      approvalRequired: input.approvalRequired ? 1 : 0,
      sourceKind: input.sourceKind ?? null,
      sourceId: input.sourceId ?? null,
      approvalId: input.approvalId ?? null,
      occurredAt: input.occurredAt,
      recordedAt: input.recordedAt,
    });
  const row = await host
    .prepare("SELECT * FROM governed_lifecycle_events WHERE idempotency_key = ?")
    .get<GovernedLifecycleRow>(input.idempotencyKey);
  if (!row) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Governed lifecycle event ${input.eventId} conflicts with an existing immutable record.`,
    });
  }
  const stored = mapGovernedLifecycleRow(row);
  assertImmutableEvidenceReplay(stored, input, `Governed lifecycle event ${input.eventId}`);
  return stored;
}

async function createGovernanceJourneyEvent(
  host: AsyncGatewaySqlRepository,
  input: GovernanceJourneyEventRecord,
): Promise<GovernanceJourneyEventRecord> {
  if (!isGovernanceJourneyEventRecord(input)) {
    throw new TypeError("Memory lifecycle Journey event failed its canonical contract.");
  }
  const normalizedInput: GovernanceJourneyEventRecord = {
    ...input,
    evidenceRefs: normalizeJourneyEvidenceRefs(input.evidenceRefs),
  };
  await host
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
      schemaVersion: normalizedInput.schemaVersion,
      eventId: normalizedInput.eventId,
      idempotencyKey: normalizedInput.idempotencyKey,
      scopeKind: normalizedInput.scopeKind,
      workspaceId: normalizedInput.workspaceId ?? null,
      eventType: normalizedInput.eventType,
      subjectKind: normalizedInput.subjectKind,
      subjectId: normalizedInput.subjectId,
      action: normalizedInput.action,
      actorId: normalizedInput.actorId,
      actorType: normalizedInput.actorType,
      sessionId: normalizedInput.sessionId ?? null,
      turnId: normalizedInput.turnId ?? null,
      approvalId: normalizedInput.approvalId ?? null,
      fingerprint: normalizedInput.fingerprint ?? null,
      sourceKind: normalizedInput.sourceKind ?? null,
      sourceId: normalizedInput.sourceId ?? null,
      trustDisposition: normalizedInput.trustDisposition ?? null,
      poisoningStatus: normalizedInput.poisoningStatus ?? null,
      evidenceRefsJson: canonicalJsonString(normalizedInput.evidenceRefs),
      provenanceJson: canonicalJsonString(normalizedInput.provenance),
      summaryJson: canonicalJsonString(normalizedInput.summary),
      occurredAt: normalizedInput.occurredAt,
      recordedAt: normalizedInput.recordedAt,
    });
  const row = await host
    .prepare("SELECT * FROM governance_journey_events WHERE idempotency_key = ?")
    .get<GovernanceJourneyRow>(normalizedInput.idempotencyKey);
  if (!row) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Governance Journey event ${input.eventId} conflicts with an existing immutable record.`,
    });
  }
  const stored = mapGovernanceJourneyRow(row);
  assertImmutableEvidenceReplay(stored, normalizedInput, `Governance Journey event ${input.eventId}`);
  return stored;
}

function mapGovernedLifecycleRow(row: GovernedLifecycleRow): GovernedLifecycleEventRecord {
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    domain: row.domain,
    operation: row.operation,
    targetKind: row.target_kind,
    targetId: row.target_id,
    materialSha256: row.material_sha256,
    scopeKind: row.scope_kind,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    actorId: row.actor_id,
    actorType: row.actor_type,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    sourceRequired: Number(row.source_required) === 1,
    approvalRequired: Number(row.approval_required) === 1,
    ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  assertGovernedLifecycleEventRecord(record);
  return record;
}

function mapGovernanceJourneyRow(row: GovernanceJourneyRow): GovernanceJourneyEventRecord {
  const record: GovernanceJourneyEventRecord = {
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    scopeKind: row.scope_kind,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    eventType: row.event_type,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.trust_disposition === null ? {} : { trustDisposition: row.trust_disposition }),
    ...(row.poisoning_status === null ? {} : { poisoningStatus: row.poisoning_status }),
    evidenceRefs: normalizeJourneyEvidenceRefs(
      parseCanonicalJson<GovernanceJourneyEvidenceRef[]>(row.evidence_refs_json),
    ),
    provenance: parseCanonicalJson<Record<string, unknown>>(row.provenance_json),
    summary: parseCanonicalJson<Record<string, unknown>>(row.summary_json),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
  if (!isGovernanceJourneyEventRecord(record)) {
    throw new TypeError("Stored memory lifecycle Journey event failed its canonical contract.");
  }
  return record;
}

function parseCanonicalJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new TypeError("Stored memory lifecycle Journey event contains malformed JSON.", { cause: error });
  }
}

function normalizeJourneyEvidenceRefs(
  evidenceRefs: readonly GovernanceJourneyEvidenceRef[],
): GovernanceJourneyEvidenceRef[] {
  const byIdentity = new Map<string, GovernanceJourneyEvidenceRef>();
  for (const evidenceRef of evidenceRefs) {
    byIdentity.set(`${evidenceRef.owner}:${evidenceRef.refId}`, {
      owner: evidenceRef.owner,
      refId: evidenceRef.refId,
    });
  }
  return [...byIdentity.values()].sort((left, right) => {
    const leftIdentity = `${left.owner}:${left.refId}`;
    const rightIdentity = `${right.owner}:${right.refId}`;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
}

function assertImmutableEvidenceReplay(stored: unknown, attempted: unknown, label: string): void {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `${label} conflicts with an existing immutable record.`,
    });
  }
}

// ── local helpers ──────────────────────────────────────────────────────

function governedMemoryLifecycleEventId(changeId: string): string {
  return `memory-lifecycle:${requireCanonicalId(changeId, "change ID")}`;
}

function governedOperationForApprovedChange(input: ApprovedMemoryLifecycleEvidenceInput): MemoryGovernedOperation {
  if (input.action === "batch_mutated") return "batch_mutated";
  switch (input.change.changeType) {
    case "updated":
      return "item_updated";
    case "pin_changed":
      return "pin_changed";
    case "ttl_changed":
      return "ttl_changed";
    case "forgotten":
      return "item_forgotten";
    default:
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Memory change type ${String(input.change.changeType)} has no governed lifecycle operation.`,
      });
  }
}

function governedTargetForApprovedChange(input: ApprovedMemoryLifecycleEvidenceInput): {
  targetKind: "memory_item" | "memory_batch";
  targetId: string;
} {
  if (input.action !== "batch_mutated") {
    return { targetKind: "memory_item", targetId: requireCanonicalId(input.subjectId, "subject ID") };
  }
  const batchActionId = input.batchActionId;
  if (!isCanonicalId(batchActionId)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Approved memory batch evidence requires its canonical batch action ID.",
    });
  }
  return { targetKind: "memory_batch", targetId: `memory-batch:${batchActionId}` };
}

function requireBoundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new TypeError("Memory lifecycle item count is out of bounds.");
  }
  return value;
}

function requireCanonicalId(value: unknown, label: string): string {
  if (!isCanonicalId(value)) throw new TypeError(`Memory lifecycle ${label} is invalid.`);
  return value;
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.normalize("NFKC").trim()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
