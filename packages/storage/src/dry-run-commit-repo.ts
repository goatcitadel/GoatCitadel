import type {
  DryRunCommitDiagnostic,
  DryRunCommitRecord,
  DryRunCommitState,
  DryRunCommitStore,
  DryRunPlannedAction,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface DryRunCommitRow {
  dry_run_id: string;
  run_id: string;
  boundary: string;
  workspace_id: string | null;
  planned_action_json: string;
  payload_hash: string;
  dry_run_hash: string;
  state: DryRunCommitState;
  approved_at: string | null;
  approved_by: string | null;
  committed_at: string | null;
  diagnostic_json: string | null;
  external_reference_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Durable ledger for the provable dry-run → approve → commit flow. Implements the
 * `DryRunCommitStore` port from `@goatcitadel/contracts`, so gateway enforcement code
 * (dry-run-commit-service) runs unchanged against process memory or this table.
 *
 * The stored `planned_action_json` is evidence for operators; the enforcement hash
 * (`dry_run_hash`) is persisted separately and the commit path re-derives its own hash
 * from the action it is about to execute, so a corrupted stored preview can never
 * cause a wrong execution — only a refused one.
 */
export class DryRunCommitRepository implements DryRunCommitStore {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly updateStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO dry_run_commits (
        dry_run_id, run_id, boundary, workspace_id, planned_action_json, payload_hash,
        dry_run_hash, state, approved_at, approved_by, committed_at, diagnostic_json,
        external_reference_id, created_at, updated_at
      ) VALUES (
        @dryRunId, @runId, @boundary, @workspaceId, @plannedActionJson, @payloadHash,
        @dryRunHash, @state, @approvedAt, @approvedBy, @committedAt, @diagnosticJson,
        @externalReferenceId, @createdAt, @updatedAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM dry_run_commits WHERE dry_run_id = ?");
    this.updateStmt = db.prepare(`
      UPDATE dry_run_commits
      SET
        run_id = @runId,
        boundary = @boundary,
        workspace_id = @workspaceId,
        planned_action_json = @plannedActionJson,
        payload_hash = @payloadHash,
        dry_run_hash = @dryRunHash,
        state = @state,
        approved_at = @approvedAt,
        approved_by = @approvedBy,
        committed_at = @committedAt,
        diagnostic_json = @diagnosticJson,
        external_reference_id = @externalReferenceId,
        created_at = @createdAt,
        updated_at = @updatedAt
      WHERE dry_run_id = @dryRunId
    `);
  }

  public create(record: DryRunCommitRecord): DryRunCommitRecord {
    this.insertStmt.run(toParams(record));
    return this.get(record.dryRunId) ?? record;
  }

  public get(dryRunId: string): DryRunCommitRecord | undefined {
    const row = toDryRunCommitRow(this.getStmt.get(dryRunId));
    return row ? mapRow(row) : undefined;
  }

  public update(dryRunId: string, patch: Partial<DryRunCommitRecord>): DryRunCommitRecord | undefined {
    const current = this.get(dryRunId);
    if (!current) {
      return undefined;
    }
    // Spread-merge mirrors the in-memory store exactly: keys explicitly present in the
    // patch win, including ones set to undefined (which clear the stored value).
    const next: DryRunCommitRecord = { ...current, ...patch, dryRunId: current.dryRunId };
    this.updateStmt.run(toParams(next));
    return this.get(dryRunId);
  }
}

function toParams(record: DryRunCommitRecord): Record<string, string | null> {
  return {
    dryRunId: record.dryRunId,
    runId: record.runId,
    boundary: record.boundary,
    workspaceId: record.workspaceId ?? null,
    plannedActionJson: JSON.stringify(record.plannedAction),
    payloadHash: record.payloadHash,
    dryRunHash: record.dryRunHash,
    state: record.state,
    approvedAt: record.approvedAt ?? null,
    approvedBy: record.approvedBy ?? null,
    committedAt: record.committedAt ?? null,
    diagnosticJson: record.diagnostic ? JSON.stringify(record.diagnostic) : null,
    externalReferenceId: record.externalReferenceId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapRow(row: DryRunCommitRow): DryRunCommitRecord {
  const diagnostic = row.diagnostic_json
    ? safeJsonParse<DryRunCommitDiagnostic | undefined>(row.diagnostic_json, undefined)
    : undefined;
  return {
    dryRunId: row.dry_run_id,
    runId: row.run_id,
    boundary: row.boundary,
    workspaceId: row.workspace_id ?? undefined,
    plannedAction: safeJsonParse<DryRunPlannedAction>(row.planned_action_json, {
      route: "",
      target: "",
      payload: null,
    }),
    payloadHash: row.payload_hash,
    dryRunHash: row.dry_run_hash,
    state: row.state,
    approvedAt: row.approved_at ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    committedAt: row.committed_at ?? undefined,
    diagnostic: diagnostic ?? undefined,
    externalReferenceId: row.external_reference_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDryRunCommitRow(value: unknown): DryRunCommitRow | undefined {
  return isDryRunCommitRow(value) ? value : undefined;
}

function isDryRunCommitRow(value: unknown): value is DryRunCommitRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.dry_run_id === "string" &&
    typeof row.run_id === "string" &&
    typeof row.boundary === "string" &&
    (typeof row.workspace_id === "string" || row.workspace_id === null || row.workspace_id === undefined) &&
    typeof row.planned_action_json === "string" &&
    typeof row.payload_hash === "string" &&
    typeof row.dry_run_hash === "string" &&
    typeof row.state === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}
