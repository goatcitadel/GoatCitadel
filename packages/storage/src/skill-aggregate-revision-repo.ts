import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { assertSynchronousTransactionResult, type DatabaseClient } from "./db.js";

export const SKILL_AGGREGATE_KINDS = ["runtime_skill", "candidate_skill", "activation_policy"] as const;

export type SkillAggregateKind = (typeof SKILL_AGGREGATE_KINDS)[number];

export interface SkillAggregateRevisionKey {
  aggregateKind: SkillAggregateKind;
  aggregateId: string;
}

export interface SkillAggregateRevisionExpectation extends SkillAggregateRevisionKey {
  expectedRevision: number;
}

export interface SkillAggregateRevisionRecord extends SkillAggregateRevisionKey {
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillAggregateRevisionMutation<T> {
  value: T;
  changed: boolean;
}

export interface SkillAggregateRevisionMutationResult<T> extends SkillAggregateRevisionMutation<T> {
  revision: number;
}

export interface SkillAggregateRevisionBatchMutationResult<T> extends SkillAggregateRevisionMutation<T> {
  revisions: SkillAggregateRevisionRecord[];
}

interface SkillAggregateRevisionRow {
  aggregate_kind: string;
  aggregate_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * Owns the operator-facing CAS revision for governed skill aggregates.
 *
 * Domain repositories remain responsible for deciding whether a requested
 * mutation is a semantic change. This repository fences the aggregate first,
 * invokes that synchronous mutation inside the same transaction, and bumps
 * only when the mutation reports `changed: true`.
 */
export class SkillAggregateRevisionRepository {
  private readonly getStmt;
  private readonly ensureStmt;
  private readonly fenceStmt;
  private readonly bumpStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT aggregate_kind, aggregate_id, revision, created_at, updated_at
      FROM skill_aggregate_revisions
      WHERE aggregate_kind = ? AND aggregate_id = ?
    `);
    this.ensureStmt = db.prepare(`
      INSERT INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      ) VALUES (@aggregateKind, @aggregateId, 1, @createdAt, @updatedAt)
      ON CONFLICT(aggregate_kind, aggregate_id) DO NOTHING
    `);
    this.fenceStmt = db.prepare(`
      UPDATE skill_aggregate_revisions
      SET revision = revision
      WHERE aggregate_kind = @aggregateKind
        AND aggregate_id = @aggregateId
        AND revision = @expectedRevision
    `);
    this.bumpStmt = db.prepare(`
      UPDATE skill_aggregate_revisions
      SET revision = revision + 1,
          updated_at = @updatedAt
      WHERE aggregate_kind = @aggregateKind
        AND aggregate_id = @aggregateId
        AND revision = @expectedRevision
    `);
  }

  public get(aggregateKind: SkillAggregateKind, aggregateId: string): SkillAggregateRevisionRecord | undefined {
    const key = normalizeKey({ aggregateKind, aggregateId });
    return this.getNormalized(key);
  }

  /** Lazily establishes revision one for filesystem-only or otherwise unbackfilled aggregates. */
  public ensure(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedNow = normalizeTimestamp(now);
    this.ensureNormalized(key, normalizedNow);
    return this.requireNormalized(key);
  }

  /**
   * Callback-free primitive for Promise-based storage owners. Callers must
   * invoke this inside the same owned transaction as the first domain write.
   */
  public createInitialRevisionFence(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedNow = normalizeTimestamp(now);
    const inserted = this.ensureStmt.run({
      aggregateKind: key.aggregateKind,
      aggregateId: key.aggregateId,
      createdAt: normalizedNow,
      updatedAt: normalizedNow,
    });
    if (inserted.changes === 0) {
      const current = this.requireNormalized(key);
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `${key.aggregateKind} ${key.aggregateId} already exists at revision ${current.revision}`,
        details: {
          resourceKind: key.aggregateKind,
          resourceId: key.aggregateId,
          expectedState: "absent",
          currentRevision: current.revision,
        },
      });
    }
    return this.requireNormalized(key);
  }

  /**
   * Callback-free CAS fence for Promise-based storage owners. Callers must keep
   * the returned fence and their domain mutation in one owned transaction.
   */
  public fenceExpectedRevision(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedExpectedRevision = normalizeExpectedRevision(expectedRevision);
    this.ensureNormalized(key, normalizeTimestamp(now));
    this.fence(key, normalizedExpectedRevision);
    return this.requireNormalized(key);
  }

  /** Advance a previously fenced revision inside the same owned transaction. */
  public advanceExpectedRevision(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedExpectedRevision = normalizeExpectedRevision(expectedRevision);
    this.bump(key, normalizedExpectedRevision, normalizeTimestamp(now));
    return this.requireNormalized(key);
  }

  /** Fence multiple aggregates in canonical order inside an owned transaction. */
  public fenceExpectedRevisions(
    expectations: readonly SkillAggregateRevisionExpectation[],
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord[] {
    const normalizedExpectations = normalizeExpectations(expectations);
    const normalizedNow = normalizeTimestamp(now);
    return normalizedExpectations.map((expectation) =>
      this.fenceExpectedRevision(
        expectation.aggregateKind,
        expectation.aggregateId,
        expectation.expectedRevision,
        normalizedNow,
      ),
    );
  }

  /** Advance canonically ordered fences inside the transaction that owns them. */
  public advanceExpectedRevisions(
    expectations: readonly SkillAggregateRevisionExpectation[],
    now = new Date().toISOString(),
  ): SkillAggregateRevisionRecord[] {
    const normalizedExpectations = normalizeExpectations(expectations);
    const normalizedNow = normalizeTimestamp(now);
    return normalizedExpectations.map((expectation) =>
      this.advanceExpectedRevision(
        expectation.aggregateKind,
        expectation.aggregateId,
        expectation.expectedRevision,
        normalizedNow,
      ),
    );
  }

  /**
   * Creates a new aggregate at revision one in the same transaction as its
   * first domain mutation. The mutation is fenced by the revision insert, so
   * concurrent creators cannot both commit as revision one.
   */
  public createWithInitialRevision<T>(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    mutation: () => SkillAggregateRevisionMutation<T>,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionMutationResult<T> {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedNow = normalizeTimestamp(now);

    return this.db.transaction("immediate", () => {
      this.createInitialRevisionFence(key.aggregateKind, key.aggregateId, normalizedNow);

      const result = mutation();
      assertSynchronousTransactionResult(result);
      validateMutationResult(result);
      if (!result.changed) {
        throw new TypeError("initial skill aggregate revision mutation must report changed: true");
      }
      return { ...result, revision: 1 };
    });
  }

  public runWithRevision<T>(
    aggregateKind: SkillAggregateKind,
    aggregateId: string,
    expectedRevision: number,
    mutation: () => SkillAggregateRevisionMutation<T>,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionMutationResult<T> {
    const key = normalizeKey({ aggregateKind, aggregateId });
    const normalizedExpectedRevision = normalizeExpectedRevision(expectedRevision);
    const normalizedNow = normalizeTimestamp(now);

    return this.db.transaction("immediate", () => {
      this.fenceExpectedRevision(key.aggregateKind, key.aggregateId, normalizedExpectedRevision, normalizedNow);
      const result = mutation();
      assertSynchronousTransactionResult(result);
      validateMutationResult(result);
      if (!result.changed) {
        return { ...result, revision: normalizedExpectedRevision };
      }
      const advanced = this.advanceExpectedRevision(
        key.aggregateKind,
        key.aggregateId,
        normalizedExpectedRevision,
        normalizedNow,
      );
      return { ...result, revision: advanced.revision };
    });
  }

  /**
   * Fences several aggregates in canonical key order to avoid lock-order
   * inversions. A semantic batch change advances every fenced aggregate;
   * semantic no-ops leave every revision unchanged.
   */
  public runWithRevisions<T>(
    expectations: readonly SkillAggregateRevisionExpectation[],
    mutation: () => SkillAggregateRevisionMutation<T>,
    now = new Date().toISOString(),
  ): SkillAggregateRevisionBatchMutationResult<T> {
    const normalizedExpectations = normalizeExpectations(expectations);
    const normalizedNow = normalizeTimestamp(now);

    return this.db.transaction("immediate", () => {
      for (const expectation of normalizedExpectations) {
        this.ensureNormalized(expectation, normalizedNow);
        this.fence(expectation, expectation.expectedRevision);
      }

      const result = mutation();
      assertSynchronousTransactionResult(result);
      validateMutationResult(result);
      if (result.changed) {
        for (const expectation of normalizedExpectations) {
          this.bump(expectation, expectation.expectedRevision, normalizedNow);
        }
      }

      return {
        ...result,
        revisions: normalizedExpectations.map((expectation) => this.requireNormalized(expectation)),
      };
    });
  }

  private getNormalized(key: SkillAggregateRevisionKey): SkillAggregateRevisionRecord | undefined {
    const row = toRevisionRow(this.getStmt.get(key.aggregateKind, key.aggregateId));
    return row
      ? {
          aggregateKind: row.aggregate_kind as SkillAggregateKind,
          aggregateId: row.aggregate_id,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  private requireNormalized(key: SkillAggregateRevisionKey): SkillAggregateRevisionRecord {
    const record = this.getNormalized(key);
    if (!record) {
      throw new NotFoundError({ entity: `${key.aggregateKind} skill aggregate`, id: key.aggregateId });
    }
    return record;
  }

  private ensureNormalized(key: SkillAggregateRevisionKey, now: string): void {
    this.ensureStmt.run({
      aggregateKind: key.aggregateKind,
      aggregateId: key.aggregateId,
      createdAt: now,
      updatedAt: now,
    });
  }

  private fence(key: SkillAggregateRevisionKey, expectedRevision: number): void {
    const fenced = this.fenceStmt.run({
      aggregateKind: key.aggregateKind,
      aggregateId: key.aggregateId,
      expectedRevision,
    });
    if (fenced.changes === 0) {
      this.throwCasMiss(key, expectedRevision);
    }
  }

  private bump(key: SkillAggregateRevisionKey, expectedRevision: number, now: string): void {
    const bumped = this.bumpStmt.run({
      aggregateKind: key.aggregateKind,
      aggregateId: key.aggregateId,
      expectedRevision,
      updatedAt: now,
    });
    if (bumped.changes === 0) {
      this.throwCasMiss(key, expectedRevision);
    }
  }

  private throwCasMiss(key: SkillAggregateRevisionKey, expectedRevision: number): never {
    const current = this.requireNormalized(key);
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `${key.aggregateKind} ${key.aggregateId} changed since revision ${expectedRevision}`,
      details: {
        resourceKind: key.aggregateKind,
        resourceId: key.aggregateId,
        expectedRevision,
        currentRevision: current.revision,
      },
    });
  }
}

function normalizeExpectations(
  expectations: readonly SkillAggregateRevisionExpectation[],
): SkillAggregateRevisionExpectation[] {
  if (expectations.length === 0) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "expectations" });
  }
  const unique = new Map<string, SkillAggregateRevisionExpectation>();
  for (const expectation of expectations) {
    const key = normalizeKey(expectation);
    const normalized = {
      ...key,
      expectedRevision: normalizeExpectedRevision(expectation.expectedRevision),
    };
    const lockKey = `${normalized.aggregateKind}\u0000${normalized.aggregateId}`;
    const existing = unique.get(lockKey);
    if (existing && existing.expectedRevision !== normalized.expectedRevision) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "expectations",
        message: `Conflicting expected revisions for ${normalized.aggregateKind} ${normalized.aggregateId}`,
      });
    }
    unique.set(lockKey, normalized);
  }
  return [...unique.values()].sort(compareExpectations);
}

function compareExpectations(
  left: SkillAggregateRevisionExpectation,
  right: SkillAggregateRevisionExpectation,
): number {
  return (
    compareCodeUnits(left.aggregateKind, right.aggregateKind) || compareCodeUnits(left.aggregateId, right.aggregateId)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeKey(key: SkillAggregateRevisionKey): SkillAggregateRevisionKey {
  if (!SKILL_AGGREGATE_KINDS.includes(key.aggregateKind)) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "aggregateKind" });
  }
  const aggregateId = key.aggregateId.trim();
  if (!aggregateId) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "aggregateId" });
  }
  if (aggregateId.length > 256) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "aggregateId" });
  }
  return { aggregateKind: key.aggregateKind, aggregateId };
}

function normalizeExpectedRevision(expectedRevision: number): number {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "expectedRevision" });
  }
  return expectedRevision;
}

function normalizeTimestamp(timestamp: string): string {
  const normalized = timestamp.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "now" });
  }
  return normalized;
}

function validateMutationResult<T>(result: SkillAggregateRevisionMutation<T>): void {
  if (!isRecord(result) || typeof result.changed !== "boolean" || !("value" in result)) {
    throw new TypeError("skill aggregate revision mutation must return { value, changed }");
  }
}

function toRevisionRow(value: unknown): SkillAggregateRevisionRow | undefined {
  return isRecord(value) &&
    typeof value.aggregate_kind === "string" &&
    SKILL_AGGREGATE_KINDS.includes(value.aggregate_kind as SkillAggregateKind) &&
    typeof value.aggregate_id === "string" &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
    ? {
        aggregate_kind: value.aggregate_kind,
        aggregate_id: value.aggregate_id,
        revision: Number(value.revision),
        created_at: value.created_at,
        updated_at: value.updated_at,
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
