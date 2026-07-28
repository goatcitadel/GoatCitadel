import type { EngineeringLearningRecord, EngineeringLearningStatus } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface EngineeringLearningRow {
  learning_id: string;
  status: EngineeringLearningStatus;
  record_json: string;
  updated_at: string;
}

export interface EngineeringLearningListInput {
  workspaceId: string;
  projectId?: string;
  status?: EngineeringLearningStatus;
  limit?: number;
}

export class EngineeringLearningRepository {
  private readonly createStmt: DbStatement;
  private readonly getStmt: DbStatement;
  private readonly getBySourceRunStmt: DbStatement;
  private readonly listStmt: DbStatement;
  private readonly listWorkspaceExceptStmt: DbStatement;
  private readonly listRefreshCandidatesStmt: DbStatement;
  private readonly updateStmt: DbStatement;

  public constructor(db: DatabaseClient) {
    this.createStmt = db.prepare(`
      INSERT INTO engineering_learnings (
        learning_id, workspace_id, project_id, status, title, fingerprint, record_json,
        source_run_id, supersedes_learning_id, created_at, updated_at
      ) VALUES (
        @learningId, @workspaceId, @projectId, @status, @title, @fingerprint, @recordJson,
        @sourceRunId, @supersedesLearningId, @createdAt, @updatedAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM engineering_learnings WHERE learning_id = ?");
    this.getBySourceRunStmt = db.prepare(
      "SELECT * FROM engineering_learnings WHERE workspace_id = ? AND source_run_id = ?",
    );
    this.listStmt = db.prepare(`
      SELECT * FROM engineering_learnings
      WHERE workspace_id = @workspaceId
        AND (@projectId IS NULL OR project_id = @projectId)
        AND (@status IS NULL OR status = @status)
      ORDER BY updated_at DESC
      LIMIT @limit
    `);
    this.listWorkspaceExceptStmt = db.prepare(`
      SELECT * FROM engineering_learnings
      WHERE workspace_id = @workspaceId AND learning_id <> @learningId
      ORDER BY updated_at DESC
      LIMIT @limit
    `);
    this.listRefreshCandidatesStmt = db.prepare(
      "SELECT * FROM engineering_learnings WHERE status IN ('proposed', 'active') LIMIT @limit",
    );
    this.updateStmt = db.prepare(`
      UPDATE engineering_learnings SET
        project_id = @projectId,
        status = @status,
        title = @title,
        fingerprint = @fingerprint,
        record_json = @recordJson,
        supersedes_learning_id = @supersedesLearningId,
        updated_at = @updatedAt
      WHERE learning_id = @learningId
    `);
  }

  public create(record: EngineeringLearningRecord, fingerprint: string): EngineeringLearningRecord {
    this.createStmt.run({
      learningId: record.learningId,
      workspaceId: record.workspaceId,
      projectId: record.projectId ?? null,
      status: record.status,
      title: record.title,
      fingerprint,
      recordJson: JSON.stringify(record),
      sourceRunId: record.source.runId,
      supersedesLearningId: record.supersedesLearningId ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  public get(learningId: string): EngineeringLearningRecord | undefined {
    return mapLearningRow(this.getStmt.get(learningId));
  }

  public getBySourceRun(workspaceId: string, sourceRunId: string): EngineeringLearningRecord | undefined {
    return mapLearningRow(this.getBySourceRunStmt.get(workspaceId, sourceRunId));
  }

  public list(input: EngineeringLearningListInput): EngineeringLearningRecord[] {
    return mapLearningRows(
      this.listStmt.all({
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        status: input.status ?? null,
        limit: boundedLimit(input.limit ?? 100, 500),
      }),
    );
  }

  public listWorkspaceExcept(workspaceId: string, learningId: string, limit = 200): EngineeringLearningRecord[] {
    return mapLearningRows(
      this.listWorkspaceExceptStmt.all({
        workspaceId,
        learningId,
        limit: boundedLimit(limit, 500),
      }),
    );
  }

  public listRefreshCandidates(limit = 500): EngineeringLearningRecord[] {
    return mapLearningRows(this.listRefreshCandidatesStmt.all({ limit: boundedLimit(limit, 2_000) }));
  }

  public update(record: EngineeringLearningRecord, fingerprint: string): EngineeringLearningRecord {
    this.updateStmt.run({
      learningId: record.learningId,
      projectId: record.projectId ?? null,
      status: record.status,
      title: record.title,
      fingerprint,
      recordJson: JSON.stringify(record),
      supersedesLearningId: record.supersedesLearningId ?? null,
      updatedAt: record.updatedAt,
    });
    return record;
  }
}

function mapLearningRows(value: unknown): EngineeringLearningRecord[] {
  return Array.isArray(value)
    ? value.flatMap((row) => {
        const mapped = mapLearningRow(row);
        return mapped ? [mapped] : [];
      })
    : [];
}

function mapLearningRow(value: unknown): EngineeringLearningRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as EngineeringLearningRow;
  const parsed = safeJsonParse<EngineeringLearningRecord | undefined>(row.record_json, undefined);
  if (!parsed || typeof parsed.learningId !== "string") return undefined;
  return { ...parsed, status: row.status, updatedAt: row.updated_at };
}

function boundedLimit(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
