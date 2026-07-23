import {
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  computeImprovementLifecycleResultSha256,
  isImprovementLifecycleInspectionDisposition,
  isImprovementLifecycleOperationKind,
  isImprovementLifecycleSettlementDisposition,
  isImprovementLifecycleTargetKind,
  type ImprovementLifecycleClaimRecord,
  type ImprovementLifecycleInspectionRecord,
  type ImprovementLifecycleOperationRecord,
  type ImprovementLifecycleSettlementRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

/**
 * HX-402 P0: the durable improvement intent -> claim -> inspection ->
 * settlement owner. External improvement effects are NEVER database-atomic;
 * this state machine is the crash-recovery truth. Intents are immutable and
 * bound one-to-one to a fresh approval; claims are append-only monotonic
 * generations with database-clock stale-lease fencing (one winner per
 * generation); settlements are immutable, cite an exact same-claim
 * re-inspection, and can never report `applied` without a
 * `matches_intent` observation.
 */
interface ImprovementOperationRow {
  operation_id: string;
  idempotency_key: string;
  workspace_id: string;
  operation_kind: ImprovementLifecycleOperationRecord["operationKind"];
  target_kind: ImprovementLifecycleOperationRecord["targetKind"];
  target_id: string;
  approval_id: string;
  request_sha256: string;
  actor_id: string;
  session_id: string | null;
  turn_id: string | null;
  created_at: string;
}

interface ImprovementClaimRow {
  operation_id: string;
  claim_generation: number | string;
  worker_id: string;
  claimed_at: string;
  lease_expires_at: string;
}

interface ImprovementInspectionRow {
  inspection_id: string;
  operation_id: string;
  claim_generation: number | string;
  observed_state_sha256: string;
  disposition: ImprovementLifecycleInspectionRecord["disposition"];
  observed_at: string;
}

interface ImprovementSettlementRow {
  settlement_id: string;
  operation_id: string;
  claim_generation: number | string;
  inspection_id: string;
  disposition: ImprovementLifecycleSettlementRecord["disposition"];
  observed_state_sha256: string;
  result_json: string;
  result_sha256: string;
  settled_at: string;
}

export class ImprovementLifecycleOperationRepository {
  private readonly insertOperationStmt;
  private readonly getOperationStmt;
  private readonly findOperationByIdempotencyStmt;
  private readonly findOperationByApprovalStmt;
  private readonly insertClaimStmt;
  private readonly currentClaimStmt;
  private readonly insertInspectionStmt;
  private readonly getInspectionStmt;
  private readonly insertSettlementStmt;
  private readonly getSettlementStmt;
  private readonly findSettlementByOperationStmt;
  private readonly listUnsettledStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertOperationStmt = db.prepare(`
      INSERT INTO improvement_lifecycle_operations (
        operation_id, idempotency_key, workspace_id, operation_kind, target_kind, target_id,
        approval_id, request_sha256, actor_id, session_id, turn_id, created_at
      ) VALUES (
        @operationId, @idempotencyKey, @workspaceId, @operationKind, @targetKind, @targetId,
        @approvalId, @requestSha256, @actorId, @sessionId, @turnId, @createdAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getOperationStmt = db.prepare("SELECT * FROM improvement_lifecycle_operations WHERE operation_id = ?");
    this.findOperationByIdempotencyStmt = db.prepare(
      "SELECT * FROM improvement_lifecycle_operations WHERE idempotency_key = ?",
    );
    this.findOperationByApprovalStmt = db.prepare(
      "SELECT * FROM improvement_lifecycle_operations WHERE approval_id = ?",
    );
    this.insertClaimStmt = db.prepare(`
      INSERT INTO improvement_lifecycle_operation_claims (
        operation_id, claim_generation, worker_id, claimed_at, lease_expires_at
      ) VALUES (@operationId, @claimGeneration, @workerId, @claimedAt, @leaseExpiresAt)
    `);
    this.currentClaimStmt = db.prepare(`
      SELECT * FROM improvement_lifecycle_operation_claims
      WHERE operation_id = ?
      ORDER BY claim_generation DESC
      LIMIT 1
    `);
    this.insertInspectionStmt = db.prepare(`
      INSERT INTO improvement_lifecycle_operation_inspections (
        inspection_id, operation_id, claim_generation, observed_state_sha256, disposition, observed_at
      ) VALUES (@inspectionId, @operationId, @claimGeneration, @observedStateSha256, @disposition, @observedAt)
    `);
    this.getInspectionStmt = db.prepare(
      "SELECT * FROM improvement_lifecycle_operation_inspections WHERE inspection_id = ?",
    );
    this.insertSettlementStmt = db.prepare(`
      INSERT INTO improvement_lifecycle_operation_settlements (
        settlement_id, operation_id, claim_generation, inspection_id, disposition,
        observed_state_sha256, result_json, result_sha256, settled_at
      ) VALUES (
        @settlementId, @operationId, @claimGeneration, @inspectionId, @disposition,
        @observedStateSha256, @resultJson, @resultSha256, @settledAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getSettlementStmt = db.prepare(
      "SELECT * FROM improvement_lifecycle_operation_settlements WHERE settlement_id = ?",
    );
    this.findSettlementByOperationStmt = db.prepare(
      "SELECT * FROM improvement_lifecycle_operation_settlements WHERE operation_id = ?",
    );
    this.listUnsettledStmt = db.prepare(`
      SELECT operation.* FROM improvement_lifecycle_operations operation
      LEFT JOIN improvement_lifecycle_operation_settlements settlement
        ON settlement.operation_id = operation.operation_id
      WHERE operation.workspace_id = @workspaceId AND settlement.operation_id IS NULL
      ORDER BY operation.created_at ASC, operation.operation_id ASC
      LIMIT @limit
    `);
  }

  /**
   * Record an exact intent. Replays with identical canonical bytes return the
   * stored intent; the same operation ID, idempotency key, or approval ID
   * with different material conflicts. The approval binding is one-to-one:
   * a later operation can never reuse an earlier operation's approval.
   */
  public createIntent(input: ImprovementLifecycleOperationRecord): ImprovementLifecycleOperationRecord {
    validateOperation(input);
    const existing =
      this.findIntent(input.operationId) ??
      this.findIntentByIdempotencyKey(input.idempotencyKey) ??
      this.findIntentByApprovalId(input.approvalId);
    if (existing) return assertOperationReplay(existing, input);
    try {
      this.insertOperationStmt.run({
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId,
        operationKind: input.operationKind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        approvalId: input.approvalId,
        requestSha256: input.requestSha256,
        actorId: input.actorId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        createdAt: input.createdAt,
      });
    } catch (error) {
      const raced =
        this.findIntent(input.operationId) ??
        this.findIntentByIdempotencyKey(input.idempotencyKey) ??
        this.findIntentByApprovalId(input.approvalId);
      if (raced) return assertOperationReplay(raced, input);
      throw error;
    }
    return assertOperationReplay(this.getIntent(input.operationId), input);
  }

  public getIntent(operationId: string): ImprovementLifecycleOperationRecord {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.getOperationStmt.get(operationId) as ImprovementOperationRow | undefined;
    if (!row) throw new NotFoundError({ entity: "improvement lifecycle operation", id: operationId });
    return mapOperation(row);
  }

  public findIntent(operationId: string): ImprovementLifecycleOperationRecord | undefined {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.getOperationStmt.get(operationId) as ImprovementOperationRow | undefined;
    return row ? mapOperation(row) : undefined;
  }

  public findIntentByIdempotencyKey(idempotencyKey: string): ImprovementLifecycleOperationRecord | undefined {
    assertCanonicalIdentity(idempotencyKey, "idempotency key", 512);
    const row = this.findOperationByIdempotencyStmt.get(idempotencyKey) as ImprovementOperationRow | undefined;
    return row ? mapOperation(row) : undefined;
  }

  public findIntentByApprovalId(approvalId: string): ImprovementLifecycleOperationRecord | undefined {
    assertCanonicalIdentity(approvalId, "approval ID", 256);
    const row = this.findOperationByApprovalStmt.get(approvalId) as ImprovementOperationRow | undefined;
    return row ? mapOperation(row) : undefined;
  }

  /**
   * One-winner claim admission. The database owns the fencing truth: claim
   * generations are contiguous and monotonic, a live prior lease rejects the
   * claim, a settled operation rejects every claim, and two racing workers on
   * the same generation resolve to exactly one winner via the primary key.
   */
  public claim(input: {
    operationId: string;
    workerId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): ImprovementLifecycleClaimRecord {
    assertCanonicalIdentity(input.operationId, "operation ID", 256);
    assertCanonicalIdentity(input.workerId, "worker ID", 256);
    assertCanonicalTimestamp(input.claimedAt, "claimed-at");
    assertCanonicalTimestamp(input.leaseExpiresAt, "lease-expires-at");
    return this.db.transaction("immediate", () => {
      const current = this.findCurrentClaim(input.operationId);
      const claimGeneration = (current?.claimGeneration ?? 0) + 1;
      try {
        this.insertClaimStmt.run({
          operationId: input.operationId,
          claimGeneration,
          workerId: input.workerId,
          claimedAt: input.claimedAt,
          leaseExpiresAt: input.leaseExpiresAt,
        });
      } catch (error) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `Improvement lifecycle claim on ${input.operationId} was fenced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      const stored = this.findCurrentClaim(input.operationId);
      if (!stored || stored.claimGeneration !== claimGeneration || stored.workerId !== input.workerId) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `Improvement lifecycle claim on ${input.operationId} lost the one-winner race.`,
        });
      }
      return stored;
    });
  }

  public findCurrentClaim(operationId: string): ImprovementLifecycleClaimRecord | undefined {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.currentClaimStmt.get(operationId) as ImprovementClaimRow | undefined;
    return row ? mapClaim(row) : undefined;
  }

  /**
   * Record an exact external-state observation for the CURRENT claim. A
   * fenced (superseded) claim generation cannot record inspections.
   */
  public recordInspection(input: ImprovementLifecycleInspectionRecord): ImprovementLifecycleInspectionRecord {
    validateInspection(input);
    this.insertInspectionStmt.run({
      inspectionId: input.inspectionId,
      operationId: input.operationId,
      claimGeneration: input.claimGeneration,
      observedStateSha256: input.observedStateSha256,
      disposition: input.disposition,
      observedAt: input.observedAt,
    });
    const stored = this.getInspection(input.inspectionId);
    if (canonicalJsonString(stored) !== canonicalJsonString(input)) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Improvement lifecycle inspection ${input.inspectionId} conflicts with an immutable record.`,
      });
    }
    return stored;
  }

  public getInspection(inspectionId: string): ImprovementLifecycleInspectionRecord {
    assertCanonicalIdentity(inspectionId, "inspection ID", 256);
    const row = this.getInspectionStmt.get(inspectionId) as ImprovementInspectionRow | undefined;
    if (!row) throw new NotFoundError({ entity: "improvement lifecycle inspection", id: inspectionId });
    return mapInspection(row);
  }

  /**
   * Commit the immutable settlement. Exactly one settlement per operation;
   * replays with identical canonical bytes return the stored settlement; the
   * settlement must cite a same-claim re-inspection with the exact observed
   * state, and `applied` requires a `matches_intent` observation.
   */
  public settle(input: ImprovementLifecycleSettlementRecord): ImprovementLifecycleSettlementRecord {
    validateSettlement(input);
    const existing = this.findSettlement(input.settlementId) ?? this.findSettlementByOperationId(input.operationId);
    if (existing) return assertSettlementReplay(existing, input);
    try {
      this.insertSettlementStmt.run({
        settlementId: input.settlementId,
        operationId: input.operationId,
        claimGeneration: input.claimGeneration,
        inspectionId: input.inspectionId,
        disposition: input.disposition,
        observedStateSha256: input.observedStateSha256,
        resultJson: canonicalJsonString(input.result),
        resultSha256: input.resultSha256,
        settledAt: input.settledAt,
      });
    } catch (error) {
      const raced = this.findSettlement(input.settlementId) ?? this.findSettlementByOperationId(input.operationId);
      if (raced) return assertSettlementReplay(raced, input);
      throw error;
    }
    const stored = this.findSettlement(input.settlementId) ?? this.findSettlementByOperationId(input.operationId);
    if (!stored) throw new Error(`Improvement lifecycle settlement ${input.settlementId} was not persisted.`);
    return assertSettlementReplay(stored, input);
  }

  public getSettlement(settlementId: string): ImprovementLifecycleSettlementRecord {
    const found = this.findSettlement(settlementId);
    if (!found) throw new NotFoundError({ entity: "improvement lifecycle settlement", id: settlementId });
    return found;
  }

  public findSettlement(settlementId: string): ImprovementLifecycleSettlementRecord | undefined {
    assertCanonicalIdentity(settlementId, "settlement ID", 256);
    const row = this.getSettlementStmt.get(settlementId) as ImprovementSettlementRow | undefined;
    return row ? mapSettlement(row) : undefined;
  }

  public findSettlementByOperationId(operationId: string): ImprovementLifecycleSettlementRecord | undefined {
    assertCanonicalIdentity(operationId, "operation ID", 256);
    const row = this.findSettlementByOperationStmt.get(operationId) as ImprovementSettlementRow | undefined;
    return row ? mapSettlement(row) : undefined;
  }

  /** Crash recovery resumes from durable intents, never from callbacks. */
  public listUnsettled(workspaceId: string, limit = 100): ImprovementLifecycleOperationRecord[] {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    const rows = this.listUnsettledStmt.all({
      workspaceId,
      limit: Math.max(1, Math.min(Math.trunc(limit), 500)),
    }) as unknown as ImprovementOperationRow[];
    return rows.map(mapOperation);
  }
}

function mapOperation(row: ImprovementOperationRow): ImprovementLifecycleOperationRecord {
  const record: ImprovementLifecycleOperationRecord = {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    operationKind: row.operation_kind,
    targetKind: row.target_kind,
    targetId: row.target_id,
    approvalId: row.approval_id,
    requestSha256: row.request_sha256,
    actorId: row.actor_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    createdAt: row.created_at,
  };
  validateOperation(record);
  return record;
}

function mapClaim(row: ImprovementClaimRow): ImprovementLifecycleClaimRecord {
  return {
    operationId: row.operation_id,
    claimGeneration: requirePositiveInteger(row.claim_generation, "claim generation"),
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function mapInspection(row: ImprovementInspectionRow): ImprovementLifecycleInspectionRecord {
  const record: ImprovementLifecycleInspectionRecord = {
    inspectionId: row.inspection_id,
    operationId: row.operation_id,
    claimGeneration: requirePositiveInteger(row.claim_generation, "claim generation"),
    observedStateSha256: row.observed_state_sha256,
    disposition: row.disposition,
    observedAt: row.observed_at,
  };
  validateInspection(record);
  return record;
}

function mapSettlement(row: ImprovementSettlementRow): ImprovementLifecycleSettlementRecord {
  const record: ImprovementLifecycleSettlementRecord = {
    settlementId: row.settlement_id,
    operationId: row.operation_id,
    claimGeneration: requirePositiveInteger(row.claim_generation, "claim generation"),
    inspectionId: row.inspection_id,
    disposition: row.disposition,
    observedStateSha256: row.observed_state_sha256,
    result: safeJsonParse<Record<string, unknown>>(row.result_json, {}),
    resultSha256: row.result_sha256,
    settledAt: row.settled_at,
  };
  validateSettlement(record);
  return record;
}

function validateOperation(input: ImprovementLifecycleOperationRecord): void {
  assertCanonicalIdentity(input.operationId, "operation ID", 256);
  assertCanonicalIdentity(input.idempotencyKey, "idempotency key", 512);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  if (!isImprovementLifecycleOperationKind(input.operationKind)) {
    throw new TypeError("Invalid improvement lifecycle operation kind.");
  }
  if (!isImprovementLifecycleTargetKind(input.targetKind)) {
    throw new TypeError("Invalid improvement lifecycle target kind.");
  }
  assertCanonicalIdentity(input.targetId, "target ID", 256);
  assertCanonicalIdentity(input.approvalId, "approval ID", 256);
  assertSha256(input.requestSha256, "request");
  assertCanonicalIdentity(input.actorId, "actor ID", 256);
  assertOptionalCanonicalIdentity(input.sessionId, "session ID", 256);
  assertOptionalCanonicalIdentity(input.turnId, "turn ID", 256);
  if (input.turnId !== undefined && input.sessionId === undefined) {
    throw new TypeError("Improvement lifecycle turn linkage requires a session ID.");
  }
  assertCanonicalTimestamp(input.createdAt, "created-at");
}

function validateInspection(input: ImprovementLifecycleInspectionRecord): void {
  assertCanonicalIdentity(input.inspectionId, "inspection ID", 256);
  assertCanonicalIdentity(input.operationId, "operation ID", 256);
  requirePositiveInteger(input.claimGeneration, "claim generation");
  assertSha256(input.observedStateSha256, "observed state");
  if (!isImprovementLifecycleInspectionDisposition(input.disposition)) {
    throw new TypeError("Invalid improvement lifecycle inspection disposition.");
  }
  assertCanonicalTimestamp(input.observedAt, "observed-at");
}

function validateSettlement(input: ImprovementLifecycleSettlementRecord): void {
  assertCanonicalIdentity(input.settlementId, "settlement ID", 256);
  assertCanonicalIdentity(input.operationId, "operation ID", 256);
  requirePositiveInteger(input.claimGeneration, "claim generation");
  assertCanonicalIdentity(input.inspectionId, "inspection ID", 256);
  if (!isImprovementLifecycleSettlementDisposition(input.disposition)) {
    throw new TypeError("Invalid improvement lifecycle settlement disposition.");
  }
  assertSha256(input.observedStateSha256, "observed state");
  assertSha256(input.resultSha256, "result");
  if (computeImprovementLifecycleResultSha256(input.result) !== input.resultSha256) {
    throw new TypeError("Improvement lifecycle result digest does not match canonical JSON.");
  }
  assertCanonicalTimestamp(input.settledAt, "settled-at");
}

function assertOperationReplay(
  stored: ImprovementLifecycleOperationRecord,
  attempted: ImprovementLifecycleOperationRecord,
): ImprovementLifecycleOperationRecord {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Improvement lifecycle operation ${attempted.operationId} conflicts with an immutable record.`,
    });
  }
  return stored;
}

function assertSettlementReplay(
  stored: ImprovementLifecycleSettlementRecord,
  attempted: ImprovementLifecycleSettlementRecord,
): ImprovementLifecycleSettlementRecord {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Improvement lifecycle settlement ${attempted.settlementId} conflicts with an immutable record.`,
    });
  }
  return stored;
}

function requirePositiveInteger(value: number | string, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`Improvement lifecycle ${label} must be a positive integer.`);
  }
  return normalized;
}

function assertSha256(value: string, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Improvement lifecycle ${label} hash must be SHA-256 hex.`);
  }
}

function assertOptionalCanonicalIdentity(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertCanonicalIdentity(value, label, maxLength);
}

function assertCanonicalIdentity(value: string, label: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    value !== value.normalize("NFKC").trim()
  ) {
    throw new TypeError(`Improvement lifecycle ${label} must use its bounded canonical identity form.`);
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Improvement lifecycle ${label} must be a canonical ISO timestamp.`);
  }
}
