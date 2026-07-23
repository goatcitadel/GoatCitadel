/* eslint-disable max-lines -- One P0-owner producer covers both governed P2 domains (skill_state + capability_state): bindings, request evidence, approved/system evidence writers, and the branded fail-safe authority stay module-private together. */
import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  computeGovernedMutationMaterialSha256,
  ConflictError,
  GOVERNED_LIFECYCLE_EVENT_VERSION,
  isGovernanceJourneyEventRecord,
  type ApprovalRequest,
  type CapabilityStateGovernedOperation,
  type GovernanceJourneyEventRecord,
  type GovernedLifecycleEventRecord,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import { GovernedLifecycleEventRepository, type DatabaseClient } from "@goatcitadel/storage";

/**
 * HX-402 P2 — skill/capability-domain producer for the immutable P0 governed
 * lifecycle owner (docs/review/HX_402_REMAINING_PRODUCER_AUDIT_2026-07-14.md).
 * Every approved operator skill-state / activation-policy / capability-candidate
 * transition, every review-only capability proposal, and every branded
 * fail-safe system disable/revoke writes its governed lifecycle event AND its
 * Journey event through `GovernedLifecycleEventRepository.createWithJourney`,
 * inside the canonical mutation transaction, so the trigger-protected owner
 * (SQLite 175 / PostgreSQL 117) is the immutability backstop in both dialects
 * without any new migration. This mirrors the P1 memory-domain producer
 * byte-for-byte in structure: deterministic payload-hash UUID approval
 * identity, immutable requester Journey evidence, branded module-private
 * system authority, and a terminal-vs-defer apply error taxonomy.
 */

export const SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION = "goatcitadel.skill-lifecycle-approval.v1" as const;
export const SKILL_LIFECYCLE_REQUEST_VERSION = "goatcitadel.skill-lifecycle-request.v1" as const;
export const SKILL_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION = "goatcitadel.skill-lifecycle-approval-id.v1" as const;
export const SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION = "goatcitadel.skill-lifecycle-request-envelope.v1" as const;

export const CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION = "goatcitadel.capability-lifecycle-approval.v1" as const;
export const CAPABILITY_LIFECYCLE_REQUEST_VERSION = "goatcitadel.capability-lifecycle-request.v1" as const;
export const CAPABILITY_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION =
  "goatcitadel.capability-lifecycle-approval-id.v1" as const;
export const CAPABILITY_LIFECYCLE_REQUEST_ENVELOPE_VERSION =
  "goatcitadel.capability-lifecycle-request-envelope.v1" as const;

export const SKILL_GOVERNANCE_SYSTEM_ACTOR_ID = "system:skill-governance" as const;

const SKILL_STATE_SOURCE_KIND = "skill_activation_event" as const;
const CAPABILITY_PROPOSAL_SOURCE_KIND = "capability_proposal_event" as const;
const CAPABILITY_CANDIDATE_SOURCE_KIND = "capability_candidate_version" as const;

// ── shared SQL-host adapter (P1 pattern) ──────────────────────────────

interface SkillGovernedSqlHost {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  runImmediateTransaction?<T>(callback: () => T): T;
}

/**
 * Adapt the gateway SQL host to the storage `DatabaseClient` surface the P0
 * repository needs. Only `prepare` and immediate `transaction` are real; the
 * repository never calls `exec`/`close`, and both dialects' clients make the
 * inner transaction a nested-safe savepoint, so `createWithJourney` composes
 * inside the producer's own mutation transaction.
 */
export function createSkillGovernedLifecycleRepository(host: SkillGovernedSqlHost): GovernedLifecycleEventRepository {
  const runImmediateTransaction = host.runImmediateTransaction;
  if (typeof runImmediateTransaction !== "function") {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Governed skill lifecycle evidence requires transactional gateway storage.",
    });
  }
  const client: DatabaseClient = {
    dialect: host.dialect,
    prepare: (sql: string) => host.prepare(sql) as ReturnType<DatabaseClient["prepare"]>,
    exec: () => {
      throw new Error("Governed skill lifecycle adapter does not execute raw SQL scripts.");
    },
    close: () => {
      throw new Error("Governed skill lifecycle adapter does not own the database connection.");
    },
    transaction: <T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T =>
      runImmediateTransaction.call(host, callback) as T,
  };
  return new GovernedLifecycleEventRepository(client);
}

// ── skill-state approval binding ──────────────────────────────────────

export type SkillLifecycleSubjectKind = "skill" | "skill_batch" | "skill_activation_policy";
export type SkillLifecycleApprovalAction = "skill_state_set" | "skill_state_bulk_set" | "activation_policy_updated";

export interface SkillLifecycleApprovalBindingV1 {
  schemaVersion: typeof SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION;
  scopeKind: "global";
  subjectKind: SkillLifecycleSubjectKind;
  subjectId?: string;
  action: SkillLifecycleApprovalAction;
  requestSha256: string;
  expectedStateSha256: string;
}

export function buildSkillLifecycleRequestSha256(input: {
  subjectKind: SkillLifecycleSubjectKind;
  subjectId?: string;
  action: SkillLifecycleApprovalAction;
  mutation: unknown;
}): string {
  const material = canonicalJsonString({
    schemaVersion: SKILL_LIFECYCLE_REQUEST_VERSION,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ? requireCanonicalId(input.subjectId, "subject ID") : null,
    action: input.action,
    mutation: input.mutation,
  });
  assertHashBoundary(material, "skill lifecycle request");
  return sha256(material);
}

export function buildSkillLifecycleStateSha256(state: unknown): string {
  const material = canonicalJsonString({ schemaVersion: "goatcitadel.skill-lifecycle-state.v1", state });
  assertHashBoundary(material, "skill lifecycle state");
  return sha256(material);
}

export function buildSkillLifecycleApprovalBinding(input: {
  subjectKind: SkillLifecycleSubjectKind;
  subjectId?: string;
  action: SkillLifecycleApprovalAction;
  mutation: unknown;
  expectedState: unknown;
}): SkillLifecycleApprovalBindingV1 {
  return {
    schemaVersion: SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION,
    scopeKind: "global",
    subjectKind: input.subjectKind,
    subjectId: input.subjectId ? requireCanonicalId(input.subjectId, "subject ID") : undefined,
    action: input.action,
    requestSha256: buildSkillLifecycleRequestSha256(input),
    expectedStateSha256: buildSkillLifecycleStateSha256(input.expectedState),
  };
}

/** Fail-closed parse of the immutable `skillLifecycle` approval binding from an approval payload. */
export function parseSkillLifecycleApprovalBinding(value: unknown): SkillLifecycleApprovalBindingV1 | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schemaVersion",
    "scopeKind",
    "subjectKind",
    "subjectId",
    "action",
    "requestSha256",
    "expectedStateSha256",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.schemaVersion !== SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION ||
    value.scopeKind !== "global" ||
    (value.subjectKind !== "skill" &&
      value.subjectKind !== "skill_batch" &&
      value.subjectKind !== "skill_activation_policy") ||
    (value.subjectId !== undefined && !isCanonicalId(value.subjectId)) ||
    (value.action !== "skill_state_set" &&
      value.action !== "skill_state_bulk_set" &&
      value.action !== "activation_policy_updated") ||
    !isSha256(value.requestSha256) ||
    !isSha256(value.expectedStateSha256)
  ) {
    return undefined;
  }
  return value as unknown as SkillLifecycleApprovalBindingV1;
}

/**
 * Deterministic server-owned approval identity for one exact skill mutation
 * request against one exact reviewed state (P1's C4a/M2 discipline): the
 * canonical material digest formatted as a UUID so the shipped
 * `POST /api/v1/approvals/:approvalId/resolve` surface can resolve it. The
 * request hash AND the expected-state hash are both identity material, so the
 * same mutation over drifted state is a different approval, while byte-exact
 * replays converge on the original approval row.
 */
export function deriveSkillLifecycleApprovalId(
  binding: Pick<
    SkillLifecycleApprovalBindingV1,
    "subjectKind" | "subjectId" | "action" | "requestSha256" | "expectedStateSha256"
  >,
): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: SKILL_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId ?? null,
        action: binding.action,
        requestSha256: binding.requestSha256,
        expectedStateSha256: binding.expectedStateSha256,
      }),
    ),
  );
}

export interface SkillLifecycleRequestEnvelopeV1 {
  schemaVersion: typeof SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION;
  requesterId: string;
  mutation: unknown;
}

export function buildSkillLifecycleApprovalPayload(input: {
  binding: SkillLifecycleApprovalBindingV1;
  requesterId: string;
  mutation: unknown;
}): Record<string, unknown> {
  return JSON.parse(
    canonicalJsonString({
      skillLifecycle: input.binding,
      request: {
        schemaVersion: SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: requireCanonicalId(input.requesterId, "requester ID"),
        mutation: input.mutation,
      } satisfies SkillLifecycleRequestEnvelopeV1,
    }),
  ) as Record<string, unknown>;
}

/** Fail-closed parse of the immutable request envelope stored on the approval payload. */
export function parseSkillLifecycleRequestEnvelope(payload: unknown): SkillLifecycleRequestEnvelopeV1 | undefined {
  const request = parseRequestEnvelope(payload, SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION);
  return request
    ? {
        schemaVersion: SKILL_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: request.requesterId,
        mutation: request.mutation,
      }
    : undefined;
}

export function skillLifecycleRequestJourneyIdempotencyKey(approvalId: string): string {
  return `skill:lifecycle:request:${requireCanonicalId(approvalId, "approval ID")}`;
}

/**
 * The content-free request Journey evidence committed atomically with the
 * `skill.lifecycle` approval row. It is the durable requester-identity record
 * the recovered effect replays (M2's Journey-evidence pattern): approval
 * linkage cannot carry the requesting actor, so the executor recovers it from
 * this immutable event and fails closed when the evidence is missing.
 */
export function buildSkillLifecycleRequestJourneyEvent(input: {
  approval: Pick<ApprovalRequest, "approvalId" | "createdAt">;
  binding: SkillLifecycleApprovalBindingV1;
  requesterId: string;
  targetCount: number;
}): GovernanceJourneyEventRecord {
  const approvalId = requireCanonicalId(input.approval.approvalId, "approval ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `skill:journey:request:${approvalId}`,
    idempotencyKey: skillLifecycleRequestJourneyIdempotencyKey(approvalId),
    scopeKind: "global",
    eventType: "skill_state_lifecycle",
    subjectKind: input.binding.subjectKind,
    subjectId: input.binding.subjectId ?? `skill-batch:${input.binding.requestSha256.slice(0, 32)}`,
    action: "mutation_requested",
    actorId: requireCanonicalId(input.requesterId, "requester ID"),
    actorType: "operator",
    approvalId,
    fingerprint: input.binding.requestSha256,
    sourceKind: "approval",
    sourceId: approvalId,
    trustDisposition: "skill_mutation_requested",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: approvalId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      phase: "requested",
    },
    summary: {
      action: input.binding.action,
      subjectKind: input.binding.subjectKind,
      targetCount: requireBoundedCount(input.targetCount),
      skillMutationObserved: false,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.approval.createdAt,
    recordedAt: input.approval.createdAt,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError("Skill lifecycle request Journey event failed its canonical contract.");
  }
  return event;
}

// ── capability-candidate approval binding ─────────────────────────────

export type CapabilityLifecycleApprovalAction = "candidate_promoted" | "candidate_revoked" | "candidate_rolled_back";

export interface CapabilityLifecycleApprovalBindingV1 {
  schemaVersion: typeof CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION;
  scopeKind: "global";
  subjectKind: "capability_candidate";
  subjectId: string;
  action: CapabilityLifecycleApprovalAction;
  requestSha256: string;
  expectedStateSha256: string;
}

export function buildCapabilityLifecycleRequestSha256(input: {
  subjectId: string;
  action: CapabilityLifecycleApprovalAction;
  mutation: unknown;
}): string {
  const material = canonicalJsonString({
    schemaVersion: CAPABILITY_LIFECYCLE_REQUEST_VERSION,
    subjectKind: "capability_candidate",
    subjectId: requireCanonicalId(input.subjectId, "candidate ID"),
    action: input.action,
    mutation: input.mutation,
  });
  assertHashBoundary(material, "capability lifecycle request");
  return sha256(material);
}

export function buildCapabilityLifecycleStateSha256(state: unknown): string {
  const material = canonicalJsonString({ schemaVersion: "goatcitadel.capability-lifecycle-state.v1", state });
  assertHashBoundary(material, "capability lifecycle state");
  return sha256(material);
}

export function buildCapabilityLifecycleApprovalBinding(input: {
  subjectId: string;
  action: CapabilityLifecycleApprovalAction;
  mutation: unknown;
  expectedState: unknown;
}): CapabilityLifecycleApprovalBindingV1 {
  return {
    schemaVersion: CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION,
    scopeKind: "global",
    subjectKind: "capability_candidate",
    subjectId: requireCanonicalId(input.subjectId, "candidate ID"),
    action: input.action,
    requestSha256: buildCapabilityLifecycleRequestSha256(input),
    expectedStateSha256: buildCapabilityLifecycleStateSha256(input.expectedState),
  };
}

/** Fail-closed parse of the immutable `capabilityLifecycle` approval binding from an approval payload. */
export function parseCapabilityLifecycleApprovalBinding(
  value: unknown,
): CapabilityLifecycleApprovalBindingV1 | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schemaVersion",
    "scopeKind",
    "subjectKind",
    "subjectId",
    "action",
    "requestSha256",
    "expectedStateSha256",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.schemaVersion !== CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION ||
    value.scopeKind !== "global" ||
    value.subjectKind !== "capability_candidate" ||
    !isCanonicalId(value.subjectId) ||
    (value.action !== "candidate_promoted" &&
      value.action !== "candidate_revoked" &&
      value.action !== "candidate_rolled_back") ||
    !isSha256(value.requestSha256) ||
    !isSha256(value.expectedStateSha256)
  ) {
    return undefined;
  }
  return value as unknown as CapabilityLifecycleApprovalBindingV1;
}

export function deriveCapabilityLifecycleApprovalId(
  binding: Pick<CapabilityLifecycleApprovalBindingV1, "subjectId" | "action" | "requestSha256" | "expectedStateSha256">,
): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: CAPABILITY_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION,
        subjectKind: "capability_candidate",
        subjectId: binding.subjectId,
        action: binding.action,
        requestSha256: binding.requestSha256,
        expectedStateSha256: binding.expectedStateSha256,
      }),
    ),
  );
}

export interface CapabilityLifecycleRequestEnvelopeV1 {
  schemaVersion: typeof CAPABILITY_LIFECYCLE_REQUEST_ENVELOPE_VERSION;
  requesterId: string;
  mutation: unknown;
}

export function buildCapabilityLifecycleApprovalPayload(input: {
  binding: CapabilityLifecycleApprovalBindingV1;
  requesterId: string;
  mutation: unknown;
}): Record<string, unknown> {
  return JSON.parse(
    canonicalJsonString({
      capabilityLifecycle: input.binding,
      request: {
        schemaVersion: CAPABILITY_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: requireCanonicalId(input.requesterId, "requester ID"),
        mutation: input.mutation,
      } satisfies CapabilityLifecycleRequestEnvelopeV1,
    }),
  ) as Record<string, unknown>;
}

export function parseCapabilityLifecycleRequestEnvelope(
  payload: unknown,
): CapabilityLifecycleRequestEnvelopeV1 | undefined {
  const request = parseRequestEnvelope(payload, CAPABILITY_LIFECYCLE_REQUEST_ENVELOPE_VERSION);
  return request
    ? {
        schemaVersion: CAPABILITY_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: request.requesterId,
        mutation: request.mutation,
      }
    : undefined;
}

export function capabilityLifecycleRequestJourneyIdempotencyKey(approvalId: string): string {
  return `capability:lifecycle:request:${requireCanonicalId(approvalId, "approval ID")}`;
}

export function buildCapabilityLifecycleRequestJourneyEvent(input: {
  approval: Pick<ApprovalRequest, "approvalId" | "createdAt">;
  binding: CapabilityLifecycleApprovalBindingV1;
  requesterId: string;
}): GovernanceJourneyEventRecord {
  const approvalId = requireCanonicalId(input.approval.approvalId, "approval ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `capability:journey:request:${approvalId}`,
    idempotencyKey: capabilityLifecycleRequestJourneyIdempotencyKey(approvalId),
    scopeKind: "global",
    eventType: "capability_state_lifecycle",
    subjectKind: "capability_candidate",
    subjectId: input.binding.subjectId,
    action: "mutation_requested",
    actorId: requireCanonicalId(input.requesterId, "requester ID"),
    actorType: "operator",
    approvalId,
    fingerprint: input.binding.requestSha256,
    sourceKind: "approval",
    sourceId: approvalId,
    trustDisposition: "capability_mutation_requested",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: approvalId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      phase: "requested",
    },
    summary: {
      action: input.binding.action,
      subjectKind: "capability_candidate",
      skillMutationObserved: false,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.approval.createdAt,
    recordedAt: input.approval.createdAt,
  };
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError("Capability lifecycle request Journey event failed its canonical contract.");
  }
  return event;
}

// ── approved skill-state evidence (write-through the P0 owner) ────────

export interface ApprovedSkillLifecycleAuthority {
  approvalId: string;
  actorId: string;
  requesterId: string;
  occurredAt: string;
  requestSha256: string;
  expectedStateSha256: string;
}

export interface ApprovedSkillStateEvidenceInput {
  authority: ApprovedSkillLifecycleAuthority;
  skillId: string;
  state: SkillRuntimeState;
  noteSha256?: string;
  activationEventId: string;
  /** Position of this skill inside an approved bulk mutation, when applicable. */
  batchOperationIndex?: number;
}

export interface GovernedSkillLifecycleEvidence {
  event: GovernedLifecycleEventRecord;
  journeyEvent: GovernanceJourneyEventRecord;
}

const SKILL_STATE_OPERATIONS: Record<SkillRuntimeState, "enabled" | "disabled" | "slept"> = {
  enabled: "enabled",
  disabled: "disabled",
  sleep: "slept",
};

/**
 * Write one approved skill-state transition's immutable evidence pair: the
 * governed lifecycle event (P0 owner) and its Journey event, coupled
 * transactionally by `createWithJourney`. Exact replays converge
 * byte-identically; the same identity with different material conflicts inside
 * the owner.
 */
export function persistApprovedSkillStateEvidence(
  repository: GovernedLifecycleEventRepository,
  input: ApprovedSkillStateEvidenceInput,
): GovernedSkillLifecycleEvidence {
  const operation = SKILL_STATE_OPERATIONS[input.state];
  const skillId = requireCanonicalId(input.skillId, "skill ID");
  const eventId = `skill-lifecycle:${requireCanonicalId(input.authority.approvalId, "approval ID")}:${skillId}`;
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "skill_state",
    operation,
    targetKind: "skill",
    targetId: skillId,
    materialSha256: computeGovernedMutationMaterialSha256({
      approvalId: input.authority.approvalId,
      skillId,
      state: input.state,
      noteSha256: input.noteSha256 ?? null,
      requestSha256: input.authority.requestSha256,
      expectedStateSha256: input.authority.expectedStateSha256,
      ...(input.batchOperationIndex === undefined ? {} : { batchOperationIndex: input.batchOperationIndex }),
    }),
    scopeKind: "global",
    actorId: input.authority.actorId,
    actorType: "operator",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: requireCanonicalId(input.activationEventId, "activation event ID"),
    approvalId: input.authority.approvalId,
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `skill:journey:${eventId}`,
    idempotencyKey: `skill:lifecycle:${input.authority.approvalId}:${skillId}:${operation}`,
    scopeKind: "global",
    eventType: "skill_state_lifecycle",
    subjectKind: "skill",
    subjectId: skillId,
    action: operation,
    actorId: input.authority.actorId,
    actorType: "operator",
    approvalId: input.authority.approvalId,
    fingerprint: record.materialSha256,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: input.activationEventId,
    trustDisposition: "approved_skill_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.authority.approvalId },
      { owner: "governed_lifecycle", refId: eventId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.authority.requestSha256,
      requesterId: input.authority.requesterId,
      historyOwner: SKILL_STATE_SOURCE_KIND,
      ...(input.batchOperationIndex === undefined ? {} : { batchOperationIndex: input.batchOperationIndex }),
    },
    summary: {
      state: input.state,
      skillMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  assertJourney(journeyEvent, "Approved skill-state Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

export interface ApprovedActivationPolicyEvidenceInput {
  authority: ApprovedSkillLifecycleAuthority;
  policy: { guardedAutoThreshold: number; requireFirstUseConfirmation: boolean };
  activationEventId: string;
}

export function persistApprovedActivationPolicyEvidence(
  repository: GovernedLifecycleEventRepository,
  input: ApprovedActivationPolicyEvidenceInput,
): GovernedSkillLifecycleEvidence {
  const eventId = `skill-lifecycle:${requireCanonicalId(input.authority.approvalId, "approval ID")}:activation-policy`;
  const targetId = "skill-activation-policy:global";
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "skill_state",
    operation: "activation_policy_updated",
    targetKind: "skill_activation_policy",
    targetId,
    materialSha256: computeGovernedMutationMaterialSha256({
      approvalId: input.authority.approvalId,
      guardedAutoThreshold: input.policy.guardedAutoThreshold,
      requireFirstUseConfirmation: input.policy.requireFirstUseConfirmation,
      requestSha256: input.authority.requestSha256,
      expectedStateSha256: input.authority.expectedStateSha256,
    }),
    scopeKind: "global",
    actorId: input.authority.actorId,
    actorType: "operator",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: requireCanonicalId(input.activationEventId, "activation event ID"),
    approvalId: input.authority.approvalId,
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `skill:journey:${eventId}`,
    idempotencyKey: `skill:lifecycle:${input.authority.approvalId}:activation-policy`,
    scopeKind: "global",
    eventType: "skill_state_lifecycle",
    subjectKind: "skill_activation_policy",
    subjectId: targetId,
    action: "activation_policy_updated",
    actorId: input.authority.actorId,
    actorType: "operator",
    approvalId: input.authority.approvalId,
    fingerprint: record.materialSha256,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: input.activationEventId,
    trustDisposition: "approved_skill_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.authority.approvalId },
      { owner: "governed_lifecycle", refId: eventId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: SKILL_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.authority.requestSha256,
      requesterId: input.authority.requesterId,
      historyOwner: SKILL_STATE_SOURCE_KIND,
    },
    summary: {
      guardedAutoThreshold: input.policy.guardedAutoThreshold,
      requireFirstUseConfirmation: input.policy.requireFirstUseConfirmation,
      skillMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  assertJourney(journeyEvent, "Approved activation-policy Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

// ── approved capability-candidate evidence ────────────────────────────

export interface ApprovedCapabilityCandidateEvidenceInput {
  authority: ApprovedSkillLifecycleAuthority;
  candidateId: string;
  action: CapabilityLifecycleApprovalAction;
  selectedVersionId: string;
  changedVersionIds: readonly string[];
}

const CAPABILITY_ACTION_OPERATIONS: Record<CapabilityLifecycleApprovalAction, CapabilityStateGovernedOperation> = {
  candidate_promoted: "candidate_promoted",
  candidate_revoked: "candidate_revoked",
  candidate_rolled_back: "candidate_rolled_back",
};

export function persistApprovedCapabilityCandidateEvidence(
  repository: GovernedLifecycleEventRepository,
  input: ApprovedCapabilityCandidateEvidenceInput,
): GovernedSkillLifecycleEvidence {
  const candidateId = requireCanonicalId(input.candidateId, "candidate ID");
  const operation = CAPABILITY_ACTION_OPERATIONS[input.action];
  const eventId = `capability-lifecycle:${requireCanonicalId(input.authority.approvalId, "approval ID")}`;
  const changedVersionIds = [...input.changedVersionIds].sort(compareStrings);
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "capability_state",
    operation,
    targetKind: "capability_candidate",
    targetId: candidateId,
    materialSha256: computeGovernedMutationMaterialSha256({
      approvalId: input.authority.approvalId,
      candidateId,
      action: input.action,
      selectedVersionId: input.selectedVersionId,
      changedVersionIds,
      requestSha256: input.authority.requestSha256,
      expectedStateSha256: input.authority.expectedStateSha256,
    }),
    scopeKind: "global",
    actorId: input.authority.actorId,
    actorType: "operator",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: CAPABILITY_CANDIDATE_SOURCE_KIND,
    sourceId: requireCanonicalId(input.selectedVersionId, "version ID"),
    approvalId: input.authority.approvalId,
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `capability:journey:${eventId}`,
    idempotencyKey: `capability:lifecycle:${input.authority.approvalId}:${operation}`,
    scopeKind: "global",
    eventType: "capability_state_lifecycle",
    subjectKind: "capability_candidate",
    subjectId: candidateId,
    action: operation,
    actorId: input.authority.actorId,
    actorType: "operator",
    approvalId: input.authority.approvalId,
    fingerprint: record.materialSha256,
    sourceKind: CAPABILITY_CANDIDATE_SOURCE_KIND,
    sourceId: input.selectedVersionId,
    trustDisposition: "approved_capability_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.authority.approvalId },
      { owner: "candidate", refId: candidateId },
      { owner: "governed_lifecycle", refId: eventId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: CAPABILITY_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.authority.requestSha256,
      requesterId: input.authority.requesterId,
      historyOwner: CAPABILITY_CANDIDATE_SOURCE_KIND,
      changedVersionCount: changedVersionIds.length,
    },
    summary: {
      action: input.action,
      selectedVersionId: input.selectedVersionId,
      skillMutationObserved: true,
      journeyMutationAuthority: false,
      callable: input.action !== "candidate_revoked",
      directPromotion: false,
    },
    occurredAt: input.authority.occurredAt,
    recordedAt: input.authority.occurredAt,
  };
  assertJourney(journeyEvent, "Approved capability-candidate Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

// ── review-only capability proposal evidence (approval-free) ──────────

export interface CapabilityProposalCreatedEvidenceInput {
  proposalId: string;
  proposalKind: string;
  proposalEventId: string;
  actorId: string;
  occurredAt: string;
}

/**
 * Review-only proposal creation stays approval-free ONLY because the proposal
 * row, its proposal event (the source history), the governed lifecycle event,
 * and Journey all commit in ONE transaction — and the proposal remains
 * non-callable. The governed `proposal_created` kind declares
 * `sourceRequired: true, approvalRequired: false` in the frozen registry.
 */
export function persistCapabilityProposalCreatedEvidence(
  repository: GovernedLifecycleEventRepository,
  input: CapabilityProposalCreatedEvidenceInput,
): GovernedSkillLifecycleEvidence {
  const proposalId = requireCanonicalId(input.proposalId, "proposal ID");
  const eventId = `capability-lifecycle:proposal:${proposalId}`;
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "capability_state",
    operation: "proposal_created",
    targetKind: "capability_proposal",
    targetId: proposalId,
    materialSha256: computeGovernedMutationMaterialSha256({
      proposalId,
      proposalKind: input.proposalKind,
      proposalEventId: input.proposalEventId,
    }),
    scopeKind: "global",
    actorId: requireCanonicalId(input.actorId, "actor ID"),
    actorType: "operator",
    sourceRequired: true,
    approvalRequired: false,
    sourceKind: CAPABILITY_PROPOSAL_SOURCE_KIND,
    sourceId: requireCanonicalId(input.proposalEventId, "proposal event ID"),
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `capability:journey:${eventId}`,
    idempotencyKey: `capability:lifecycle:proposal:${proposalId}:created`,
    scopeKind: "global",
    eventType: "capability_state_lifecycle",
    subjectKind: "capability_proposal",
    subjectId: proposalId,
    action: "proposal_created",
    actorId: input.actorId,
    actorType: "operator",
    fingerprint: record.materialSha256,
    sourceKind: CAPABILITY_PROPOSAL_SOURCE_KIND,
    sourceId: input.proposalEventId,
    trustDisposition: "review_only_proposal",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "governed_lifecycle", refId: eventId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      historyOwner: CAPABILITY_PROPOSAL_SOURCE_KIND,
      reviewOnly: true,
    },
    summary: {
      proposalKind: input.proposalKind,
      skillMutationObserved: false,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  assertJourney(journeyEvent, "Capability proposal Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

// ── module-private fail-safe system authority (P1 brand pattern) ──────

const skillGovernanceAuthorityBrand: unique symbol = Symbol("goatcitadel.skill.governance-system-authority");
const skillGovernanceAuthorityToken: unique symbol = Symbol("goatcitadel.skill.governance-authority-construction");
const mintedSkillGovernanceAuthorities = new WeakSet<object>();

/**
 * Unforgeable module-private authority for fail-safe internal skill disable
 * and capability revoke. Route inputs can never mint one: instances only
 * exist through this module's construction token, membership is tracked in a
 * module-private WeakSet (JSON, spread, and prototype-graft copies all fail
 * the check), and serialization throws.
 */
export interface SkillGovernanceSystemAuthority {
  readonly actorId: typeof SKILL_GOVERNANCE_SYSTEM_ACTOR_ID;
  readonly [skillGovernanceAuthorityBrand]: true;
  toJSON(): never;
}

class SkillGovernanceSystemAuthorityValue {
  public readonly actorId = SKILL_GOVERNANCE_SYSTEM_ACTOR_ID;

  public constructor(token: typeof skillGovernanceAuthorityToken) {
    if (token !== skillGovernanceAuthorityToken) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Skill governance system authority cannot be constructed outside its owning module.",
      });
    }
    mintedSkillGovernanceAuthorities.add(this);
    Object.freeze(this);
  }

  public toJSON(): never {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Skill governance system authority never serializes.",
    });
  }
}

export function mintSkillGovernanceSystemAuthority(): SkillGovernanceSystemAuthority {
  return new SkillGovernanceSystemAuthorityValue(
    skillGovernanceAuthorityToken,
  ) as unknown as SkillGovernanceSystemAuthority;
}

export function isSkillGovernanceSystemAuthority(value: unknown): value is SkillGovernanceSystemAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    mintedSkillGovernanceAuthorities.has(value) &&
    (value as { actorId?: unknown }).actorId === SKILL_GOVERNANCE_SYSTEM_ACTOR_ID
  );
}

export interface SkillSystemDisableEvidenceInput {
  authority: SkillGovernanceSystemAuthority;
  skillId: string;
  reasonCode: string;
  activationEventId: string;
  occurredAt: string;
}

/**
 * Fail-safe internal disable evidence: the `system_disabled` governed event is
 * system-actor-only in the frozen registry, and this producer only writes it
 * for a WeakSet-verified module-private authority — an operator or
 * approval-effect payload can never reach it. The canonical `skill_state`
 * mutation, its `skill_activation_events` source row, and this evidence pair
 * commit inside one transaction.
 */
export function persistSkillSystemDisableEvidence(
  repository: GovernedLifecycleEventRepository,
  input: SkillSystemDisableEvidenceInput,
): GovernedSkillLifecycleEvidence {
  if (!isSkillGovernanceSystemAuthority(input.authority)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Fail-safe skill disable requires the module-private system authority.",
    });
  }
  const skillId = requireCanonicalId(input.skillId, "skill ID");
  const activationEventId = requireCanonicalId(input.activationEventId, "activation event ID");
  const eventId = `skill-lifecycle:system-disable:${activationEventId}`;
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "skill_state",
    operation: "system_disabled",
    targetKind: "skill",
    targetId: skillId,
    materialSha256: computeGovernedMutationMaterialSha256({
      skillId,
      reasonCode: input.reasonCode,
      activationEventId,
    }),
    scopeKind: "global",
    actorId: input.authority.actorId,
    actorType: "system",
    sourceRequired: true,
    approvalRequired: false,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: activationEventId,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `skill:journey:${eventId}`,
    idempotencyKey: `skill:lifecycle:system-disable:${activationEventId}`,
    scopeKind: "global",
    eventType: "skill_state_lifecycle",
    subjectKind: "skill",
    subjectId: skillId,
    action: "system_disabled",
    actorId: input.authority.actorId,
    actorType: "system",
    fingerprint: record.materialSha256,
    sourceKind: SKILL_STATE_SOURCE_KIND,
    sourceId: activationEventId,
    trustDisposition: "system_skill_failsafe",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "governed_lifecycle", refId: eventId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      systemAuthority: "skill_governance",
      reasonCode: input.reasonCode,
      historyOwner: SKILL_STATE_SOURCE_KIND,
    },
    summary: {
      state: "disabled",
      reasonCode: input.reasonCode,
      skillMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  assertJourney(journeyEvent, "Skill system-disable Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

export interface CapabilitySystemRevokeEvidenceInput {
  authority: SkillGovernanceSystemAuthority;
  candidateId: string;
  revokedVersionIds: readonly string[];
  reasonCode: string;
  occurredAt: string;
}

/**
 * Fail-safe internal capability revoke evidence: `system_revoked` is
 * system-actor-only in the frozen registry and reachable only through the
 * WeakSet-verified module-private authority.
 */
export function persistCapabilitySystemRevokeEvidence(
  repository: GovernedLifecycleEventRepository,
  input: CapabilitySystemRevokeEvidenceInput,
): GovernedSkillLifecycleEvidence {
  if (!isSkillGovernanceSystemAuthority(input.authority)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Fail-safe capability revoke requires the module-private system authority.",
    });
  }
  const candidateId = requireCanonicalId(input.candidateId, "candidate ID");
  const revokedVersionIds = [...input.revokedVersionIds].sort(compareStrings);
  const primaryVersionId = revokedVersionIds[0];
  if (!primaryVersionId) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Fail-safe capability revoke requires at least one revoked version.",
    });
  }
  const eventId = `capability-lifecycle:system-revoke:${candidateId}:${sha256(
    canonicalJsonString(revokedVersionIds),
  ).slice(0, 32)}`;
  const record: GovernedLifecycleEventRecord = {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId,
    idempotencyKey: eventId,
    domain: "capability_state",
    operation: "system_revoked",
    targetKind: "capability_candidate",
    targetId: candidateId,
    materialSha256: computeGovernedMutationMaterialSha256({
      candidateId,
      revokedVersionIds,
      reasonCode: input.reasonCode,
    }),
    scopeKind: "global",
    actorId: input.authority.actorId,
    actorType: "system",
    sourceRequired: true,
    approvalRequired: false,
    sourceKind: CAPABILITY_CANDIDATE_SOURCE_KIND,
    sourceId: primaryVersionId,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  const journeyEvent: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `capability:journey:${eventId}`,
    idempotencyKey: `capability:lifecycle:system-revoke:${candidateId}:${record.materialSha256.slice(0, 32)}`,
    scopeKind: "global",
    eventType: "capability_state_lifecycle",
    subjectKind: "capability_candidate",
    subjectId: candidateId,
    action: "system_revoked",
    actorId: input.authority.actorId,
    actorType: "system",
    fingerprint: record.materialSha256,
    sourceKind: CAPABILITY_CANDIDATE_SOURCE_KIND,
    sourceId: primaryVersionId,
    trustDisposition: "system_capability_failsafe",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "candidate", refId: candidateId },
      { owner: "governed_lifecycle", refId: eventId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      systemAuthority: "skill_governance",
      reasonCode: input.reasonCode,
      historyOwner: CAPABILITY_CANDIDATE_SOURCE_KIND,
      revokedVersionCount: revokedVersionIds.length,
    },
    summary: {
      reasonCode: input.reasonCode,
      skillMutationObserved: true,
      journeyMutationAuthority: false,
      callable: false,
      directPromotion: false,
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  assertJourney(journeyEvent, "Capability system-revoke Journey event failed its canonical contract.");
  return writeCoupledEvidence(repository, record, journeyEvent);
}

// ── recovered-effect error taxonomy (P1's terminal/defer split) ───────

export type SkillLifecycleApplyErrorCode =
  | "skill_lifecycle_approval_not_executable"
  | "skill_lifecycle_approval_expired"
  | "skill_lifecycle_request_evidence_missing"
  | "skill_lifecycle_request_drift"
  | "skill_lifecycle_state_drift"
  | "skill_lifecycle_policy_blocked"
  | "skill_lifecycle_apply_conflict";

const SKILL_APPLY_ERROR_MESSAGES: Record<SkillLifecycleApplyErrorCode, string> = {
  skill_lifecycle_approval_not_executable: "Skill lifecycle approval is missing, foreign, malformed, or not approved.",
  skill_lifecycle_approval_expired: "Skill lifecycle approval expired before its recovered effect executed.",
  skill_lifecycle_request_evidence_missing: "Skill lifecycle request Journey evidence is missing or mismatched.",
  skill_lifecycle_request_drift: "Skill lifecycle request material does not reproduce its approved hash.",
  skill_lifecycle_state_drift: "Skill state drifted from the exact reviewed material the approval bound.",
  skill_lifecycle_policy_blocked: "Skill lifecycle policy blocks this mutation at execution time.",
  skill_lifecycle_apply_conflict: "Skill lifecycle mutation conflicts with canonical state.",
};

/** Terminal governance failure of one approved skill mutation effect: fail closed, never retried. */
export class SkillLifecycleApplyError extends Error {
  public readonly code: SkillLifecycleApplyErrorCode;

  public constructor(code: SkillLifecycleApplyErrorCode) {
    super(SKILL_APPLY_ERROR_MESSAGES[code]);
    this.name = "SkillLifecycleApplyError";
    this.code = code;
  }
}

export type CapabilityLifecycleApplyErrorCode =
  | "capability_lifecycle_approval_not_executable"
  | "capability_lifecycle_approval_expired"
  | "capability_lifecycle_request_evidence_missing"
  | "capability_lifecycle_request_drift"
  | "capability_lifecycle_state_drift"
  | "capability_lifecycle_apply_conflict";

const CAPABILITY_APPLY_ERROR_MESSAGES: Record<CapabilityLifecycleApplyErrorCode, string> = {
  capability_lifecycle_approval_not_executable:
    "Capability lifecycle approval is missing, foreign, malformed, or not approved.",
  capability_lifecycle_approval_expired: "Capability lifecycle approval expired before its recovered effect executed.",
  capability_lifecycle_request_evidence_missing:
    "Capability lifecycle request Journey evidence is missing or mismatched.",
  capability_lifecycle_request_drift: "Capability lifecycle request material does not reproduce its approved hash.",
  capability_lifecycle_state_drift:
    "Capability candidate state drifted from the exact reviewed material the approval bound.",
  capability_lifecycle_apply_conflict: "Capability lifecycle mutation conflicts with canonical state.",
};

/** Terminal governance failure of one approved capability mutation effect: fail closed, never retried. */
export class CapabilityLifecycleApplyError extends Error {
  public readonly code: CapabilityLifecycleApplyErrorCode;

  public constructor(code: CapabilityLifecycleApplyErrorCode) {
    super(CAPABILITY_APPLY_ERROR_MESSAGES[code]);
    this.name = "CapabilityLifecycleApplyError";
    this.code = code;
  }
}

// ── local helpers ─────────────────────────────────────────────────────

function writeCoupledEvidence(
  repository: GovernedLifecycleEventRepository,
  record: GovernedLifecycleEventRecord,
  journeyEvent: GovernanceJourneyEventRecord,
): GovernedSkillLifecycleEvidence {
  const { event, journeyEvents } = repository.createWithJourney(record, () => [journeyEvent]);
  const storedJourney = journeyEvents[0];
  if (!storedJourney) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Governed skill lifecycle event ${record.eventId} lost its transactional Journey coupling.`,
    });
  }
  return { event, journeyEvent: storedJourney };
}

function parseRequestEnvelope(
  payload: unknown,
  schemaVersion: string,
): { requesterId: string; mutation: unknown } | undefined {
  if (!isRecord(payload)) return undefined;
  const request = payload.request;
  if (!isRecord(request)) return undefined;
  const keys = Object.keys(request).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["mutation", "requesterId", "schemaVersion"])) {
    return undefined;
  }
  if (
    request.schemaVersion !== schemaVersion ||
    !isCanonicalId(request.requesterId) ||
    request.mutation === undefined
  ) {
    return undefined;
  }
  return { requesterId: request.requesterId, mutation: request.mutation };
}

function assertJourney(event: GovernanceJourneyEventRecord, message: string): void {
  if (!isGovernanceJourneyEventRecord(event)) {
    throw new TypeError(message);
  }
}

function uuidFromDigest(digest: string): string {
  const material = digest.slice(0, 32);
  return [
    material.slice(0, 8),
    material.slice(8, 12),
    material.slice(12, 16),
    material.slice(16, 20),
    material.slice(20, 32),
  ].join("-");
}

function assertHashBoundary(material: string, label: string): void {
  if (Buffer.byteLength(material, "utf8") > 1_048_576) {
    throw new TypeError(`Approved ${label} material exceeds the one-megabyte hash boundary.`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireBoundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new TypeError("Skill lifecycle target count is out of bounds.");
  }
  return value;
}

function requireCanonicalId(value: unknown, label: string): string {
  if (!isCanonicalId(value)) throw new TypeError(`Skill governance ${label} is invalid.`);
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
