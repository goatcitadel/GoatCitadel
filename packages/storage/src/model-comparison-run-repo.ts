import type {
  ModelComparisonCandidate,
  ModelComparisonJudgment,
  ModelComparisonPromptResult,
  ModelComparisonRun,
  ModelComparisonStatus,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncGatewaySqlRepository } from "./async-storage.js";
import type { DbBindParams, DbRunResult, DbStatement } from "./db.js";
import { MODEL_COMPARISON_CLAIM_SCHEMA_SQL } from "./model-comparison-claim-schema.js";

type MaybeAsyncStatement = {
  run(...params: DbBindParams[]): DbRunResult | Promise<DbRunResult>;
  get<T = unknown>(...params: DbBindParams[]): T | undefined | Promise<T | undefined>;
  all<T = unknown>(...params: DbBindParams[]): T[] | Promise<T[]>;
};

interface ModelComparisonSqlPort {
  prepare(sql: string): DbStatement | MaybeAsyncStatement;
  exec(sql: string): void | Promise<void>;
  runImmediateTransaction<T>(callback: () => T | Promise<T>): T | Promise<Awaited<T>>;
}

interface ModelComparisonRunRow {
  comparison_id: string;
  pack_id: string;
  status: ModelComparisonStatus;
  title: string;
  candidates_json: string;
  test_ids_json: string;
  results_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
}

interface ModelComparisonJudgmentRow {
  judgment_id: string;
  comparison_id: string;
  test_id: string;
  winner_candidate_id: string | null;
  scores_json: string;
  notes: string | null;
  reviewer_id: string | null;
  created_at: string;
}

export class ModelComparisonRunRepository {
  private schemaReady?: Promise<void>;

  public constructor(private readonly db: ModelComparisonSqlPort | AsyncGatewaySqlRepository) {}

  public async create(run: ModelComparisonRun): Promise<ModelComparisonRun> {
    await this.ensureSchema();
    await this.db.runImmediateTransaction(async () => {
      await this.db.prepare(INSERT_RUN_SQL).run({
        comparisonId: run.comparisonId,
        packId: run.packId,
        status: run.status,
        title: run.title,
        candidatesJson: JSON.stringify(run.candidates),
        testIdsJson: JSON.stringify(run.testIds),
        resultsJson: JSON.stringify(run.results),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt ?? null,
        error: run.error ?? null,
      });
      for (const judgment of run.judgments) {
        await this.insertJudgment(run.comparisonId, judgment);
      }
    });
    return await this.get(run.comparisonId);
  }

  public async get(comparisonId: string): Promise<ModelComparisonRun> {
    await this.ensureSchema();
    const row = toRunRow(await this.db.prepare(GET_RUN_SQL).get(comparisonId));
    if (!row) {
      throw new NotFoundError({ entity: "Model comparison", id: comparisonId });
    }
    return await this.mapRun(row);
  }

  public async list(limit = 100): Promise<ModelComparisonRun[]> {
    await this.ensureSchema();
    const rows = toRunRows(
      await this.db.prepare(LIST_RUNS_SQL).all({
        limit: Math.max(1, Math.min(limit, 500)),
      }),
    );
    return await Promise.all(rows.map((row) => this.mapRun(row)));
  }

  public async addJudgment(comparisonId: string, judgment: ModelComparisonJudgment): Promise<ModelComparisonJudgment> {
    await this.get(comparisonId);
    await this.db.runImmediateTransaction(async () => {
      await this.insertJudgment(comparisonId, judgment);
      await this.db.prepare(UPDATE_RUN_TIMESTAMP_SQL).run({
        comparisonId,
        updatedAt: judgment.createdAt,
      });
    });
    const persisted = (await this.listJudgments(comparisonId)).find((item) => item.judgmentId === judgment.judgmentId);
    if (!persisted) {
      throw new NotFoundError({ entity: "Model comparison judgment", id: judgment.judgmentId });
    }
    return persisted;
  }

  public async updateStatus(
    comparisonId: string,
    update: { status: ModelComparisonStatus; updatedAt: string; completedAt?: string | null; error?: string | null },
  ): Promise<ModelComparisonRun> {
    await this.ensureSchema();
    // Read and write in one immediate transaction so an omitted field keeps the
    // value committed at write time, not one a concurrent writer replaced.
    await this.db.runImmediateTransaction(async () => {
      await this.lockClaimSlot(comparisonId);
      const row = toRunRow(await this.db.prepare(GET_RUN_SQL).get(comparisonId));
      if (!row) {
        throw new NotFoundError({ entity: "Model comparison", id: comparisonId });
      }
      await this.db.prepare(UPDATE_RUN_STATUS_SQL).run({
        comparisonId,
        status: update.status,
        updatedAt: update.updatedAt,
        completedAt: update.completedAt === undefined ? row.completed_at : update.completedAt,
        error: update.error === undefined ? row.error : update.error,
      });
      await this.db.prepare(SET_CLAIM_SQL).run({ comparisonId, claimId: null });
    });
    return await this.get(comparisonId);
  }

  /**
   * Compare-and-swap claim: moves the run to `running` only when its status and
   * `updatedAt` still match the snapshot the caller read. Returns undefined
   * when another writer changed the row first (or it does not exist).
   */
  public async claimRun(
    comparisonId: string,
    claim: { expectedStatus: ModelComparisonStatus; expectedUpdatedAt: string; updatedAt: string; claimId: string },
  ): Promise<ModelComparisonRun | undefined> {
    await this.ensureSchema();
    if (!claim.claimId?.trim()) return undefined;
    return await this.db.runImmediateTransaction(async () => {
      await this.lockClaimSlot(comparisonId);
      const result = await this.db.prepare(CLAIM_RUN_SQL).run({
        comparisonId,
        expectedStatus: claim.expectedStatus,
        expectedUpdatedAt: claim.expectedUpdatedAt,
        updatedAt: claim.updatedAt,
      });
      if (changedRows(result) !== 1) {
        await this.removeOrphanedClaim(comparisonId);
        return undefined;
      }
      await this.db.prepare(SET_CLAIM_SQL).run({ comparisonId, claimId: claim.claimId });
      return await this.get(comparisonId);
    });
  }

  /** Extends only the current execution claim, including after another process takes over. */
  public async renewRunLease(comparisonId: string, updatedAt: string, claimId: string): Promise<boolean> {
    await this.ensureSchema();
    return await this.db.runImmediateTransaction(async () => {
      if (!await this.lockOwnedClaim(comparisonId, claimId)) return false;
      const result = await this.db.prepare(RENEW_RUN_LEASE_SQL).run({ comparisonId, updatedAt });
      return changedRows(result) === 1;
    });
  }

  /** Terminal write that applies only while the run is still `running`. */
  public async finishRun(
    comparisonId: string,
    update: { status: ModelComparisonStatus; updatedAt: string; completedAt: string | null; error: string | null },
    authority: { kind: "execution"; claimId: string } | { kind: "operator_cancel" },
  ): Promise<ModelComparisonRun | undefined> {
    await this.ensureSchema();
    if (authority?.kind === "operator_cancel") {
      if (update.status !== "cancelled" || update.completedAt === null) return undefined;
      return await this.cancelRun(comparisonId, { updatedAt: update.updatedAt, completedAt: update.completedAt });
    }
    if (authority?.kind !== "execution") return undefined;
    return await this.db.runImmediateTransaction(async () => {
      if (!await this.lockOwnedClaim(comparisonId, authority.claimId)) return undefined;
      return await this.finishLocked(comparisonId, update);
    });
  }

  /** Explicit operator cancellation is independent of any executor's claim. */
  public async cancelRun(
    comparisonId: string,
    update: { updatedAt: string; completedAt: string },
  ): Promise<ModelComparisonRun | undefined> {
    await this.ensureSchema();
    return await this.db.runImmediateTransaction(async () => {
      await this.lockClaimSlot(comparisonId);
      return await this.finishLocked(comparisonId, { ...update, status: "cancelled", error: null });
    });
  }

  public async upsertResult(
    comparisonId: string,
    result: ModelComparisonPromptResult,
    updatedAt: string,
    claimId: string,
  ): Promise<ModelComparisonRun | undefined> {
    await this.ensureSchema();
    return await this.db.runImmediateTransaction(async () => {
      if (!await this.lockOwnedClaim(comparisonId, claimId)) return undefined;
      const row = toRunRow(await this.db.prepare(GET_RUN_SQL).get(comparisonId));
      if (!row || row.status !== "running") return undefined;
      const results = safeJsonParse<ModelComparisonPromptResult[]>(row.results_json, []);
      const index = results.findIndex((item) => item.resultId === result.resultId);
      const next = index >= 0 ? results.map((item, i) => (i === index ? result : item)) : [...results, result];
      await this.db.prepare(UPDATE_RUN_RESULTS_SQL).run({
        comparisonId,
        resultsJson: JSON.stringify(next),
        updatedAt,
      });
      return await this.get(comparisonId);
    });
  }

  // All claim changes and execution writes lock the token row before the run.
  // A row-level CAS rechecks the token after a PostgreSQL lock wait; a SELECT
  // followed by a status-only UPDATE could accept a pre-wait token snapshot.
  private async lockOwnedClaim(comparisonId: string, claimId: string): Promise<boolean> {
    if (!claimId?.trim()) return false;
    return changedRows(await this.db.prepare(LOCK_OWNED_CLAIM_SQL).run({ comparisonId, claimId })) === 1;
  }

  private async lockClaimSlot(comparisonId: string): Promise<void> {
    // SELECT prevents creating slots for unknown/deleted comparisons. The no-op
    // conflict update locks existing slots, even when they have no active token.
    await this.db.prepare(LOCK_CLAIM_SLOT_SQL).run({ comparisonId });
  }

  private async removeOrphanedClaim(comparisonId: string): Promise<void> {
    // A claim-slot INSERT may have waited behind concurrent pack deletion.
    // Its SELECT snapshot can predate that commit, but its run CAS cannot.
    await this.db.prepare(`
      DELETE FROM model_comparison_execution_claims WHERE comparison_id = @comparisonId
        AND NOT EXISTS (SELECT 1 FROM model_comparison_runs WHERE comparison_id = @comparisonId)
    `).run({ comparisonId });
  }

  private async finishLocked(
    comparisonId: string,
    update: { status: ModelComparisonStatus; updatedAt: string; completedAt: string | null; error: string | null },
  ): Promise<ModelComparisonRun | undefined> {
    const result = await this.db.prepare(FINISH_RUN_SQL).run({ comparisonId, ...update });
    if (changedRows(result) !== 1) {
      await this.removeOrphanedClaim(comparisonId);
      return undefined;
    }
    await this.db.prepare(SET_CLAIM_SQL).run({ comparisonId, claimId: null });
    return await this.get(comparisonId);
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= Promise.resolve(
      this.db.exec(`${MODEL_COMPARISON_CLAIM_SCHEMA_SQL}
      CREATE TABLE IF NOT EXISTS model_comparison_runs (
        comparison_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        candidates_json TEXT NOT NULL,
        test_ids_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS model_comparison_judgments (
        judgment_id TEXT PRIMARY KEY,
        comparison_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        winner_candidate_id TEXT,
        scores_json TEXT NOT NULL,
        notes TEXT,
        reviewer_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (comparison_id) REFERENCES model_comparison_runs(comparison_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_model_comparison_runs_created_at
        ON model_comparison_runs(created_at);

      CREATE INDEX IF NOT EXISTS idx_model_comparison_judgments_comparison_id
        ON model_comparison_judgments(comparison_id, created_at);
    `),
    );
    return this.schemaReady;
  }

  private async insertJudgment(comparisonId: string, judgment: ModelComparisonJudgment): Promise<void> {
    await this.db.prepare(INSERT_JUDGMENT_SQL).run({
      judgmentId: judgment.judgmentId,
      comparisonId,
      testId: judgment.testId,
      winnerCandidateId: judgment.winnerCandidateId ?? null,
      scoresJson: JSON.stringify(judgment.scores),
      notes: judgment.notes ?? null,
      reviewerId: judgment.reviewerId ?? null,
      createdAt: judgment.createdAt,
    });
  }

  private async listJudgments(comparisonId: string): Promise<ModelComparisonJudgment[]> {
    return toJudgmentRows(await this.db.prepare(LIST_JUDGMENTS_SQL).all(comparisonId)).map(mapJudgmentRow);
  }

  private async mapRun(row: ModelComparisonRunRow): Promise<ModelComparisonRun> {
    return {
      comparisonId: row.comparison_id,
      packId: row.pack_id,
      status: row.status,
      title: row.title,
      candidates: safeJsonParse<ModelComparisonCandidate[]>(row.candidates_json, []),
      testIds: safeJsonParse<string[]>(row.test_ids_json, []),
      results: safeJsonParse<ModelComparisonPromptResult[]>(row.results_json, []),
      judgments: await this.listJudgments(row.comparison_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

const INSERT_RUN_SQL = `
  INSERT INTO model_comparison_runs (
    comparison_id, pack_id, status, title, candidates_json, test_ids_json,
    results_json, created_at, updated_at, completed_at, error
  ) VALUES (
    @comparisonId, @packId, @status, @title, @candidatesJson, @testIdsJson,
    @resultsJson, @createdAt, @updatedAt, @completedAt, @error
  )
`;
const GET_RUN_SQL = `SELECT * FROM model_comparison_runs WHERE comparison_id = ? LIMIT 1`;
const LIST_RUNS_SQL = `
  SELECT * FROM model_comparison_runs ORDER BY created_at DESC, comparison_id DESC LIMIT @limit
`;
const INSERT_JUDGMENT_SQL = `
  INSERT INTO model_comparison_judgments (
    judgment_id, comparison_id, test_id, winner_candidate_id,
    scores_json, notes, reviewer_id, created_at
  ) VALUES (
    @judgmentId, @comparisonId, @testId, @winnerCandidateId,
    @scoresJson, @notes, @reviewerId, @createdAt
  )
`;
const LIST_JUDGMENTS_SQL = `
  SELECT * FROM model_comparison_judgments
  WHERE comparison_id = ? ORDER BY created_at ASC, judgment_id ASC
`;
const UPDATE_RUN_TIMESTAMP_SQL = `
  UPDATE model_comparison_runs SET updated_at = @updatedAt WHERE comparison_id = @comparisonId
`;
const UPDATE_RUN_STATUS_SQL = `
  UPDATE model_comparison_runs
  SET status = @status, updated_at = @updatedAt, completed_at = @completedAt, error = @error
  WHERE comparison_id = @comparisonId
`;
const CLAIM_RUN_SQL = `
  UPDATE model_comparison_runs
  SET status = 'running', updated_at = @updatedAt, completed_at = NULL, error = NULL
  WHERE comparison_id = @comparisonId AND status = @expectedStatus AND updated_at = @expectedUpdatedAt
`;
const RENEW_RUN_LEASE_SQL = `
  UPDATE model_comparison_runs SET updated_at = @updatedAt
  WHERE comparison_id = @comparisonId AND status = 'running'
`;
const FINISH_RUN_SQL = `
  UPDATE model_comparison_runs
  SET status = @status, updated_at = @updatedAt, completed_at = @completedAt, error = @error
  WHERE comparison_id = @comparisonId AND status = 'running'
`;
const UPDATE_RUN_RESULTS_SQL = `
  UPDATE model_comparison_runs SET results_json = @resultsJson, updated_at = @updatedAt
  WHERE comparison_id = @comparisonId
`;
const LOCK_CLAIM_SLOT_SQL = `
  INSERT INTO model_comparison_execution_claims (comparison_id, claim_id)
  SELECT comparison_id, NULL FROM model_comparison_runs WHERE comparison_id = @comparisonId
  ON CONFLICT (comparison_id) DO UPDATE SET comparison_id = excluded.comparison_id
`;
const LOCK_OWNED_CLAIM_SQL = `
  UPDATE model_comparison_execution_claims SET claim_id = claim_id
  WHERE comparison_id = @comparisonId AND claim_id = @claimId
`;
const SET_CLAIM_SQL = `
  UPDATE model_comparison_execution_claims SET claim_id = @claimId WHERE comparison_id = @comparisonId
`;

function mapJudgmentRow(row: ModelComparisonJudgmentRow): ModelComparisonJudgment {
  return {
    judgmentId: row.judgment_id,
    testId: row.test_id,
    winnerCandidateId: row.winner_candidate_id ?? undefined,
    scores: safeJsonParse<ModelComparisonJudgment["scores"]>(row.scores_json, []),
    notes: row.notes ?? undefined,
    reviewerId: row.reviewer_id ?? undefined,
    createdAt: row.created_at,
  };
}

function changedRows(result: DbRunResult): number {
  return Number(result.changes ?? 0);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRunRow(value: unknown): ModelComparisonRunRow | undefined {
  return isRunRow(value) ? value : undefined;
}

function toRunRows(value: unknown): ModelComparisonRunRow[] {
  return Array.isArray(value) ? value.filter(isRunRow) : [];
}

function toJudgmentRows(value: unknown): ModelComparisonJudgmentRow[] {
  return Array.isArray(value) ? value.filter(isJudgmentRow) : [];
}

function isRunRow(value: unknown): value is ModelComparisonRunRow {
  return (
    isRecord(value) &&
    typeof value.comparison_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.status === "string" &&
    typeof value.title === "string" &&
    typeof value.candidates_json === "string" &&
    typeof value.test_ids_json === "string" &&
    typeof value.results_json === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.completed_at === "string" || value.completed_at === null) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isJudgmentRow(value: unknown): value is ModelComparisonJudgmentRow {
  return (
    isRecord(value) &&
    typeof value.judgment_id === "string" &&
    typeof value.comparison_id === "string" &&
    typeof value.test_id === "string" &&
    (typeof value.winner_candidate_id === "string" || value.winner_candidate_id === null) &&
    typeof value.scores_json === "string" &&
    (typeof value.notes === "string" || value.notes === null) &&
    (typeof value.reviewer_id === "string" || value.reviewer_id === null) &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
