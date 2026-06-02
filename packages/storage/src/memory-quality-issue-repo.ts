import { randomUUID } from "node:crypto";
import type {
  MemoryFeedbackTargetKind,
  MemoryQualityIssueInput,
  MemoryQualityIssueKind,
  MemoryQualityIssueListRequest,
  MemoryQualityIssuePatchInput,
  MemoryQualityIssueRecord,
  MemoryQualityIssueSeverity,
  MemoryQualityIssueStatus,
  StructuredMemorySourceRef,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export type MemoryQualityIssueUpsertInput = MemoryQualityIssueInput & {
  dedupKey?: string;
};

export interface MemoryQualityIssueUpsertResult {
  record: MemoryQualityIssueRecord;
  created: boolean;
}

interface MemoryQualityIssueRow {
  issue_id: string;
  workspace_id: string;
  dedup_key: string;
  kind: MemoryQualityIssueKind;
  status: MemoryQualityIssueStatus;
  severity: MemoryQualityIssueSeverity;
  target_kind: MemoryFeedbackTargetKind;
  target_ref: string;
  related_refs_json: string | null;
  evidence_refs_json: string | null;
  summary: string;
  rationale: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export class MemoryQualityIssueRepository {
  private readonly getStmt;
  private readonly getByDedupKeyStmt;
  private readonly upsertOpenStmt;
  private readonly patchStatusStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM memory_quality_issues
      WHERE issue_id = ?
    `);
    this.getByDedupKeyStmt = db.prepare(`
      SELECT *
      FROM memory_quality_issues
      WHERE dedup_key = ?
    `);
    this.upsertOpenStmt = db.prepare(`
      INSERT INTO memory_quality_issues (
        issue_id,
        workspace_id,
        dedup_key,
        kind,
        status,
        severity,
        target_kind,
        target_ref,
        related_refs_json,
        evidence_refs_json,
        summary,
        rationale,
        metadata_json,
        created_at,
        updated_at,
        resolved_at,
        resolution_note
      ) VALUES (
        @issueId,
        @workspaceId,
        @dedupKey,
        @kind,
        'open',
        @severity,
        @targetKind,
        @targetRef,
        @relatedRefsJson,
        @evidenceRefsJson,
        @summary,
        @rationale,
        @metadataJson,
        @createdAt,
        @updatedAt,
        NULL,
        NULL
      )
      ON CONFLICT(dedup_key) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        kind = excluded.kind,
        status = 'open',
        severity = excluded.severity,
        target_kind = excluded.target_kind,
        target_ref = excluded.target_ref,
        related_refs_json = excluded.related_refs_json,
        evidence_refs_json = excluded.evidence_refs_json,
        summary = excluded.summary,
        rationale = excluded.rationale,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at,
        resolved_at = NULL,
        resolution_note = NULL
    `);
    this.patchStatusStmt = db.prepare(`
      UPDATE memory_quality_issues
      SET status = @status,
          resolution_note = @resolutionNote,
          resolved_at = @resolvedAt,
          updated_at = @updatedAt
      WHERE issue_id = @issueId
    `);
  }

  public list(input: MemoryQualityIssueListRequest = {}): MemoryQualityIssueRecord[] {
    const clauses = ["workspace_id = @workspaceId"];
    const params: Record<string, string | number> = {
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      limit: normalizeLimit(input.limit),
    };
    if (input.kind && input.kind !== "all") {
      clauses.push("kind = @kind");
      params.kind = input.kind;
    }
    if (input.status && input.status !== "all") {
      clauses.push("status = @status");
      params.status = input.status;
    }
    if (input.targetKind) {
      clauses.push("target_kind = @targetKind");
      params.targetKind = input.targetKind;
    }
    const rows = this.db
      .prepare(
        `
      SELECT *
      FROM memory_quality_issues
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE severity
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END,
        updated_at DESC
      LIMIT @limit
    `,
      )
      .all(params) as MemoryQualityIssueRow[];
    return rows.map(mapRow);
  }

  public upsertOpenIssue(input: MemoryQualityIssueUpsertInput): MemoryQualityIssueUpsertResult {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const targetRef = requireText(input.targetRef, "targetRef");
    const summary = requireText(input.summary, "summary");
    const dedupKey =
      input.dedupKey?.trim() || buildDedupKey(workspaceId, input.kind, input.targetKind, targetRef, input.relatedRefs);
    const existing = this.getByDedupKeyStmt.get(dedupKey) as MemoryQualityIssueRow | undefined;
    const now = new Date().toISOString();
    this.upsertOpenStmt.run({
      issueId: existing?.issue_id ?? randomUUID(),
      workspaceId,
      dedupKey,
      kind: input.kind,
      severity: normalizeSeverity(input.severity),
      targetKind: input.targetKind,
      targetRef,
      relatedRefsJson: JSON.stringify(normalizeRelatedRefs(input.relatedRefs)),
      evidenceRefsJson: JSON.stringify(normalizeEvidenceRefs(input.evidenceRefs)),
      summary,
      rationale: optionalText(input.rationale) ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    });
    return {
      record: this.requireByDedupKey(dedupKey),
      created: !existing,
    };
  }

  public patchStatus(issueId: string, input: MemoryQualityIssuePatchInput): MemoryQualityIssueRecord {
    const normalizedIssueId = requireText(issueId, "issueId");
    this.require(normalizedIssueId);
    const now = new Date().toISOString();
    this.patchStatusStmt.run({
      issueId: normalizedIssueId,
      status: input.status,
      resolutionNote: optionalText(input.resolutionNote) ?? null,
      resolvedAt: input.status === "open" ? null : now,
      updatedAt: now,
    });
    return this.require(normalizedIssueId);
  }

  public require(issueId: string): MemoryQualityIssueRecord {
    const row = this.getStmt.get(issueId) as MemoryQualityIssueRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory quality issue", id: issueId });
    }
    return mapRow(row);
  }

  private requireByDedupKey(dedupKey: string): MemoryQualityIssueRecord {
    const row = this.getByDedupKeyStmt.get(dedupKey) as MemoryQualityIssueRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory quality issue", id: dedupKey });
    }
    return mapRow(row);
  }
}

function mapRow(row: MemoryQualityIssueRow): MemoryQualityIssueRecord {
  return {
    issueId: row.issue_id,
    workspaceId: row.workspace_id,
    dedupKey: row.dedup_key,
    kind: row.kind,
    status: row.status,
    severity: row.severity,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    relatedRefs: safeJsonParse<string[]>(row.related_refs_json, []),
    evidenceRefs: safeJsonParse<StructuredMemorySourceRef[]>(row.evidence_refs_json, []),
    summary: row.summary,
    rationale: row.rationale ?? undefined,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
  };
}

function buildDedupKey(
  workspaceId: string,
  kind: MemoryQualityIssueKind,
  targetKind: MemoryFeedbackTargetKind,
  targetRef: string,
  relatedRefs: string[] | undefined,
): string {
  return [workspaceId, kind, targetKind, targetRef, ...normalizeRelatedRefs(relatedRefs).sort()].join("|");
}

function normalizeWorkspaceId(value: string | undefined): string {
  return value?.trim() || "default";
}

function normalizeLimit(value: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(value ?? 100), 500));
}

function normalizeSeverity(value: MemoryQualityIssueSeverity | undefined): MemoryQualityIssueSeverity {
  return value ?? "medium";
}

function normalizeRelatedRefs(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((item) => item.trim()).filter(Boolean))).slice(0, 25);
}

function normalizeEvidenceRefs(value: StructuredMemorySourceRef[] | undefined): StructuredMemorySourceRef[] {
  return (value ?? [])
    .map((ref) => ({
      sourceType: ref.sourceType,
      sourceRef: ref.sourceRef.trim(),
      title: ref.title?.trim() || undefined,
    }))
    .filter((ref) => ref.sourceRef)
    .slice(0, 25);
}

function requireText(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
