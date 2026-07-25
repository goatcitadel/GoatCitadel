import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  IMPROVEMENT_LIFECYCLE_APPROVAL_KIND,
  isGovernanceJourneyEventRecord,
  isImprovementLifecycleOperationKind,
  isImprovementLifecycleTargetKind,
  type ApprovalRequest,
  type GovernanceJourneyEventRecord,
  type ImprovementLifecycleOperationKind,
  type ImprovementLifecycleSettlementDisposition,
  type ImprovementLifecycleTargetKind,
} from "@goatcitadel/contracts";
import { ImprovementLifecycleOperationRepository, type DatabaseClient } from "@goatcitadel/storage";
import { isRecord } from "./companion-auth-helpers.js";

/**
 * HX-402 P3: canonical builders, parsers, and evidence writers for the
 * approval-first improvement activate/pause/rollback surface. The request
 * verbs bind one deterministic `improvement.lifecycle` approval to the exact
 * mutation AND the exact reviewed database state, plus immutable requester
 * Journey evidence; the recovered effect creates the durable P0 intent and the
 * worker settles it through claim -> external callback -> exact re-inspection.
 * External state never participates in the reviewed-state hash: it is judged
 * exclusively by the inspection ladder so crash recovery can converge on an
 * already-applied callback instead of misreading it as drift.
 */

export const IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION = "goatcitadel.improvement-lifecycle-approval.v1" as const;
export const IMPROVEMENT_LIFECYCLE_REQUEST_VERSION = "goatcitadel.improvement-lifecycle-request.v1" as const;
export const IMPROVEMENT_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION =
  "goatcitadel.improvement-lifecycle-approval-id.v1" as const;
export const IMPROVEMENT_LIFECYCLE_REQUEST_ENVELOPE_VERSION =
  "goatcitadel.improvement-lifecycle-request-envelope.v1" as const;
export const IMPROVEMENT_LIFECYCLE_OPERATION_ID_SCHEMA_VERSION =
  "goatcitadel.improvement-lifecycle-operation-id.v1" as const;
export const IMPROVEMENT_LIFECYCLE_STATE_VERSION = "goatcitadel.improvement-lifecycle-state.v1" as const;
export const IMPROVEMENT_LIFECYCLE_OBSERVED_STATE_VERSION =
  "goatcitadel.improvement-lifecycle-observed-state.v1" as const;

// ── shared SQL-host adapter (P1/P2 pattern) ───────────────────────────

interface ImprovementLifecycleSqlHost {
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
 * improvement operation repository needs. Only `prepare` and immediate
 * `transaction` are real; both dialects' clients make the inner transaction a
 * nested-safe savepoint, so claim admission and settlement compose inside the
 * worker's own settlement transaction.
 */
export function createImprovementLifecycleOperationRepository(
  host: ImprovementLifecycleSqlHost,
): ImprovementLifecycleOperationRepository {
  const runImmediateTransaction = host.runImmediateTransaction;
  if (typeof runImmediateTransaction !== "function") {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Governed improvement lifecycle operations require transactional gateway storage.",
    });
  }
  const client: DatabaseClient = {
    dialect: host.dialect,
    prepare: (sql: string) => host.prepare(sql) as ReturnType<DatabaseClient["prepare"]>,
    exec: () => {
      throw new Error("Governed improvement lifecycle adapter does not execute raw SQL scripts.");
    },
    close: () => {
      throw new Error("Governed improvement lifecycle adapter does not own the database connection.");
    },
    transaction: <T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T =>
      runImmediateTransaction.call(host, callback) as T,
  };
  return new ImprovementLifecycleOperationRepository(client);
}

// ── approval binding ──────────────────────────────────────────────────

export interface ImprovementLifecycleApprovalBindingV1 {
  schemaVersion: typeof IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION;
  scopeKind: "workspace";
  workspaceId: string;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  requestSha256: string;
  expectedStateSha256: string;
}

export function buildImprovementLifecycleRequestSha256(input: {
  workspaceId: string;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  mutation: unknown;
}): string {
  const material = canonicalJsonString({
    schemaVersion: IMPROVEMENT_LIFECYCLE_REQUEST_VERSION,
    workspaceId: requireCanonicalId(input.workspaceId, "workspace ID"),
    operationKind: input.operationKind,
    targetKind: input.targetKind,
    targetId: requireCanonicalId(input.targetId, "target ID"),
    mutation: input.mutation,
  });
  assertHashBoundary(material, "improvement lifecycle request");
  return sha256(material);
}

/**
 * The exact reviewed DATABASE state the approval binds (candidate/activation
 * rows). External policy state is deliberately excluded: the worker judges it
 * through the pre/post inspection ladder against the hash-bound `preState` and
 * `targetState` mutation members, which is what lets crash recovery converge
 * on an already-executed callback without a false state-drift abort.
 */
export function buildImprovementLifecycleStateSha256(state: unknown): string {
  const material = canonicalJsonString({ schemaVersion: IMPROVEMENT_LIFECYCLE_STATE_VERSION, state });
  assertHashBoundary(material, "improvement lifecycle state");
  return sha256(material);
}

export function buildImprovementLifecycleApprovalBinding(input: {
  workspaceId: string;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  mutation: unknown;
  expectedState: unknown;
}): ImprovementLifecycleApprovalBindingV1 {
  return {
    schemaVersion: IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION,
    scopeKind: "workspace",
    workspaceId: requireCanonicalId(input.workspaceId, "workspace ID"),
    operationKind: input.operationKind,
    targetKind: input.targetKind,
    targetId: requireCanonicalId(input.targetId, "target ID"),
    requestSha256: buildImprovementLifecycleRequestSha256(input),
    expectedStateSha256: buildImprovementLifecycleStateSha256(input.expectedState),
  };
}

/** Fail-closed parse of the immutable `improvementLifecycle` approval binding. */
export function parseImprovementLifecycleApprovalBinding(
  value: unknown,
): ImprovementLifecycleApprovalBindingV1 | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schemaVersion",
    "scopeKind",
    "workspaceId",
    "operationKind",
    "targetKind",
    "targetId",
    "requestSha256",
    "expectedStateSha256",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    value.schemaVersion !== IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION ||
    value.scopeKind !== "workspace" ||
    !isCanonicalId(value.workspaceId) ||
    !isImprovementLifecycleOperationKind(value.operationKind) ||
    !isImprovementLifecycleTargetKind(value.targetKind) ||
    !isCanonicalId(value.targetId) ||
    !isSha256(value.requestSha256) ||
    !isSha256(value.expectedStateSha256)
  ) {
    return undefined;
  }
  return value as unknown as ImprovementLifecycleApprovalBindingV1;
}

/**
 * Deterministic server-owned approval identity for one exact improvement
 * mutation request against one exact reviewed state (the P1/P2 discipline):
 * byte-exact replays converge on the original approval row while the same
 * mutation over drifted state is a different approval. Formatted as a UUID so
 * the shipped approval resolve surface accepts it.
 */
export function deriveImprovementLifecycleApprovalId(
  binding: Pick<
    ImprovementLifecycleApprovalBindingV1,
    "workspaceId" | "operationKind" | "targetKind" | "targetId" | "requestSha256" | "expectedStateSha256"
  >,
): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: IMPROVEMENT_LIFECYCLE_APPROVAL_ID_SCHEMA_VERSION,
        workspaceId: binding.workspaceId,
        operationKind: binding.operationKind,
        targetKind: binding.targetKind,
        targetId: binding.targetId,
        requestSha256: binding.requestSha256,
        expectedStateSha256: binding.expectedStateSha256,
      }),
    ),
  );
}

/** Deterministic durable-operation identity: exactly one intent per approval. */
export function deriveImprovementLifecycleOperationId(approvalId: string): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: IMPROVEMENT_LIFECYCLE_OPERATION_ID_SCHEMA_VERSION,
        kind: "operation",
        approvalId: requireCanonicalId(approvalId, "approval ID"),
      }),
    ),
  );
}

export function improvementLifecycleOperationIdempotencyKey(approvalId: string): string {
  return `improvement:lifecycle:operation:${requireCanonicalId(approvalId, "approval ID")}`;
}

/** Deterministic settlement identity so crash-retried settlements converge. */
export function deriveImprovementLifecycleSettlementId(operationId: string): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: IMPROVEMENT_LIFECYCLE_OPERATION_ID_SCHEMA_VERSION,
        kind: "settlement",
        operationId: requireCanonicalId(operationId, "operation ID"),
      }),
    ),
  );
}

/** Deterministic activation-row identity for the governed activate apply. */
export function deriveImprovementLifecycleActivationId(operationId: string): string {
  return uuidFromDigest(
    sha256(
      canonicalJsonString({
        schemaVersion: IMPROVEMENT_LIFECYCLE_OPERATION_ID_SCHEMA_VERSION,
        kind: "activation",
        operationId: requireCanonicalId(operationId, "operation ID"),
      }),
    ),
  );
}

/** Deterministic per-claim inspection identity (`pre` observation vs post-callback `post`). */
export function deriveImprovementLifecycleInspectionId(
  operationId: string,
  claimGeneration: number,
  phase: "pre" | "post",
): string {
  if (!Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
    throw new TypeError("Improvement lifecycle inspection identity requires a positive claim generation.");
  }
  return `improvement-inspection:${requireCanonicalId(operationId, "operation ID")}:${claimGeneration}:${phase}`;
}

// ── request envelope ──────────────────────────────────────────────────

export interface ImprovementLifecycleRequestEnvelopeV1 {
  schemaVersion: typeof IMPROVEMENT_LIFECYCLE_REQUEST_ENVELOPE_VERSION;
  requesterId: string;
  mutation: unknown;
}

export function buildImprovementLifecycleApprovalPayload(input: {
  binding: ImprovementLifecycleApprovalBindingV1;
  requesterId: string;
  mutation: unknown;
}): Record<string, unknown> {
  return JSON.parse(
    canonicalJsonString({
      improvementLifecycle: input.binding,
      request: {
        schemaVersion: IMPROVEMENT_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
        requesterId: requireCanonicalId(input.requesterId, "requester ID"),
        mutation: input.mutation,
      } satisfies ImprovementLifecycleRequestEnvelopeV1,
    }),
  ) as Record<string, unknown>;
}

/** Fail-closed parse of the immutable request envelope stored on the approval payload. */
export function parseImprovementLifecycleRequestEnvelope(
  payload: unknown,
): ImprovementLifecycleRequestEnvelopeV1 | undefined {
  if (!isRecord(payload)) return undefined;
  const request = payload.request;
  if (!isRecord(request)) return undefined;
  const keys = Object.keys(request).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["mutation", "requesterId", "schemaVersion"])) {
    return undefined;
  }
  if (
    request.schemaVersion !== IMPROVEMENT_LIFECYCLE_REQUEST_ENVELOPE_VERSION ||
    !isCanonicalId(request.requesterId) ||
    request.mutation === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: IMPROVEMENT_LIFECYCLE_REQUEST_ENVELOPE_VERSION,
    requesterId: request.requesterId,
    mutation: request.mutation,
  };
}

// ── mutation payloads ─────────────────────────────────────────────────

/**
 * The exact external-state observation material: whether the policy target key
 * holds a value and which value. `value` is the canonical policy JSON; the
 * observed hash is computed over this material, never over raw protected
 * content beyond the policy payload the approval itself already carries.
 */
export interface ImprovementExternalStateMaterial {
  hadValue: boolean;
  value: unknown;
}

export function computeImprovementLifecycleObservedStateSha256(material: ImprovementExternalStateMaterial): string {
  const canonical = canonicalJsonString({
    schemaVersion: IMPROVEMENT_LIFECYCLE_OBSERVED_STATE_VERSION,
    hadValue: material.hadValue === true,
    value: material.value ?? null,
  });
  assertHashBoundary(canonical, "improvement lifecycle observed state");
  return sha256(canonical);
}

export interface ImprovementActivateMutationV1 {
  candidateId: string;
  revisionId: string;
  changeHash: string;
  kind: "repair_policy" | "routing_policy";
  targetKey: string;
  preState: ImprovementExternalStateMaterial;
  targetState: ImprovementExternalStateMaterial;
}

export interface ImprovementPauseRollbackMutationV1 {
  activationId: string;
  preState: ImprovementExternalStateMaterial;
  targetState: ImprovementExternalStateMaterial;
}

function parseExternalStateMaterial(value: unknown): ImprovementExternalStateMaterial | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["hadValue", "value"])) return undefined;
  if (typeof value.hadValue !== "boolean") return undefined;
  return { hadValue: value.hadValue, value: value.value };
}

export function parseImprovementActivateMutation(value: unknown): ImprovementActivateMutationV1 | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (
    canonicalJsonString(keys) !==
    canonicalJsonString(["candidateId", "changeHash", "kind", "preState", "revisionId", "targetKey", "targetState"])
  ) {
    return undefined;
  }
  const preState = parseExternalStateMaterial(value.preState);
  const targetState = parseExternalStateMaterial(value.targetState);
  if (
    !isCanonicalId(value.candidateId) ||
    !isCanonicalId(value.revisionId) ||
    typeof value.changeHash !== "string" ||
    !value.changeHash.trim() ||
    (value.kind !== "repair_policy" && value.kind !== "routing_policy") ||
    !isCanonicalId(value.targetKey) ||
    !preState ||
    !targetState
  ) {
    return undefined;
  }
  return {
    candidateId: value.candidateId,
    revisionId: value.revisionId,
    changeHash: value.changeHash,
    kind: value.kind,
    targetKey: value.targetKey,
    preState,
    targetState,
  };
}

export function parseImprovementPauseRollbackMutation(value: unknown): ImprovementPauseRollbackMutationV1 | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (canonicalJsonString(keys) !== canonicalJsonString(["activationId", "preState", "targetState"])) {
    return undefined;
  }
  const preState = parseExternalStateMaterial(value.preState);
  const targetState = parseExternalStateMaterial(value.targetState);
  if (!isCanonicalId(value.activationId) || !preState || !targetState) return undefined;
  return { activationId: value.activationId, preState, targetState };
}

// ── Journey evidence ──────────────────────────────────────────────────

export function improvementLifecycleRequestJourneyIdempotencyKey(approvalId: string): string {
  return `improvement:lifecycle:request:${requireCanonicalId(approvalId, "approval ID")}`;
}

/**
 * The content-free requester Journey evidence committed atomically with the
 * `improvement.lifecycle` approval row. Approval linkage cannot carry the
 * requesting actor, so the recovered effect recovers it from this immutable
 * event and fails closed when the evidence is missing.
 */
export function buildImprovementLifecycleRequestJourneyEvent(input: {
  approval: Pick<ApprovalRequest, "approvalId" | "createdAt">;
  binding: ImprovementLifecycleApprovalBindingV1;
  requesterId: string;
}): GovernanceJourneyEventRecord {
  const approvalId = requireCanonicalId(input.approval.approvalId, "approval ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `improvement:journey:request:${approvalId}`,
    idempotencyKey: improvementLifecycleRequestJourneyIdempotencyKey(approvalId),
    scopeKind: "workspace",
    workspaceId: input.binding.workspaceId,
    eventType: "improvement_lifecycle",
    subjectKind: input.binding.targetKind,
    subjectId: input.binding.targetId,
    action: "mutation_requested",
    actorId: requireCanonicalId(input.requesterId, "requester ID"),
    actorType: "operator",
    approvalId,
    fingerprint: input.binding.requestSha256,
    sourceKind: "approval",
    sourceId: approvalId,
    trustDisposition: "improvement_mutation_requested",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: approvalId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      phase: "requested",
    },
    summary: {
      operationKind: input.binding.operationKind,
      targetKind: input.binding.targetKind,
      mutationApplied: false,
      journeyMutationAuthority: false,
    },
    occurredAt: input.approval.createdAt,
    recordedAt: input.approval.createdAt,
  };
  assertJourney(event, "Improvement lifecycle request Journey event failed its canonical contract.");
  return event;
}

/**
 * The settlement Journey evidence committed in the SAME immediate transaction
 * as the canonical activation/candidate state, the immutable settlement, and
 * the canonical signal. It cites both the approval and the durable operation.
 */
export function buildImprovementLifecycleSettlementJourneyEvent(input: {
  binding: ImprovementLifecycleApprovalBindingV1;
  approvalId: string;
  operationId: string;
  settlementId: string;
  inspectionId: string;
  claimGeneration: number;
  disposition: ImprovementLifecycleSettlementDisposition;
  observedStateSha256: string;
  actorId: string;
  requesterId: string;
  occurredAt: string;
  activationId?: string;
  reasonCode?: string;
}): GovernanceJourneyEventRecord {
  const operationId = requireCanonicalId(input.operationId, "operation ID");
  const event: GovernanceJourneyEventRecord = {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `improvement:journey:settled:${operationId}`,
    idempotencyKey: `improvement:lifecycle:settled:${operationId}`,
    scopeKind: "workspace",
    workspaceId: input.binding.workspaceId,
    eventType: "improvement_lifecycle",
    subjectKind: input.binding.targetKind,
    subjectId: input.binding.targetId,
    action: `${input.binding.operationKind}_${input.disposition}`,
    actorId: requireCanonicalId(input.actorId, "actor ID"),
    actorType: "approval_effect",
    approvalId: requireCanonicalId(input.approvalId, "approval ID"),
    fingerprint: input.binding.requestSha256,
    sourceKind: "improvement_lifecycle_settlement",
    sourceId: requireCanonicalId(input.settlementId, "settlement ID"),
    trustDisposition: "approved_improvement_mutation",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.approvalId },
      { owner: "improvement_operation", refId: operationId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired: true,
      approvalBindingVersion: IMPROVEMENT_LIFECYCLE_APPROVAL_BINDING_VERSION,
      requestSha256: input.binding.requestSha256,
      requesterId: requireCanonicalId(input.requesterId, "requester ID"),
      settlementId: input.settlementId,
      inspectionId: requireCanonicalId(input.inspectionId, "inspection ID"),
      claimGeneration: input.claimGeneration,
      observedStateSha256: input.observedStateSha256,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    },
    summary: {
      operationKind: input.binding.operationKind,
      targetKind: input.binding.targetKind,
      disposition: input.disposition,
      mutationApplied: input.disposition === "applied",
      journeyMutationAuthority: false,
      ...(input.activationId === undefined ? {} : { activationId: input.activationId }),
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
  assertJourney(event, "Improvement lifecycle settlement Journey event failed its canonical contract.");
  return event;
}

// ── terminal apply errors ─────────────────────────────────────────────

export type ImprovementLifecycleApplyErrorCode =
  | "improvement_lifecycle_approval_not_executable"
  | "improvement_lifecycle_approval_expired"
  | "improvement_lifecycle_request_evidence_missing"
  | "improvement_lifecycle_request_drift"
  | "improvement_lifecycle_state_drift"
  | "improvement_lifecycle_apply_conflict";

const IMPROVEMENT_APPLY_ERROR_MESSAGES: Record<ImprovementLifecycleApplyErrorCode, string> = {
  improvement_lifecycle_approval_not_executable:
    "Improvement lifecycle approval is missing, foreign, malformed, or not approved.",
  improvement_lifecycle_approval_expired:
    "Improvement lifecycle approval expired before its recovered effect executed.",
  improvement_lifecycle_request_evidence_missing:
    "Improvement lifecycle request Journey evidence is missing or mismatched.",
  improvement_lifecycle_request_drift: "Improvement lifecycle request material does not reproduce its approved hash.",
  improvement_lifecycle_state_drift:
    "Improvement lifecycle state drifted from the exact reviewed material the approval bound.",
  improvement_lifecycle_apply_conflict: "Improvement lifecycle mutation conflicts with canonical state.",
};

/** Terminal governance failure of one approved improvement mutation effect: fail closed, never retried. */
export class ImprovementLifecycleApplyError extends Error {
  public readonly code: ImprovementLifecycleApplyErrorCode;

  public constructor(code: ImprovementLifecycleApplyErrorCode) {
    super(IMPROVEMENT_APPLY_ERROR_MESSAGES[code]);
    this.name = "ImprovementLifecycleApplyError";
    this.code = code;
  }
}

export { IMPROVEMENT_LIFECYCLE_APPROVAL_KIND };

// ── local helpers ─────────────────────────────────────────────────────

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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function requireCanonicalId(value: string, label: string): string {
  if (!isCanonicalId(value)) {
    throw new TypeError(`Improvement lifecycle ${label} must be a bounded non-empty identifier.`);
  }
  return value;
}
