import type { ReviewFindingRecord, ReviewRunRecord } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface StructuredReviewRunRow {
  review_run_id: string;
  source: ReviewRunRecord["source"];
  status: ReviewRunRecord["status"];
  root_path: string;
  reviewed_sha: string;
  diff_hash: string;
  changed_files_json: string;
  reviewer_roster_json: string;
  preflight_json: string;
  model_receipts_json: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

interface StructuredReviewFindingRow {
  finding_id: string;
  review_run_id: string;
  record_json: string;
  status: ReviewFindingRecord["status"];
  linked_task_id: string | null;
  fix_approval_id: string | null;
  created_at: string;
  updated_at: string;
}

export class StructuredReviewRepository {
  private readonly createRunStmt: DbStatement;
  private readonly getRunStmt: DbStatement;
  private readonly listRunsStmt: DbStatement;
  private readonly updateRunStmt: DbStatement;
  private readonly createFindingStmt: DbStatement;
  private readonly getFindingStmt: DbStatement;
  private readonly listFindingsStmt: DbStatement;
  private readonly updateFindingStmt: DbStatement;

  public constructor(db: DatabaseClient) {
    this.createRunStmt = db.prepare(`
      INSERT INTO structured_review_runs (
        review_run_id, source, status, root_path, reviewed_sha, diff_hash, changed_files_json,
        reviewer_roster_json, preflight_json, model_receipts_json, created_at, finished_at, error
      ) VALUES (
        @reviewRunId, @source, @status, @rootPath, @reviewedSha, @diffHash, @changedFilesJson,
        @reviewerRosterJson, @preflightJson, @modelReceiptsJson, @createdAt, @finishedAt, @error
      )
    `);
    this.getRunStmt = db.prepare("SELECT * FROM structured_review_runs WHERE review_run_id = ?");
    this.listRunsStmt = db.prepare("SELECT * FROM structured_review_runs ORDER BY created_at DESC LIMIT @limit");
    this.updateRunStmt = db.prepare(`
      UPDATE structured_review_runs SET
        status = @status,
        model_receipts_json = @modelReceiptsJson,
        finished_at = @finishedAt,
        error = @error
      WHERE review_run_id = @reviewRunId
    `);
    this.createFindingStmt = db.prepare(`
      INSERT INTO structured_review_findings (
        finding_id, review_run_id, record_json, status, linked_task_id, fix_approval_id, created_at, updated_at
      ) VALUES (
        @findingId, @reviewRunId, @recordJson, @status, @linkedTaskId, @fixApprovalId, @createdAt, @updatedAt
      )
    `);
    this.getFindingStmt = db.prepare("SELECT * FROM structured_review_findings WHERE finding_id = ?");
    this.listFindingsStmt = db.prepare(
      "SELECT * FROM structured_review_findings WHERE review_run_id = ? ORDER BY created_at ASC",
    );
    this.updateFindingStmt = db.prepare(`
      UPDATE structured_review_findings SET
        record_json = @recordJson,
        status = @status,
        linked_task_id = @linkedTaskId,
        fix_approval_id = @fixApprovalId,
        updated_at = @updatedAt
      WHERE finding_id = @findingId
    `);
  }

  public createRun(record: ReviewRunRecord): ReviewRunRecord {
    this.createRunStmt.run({
      reviewRunId: record.reviewRunId,
      source: record.source,
      status: record.status,
      rootPath: record.rootPath,
      reviewedSha: record.reviewedSha,
      diffHash: record.diffHash,
      changedFilesJson: JSON.stringify(record.changedFiles),
      reviewerRosterJson: JSON.stringify(record.reviewerRoster),
      preflightJson: JSON.stringify(record.preflight ?? {}),
      modelReceiptsJson: JSON.stringify(record.modelReceipts),
      createdAt: record.createdAt,
      finishedAt: record.finishedAt ?? null,
      error: record.error ?? null,
    });
    return { ...record, findings: [...record.findings] };
  }

  public getRun(reviewRunId: string): ReviewRunRecord | undefined {
    const row = mapRunRow(this.getRunStmt.get(reviewRunId));
    return row ? { ...row, findings: this.listFindings(reviewRunId) } : undefined;
  }

  public listRuns(limit = 50): ReviewRunRecord[] {
    return toRows<StructuredReviewRunRow>(this.listRunsStmt.all({ limit: boundedLimit(limit, 200) })).flatMap((row) => {
      const mapped = mapRunRow(row);
      return mapped ? [{ ...mapped, findings: this.listFindings(mapped.reviewRunId) }] : [];
    });
  }

  public updateRun(
    reviewRunId: string,
    patch: Pick<ReviewRunRecord, "status" | "modelReceipts"> & Partial<Pick<ReviewRunRecord, "finishedAt" | "error">>,
  ): ReviewRunRecord | undefined {
    this.updateRunStmt.run({
      reviewRunId,
      status: patch.status,
      modelReceiptsJson: JSON.stringify(patch.modelReceipts),
      finishedAt: patch.finishedAt ?? null,
      error: patch.error ?? null,
    });
    return this.getRun(reviewRunId);
  }

  public createFinding(record: ReviewFindingRecord): ReviewFindingRecord {
    this.createFindingStmt.run(serializeFinding(record));
    return record;
  }

  public getFinding(findingId: string): ReviewFindingRecord | undefined {
    return mapFindingRow(this.getFindingStmt.get(findingId));
  }

  public listFindings(reviewRunId: string): ReviewFindingRecord[] {
    return toRows<StructuredReviewFindingRow>(this.listFindingsStmt.all(reviewRunId)).flatMap((row) => {
      const mapped = mapFindingRow(row);
      return mapped ? [mapped] : [];
    });
  }

  public updateFinding(record: ReviewFindingRecord): ReviewFindingRecord {
    this.updateFindingStmt.run({
      findingId: record.findingId,
      recordJson: JSON.stringify(record),
      status: record.status,
      linkedTaskId: record.linkedTaskId ?? null,
      fixApprovalId: record.fixApprovalId ?? null,
      updatedAt: record.updatedAt,
    });
    return record;
  }
}

function mapRunRow(value: unknown): Omit<ReviewRunRecord, "findings"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as StructuredReviewRunRow;
  const modelReceipts = safeJsonParse<ReviewRunRecord["modelReceipts"]>(row.model_receipts_json, []);
  const preflightCandidate = safeJsonParse<Record<string, unknown>>(row.preflight_json, {});
  const preflight =
    typeof preflightCandidate.participantCount === "number"
      ? (preflightCandidate as NonNullable<ReviewRunRecord["preflight"]>)
      : undefined;
  return {
    reviewRunId: row.review_run_id,
    source: row.source,
    status: row.status,
    rootPath: row.root_path,
    reviewedSha: row.reviewed_sha,
    diffHash: row.diff_hash,
    changedFiles: safeJsonParse<string[]>(row.changed_files_json, []),
    reviewerRoster: safeJsonParse<string[]>(row.reviewer_roster_json, []),
    preflight,
    modelReceipts,
    assemblyRunId: modelReceipts.find((receipt) => receipt.runId)?.runId,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function mapFindingRow(value: unknown): ReviewFindingRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as StructuredReviewFindingRow;
  const record = safeJsonParse<ReviewFindingRecord | undefined>(row.record_json, undefined);
  if (!record) return undefined;
  return {
    ...record,
    status: row.status,
    linkedTaskId: row.linked_task_id ?? undefined,
    fixApprovalId: row.fix_approval_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

function serializeFinding(record: ReviewFindingRecord): Record<string, unknown> {
  return {
    findingId: record.findingId,
    reviewRunId: record.reviewRunId,
    recordJson: JSON.stringify(record),
    status: record.status,
    linkedTaskId: record.linkedTaskId ?? null,
    fixApprovalId: record.fixApprovalId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function boundedLimit(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
