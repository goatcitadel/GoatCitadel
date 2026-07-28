import type { DocumentPatchProposalRecord, DocumentPatchProposalState } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ProposalRow {
  proposal_id: string;
  schema_version: DocumentPatchProposalRecord["schemaVersion"];
  workspace_id: string;
  session_id: string | null;
  target_kind: DocumentPatchProposalRecord["targetKind"];
  target_id: string;
  base_revision: number | null;
  base_content_hash: string | null;
  proposed_content: string;
  derived_diff: string;
  author_kind: DocumentPatchProposalRecord["authorKind"];
  author_id: string;
  turn_id: string | null;
  state: DocumentPatchProposalState;
  applied_target_id: string | null;
  applied_revision: number | null;
  applied_content_hash: string | null;
  conflict_reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export class DocumentPatchProposalRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public create(record: DocumentPatchProposalRecord): DocumentPatchProposalRecord {
    this.db
      .prepare(
        `
      INSERT INTO document_patch_proposals (
        proposal_id, schema_version, workspace_id, session_id, target_kind, target_id,
        base_revision, base_content_hash, proposed_content, derived_diff, author_kind,
        author_id, turn_id, state, applied_target_id, applied_revision, applied_content_hash,
        conflict_reason, created_at, updated_at, resolved_at, resolved_by
      ) VALUES (
        @proposalId, @schemaVersion, @workspaceId, @sessionId, @targetKind, @targetId,
        @baseRevision, @baseContentHash, @proposedContent, @derivedDiff, @authorKind,
        @authorId, @turnId, @state, @appliedTargetId, @appliedRevision, @appliedContentHash,
        @conflictReason, @createdAt, @updatedAt, @resolvedAt, @resolvedBy
      )
    `,
      )
      .run(toParams(record));
    return this.get(record.proposalId);
  }

  public get(proposalId: string): DocumentPatchProposalRecord {
    const id = requireText(proposalId, "proposalId");
    const row = this.db.prepare("SELECT * FROM document_patch_proposals WHERE proposal_id = ? LIMIT 1").get(id);
    if (!isProposalRow(row)) throw new NotFoundError({ entity: "Document patch proposal", id });
    return mapRow(row);
  }

  public list(input: {
    workspaceId: string;
    sessionId?: string;
    targetKind?: DocumentPatchProposalRecord["targetKind"];
    targetId?: string;
    state?: DocumentPatchProposalState;
    limit?: number;
  }): DocumentPatchProposalRecord[] {
    const clauses = ["workspace_id = ?"];
    const values: unknown[] = [requireText(input.workspaceId, "workspaceId")];
    if (input.sessionId) {
      clauses.push("session_id = ?");
      values.push(input.sessionId);
    }
    if (input.targetKind) {
      clauses.push("target_kind = ?");
      values.push(input.targetKind);
    }
    if (input.targetId) {
      clauses.push("target_id = ?");
      values.push(input.targetId);
    }
    if (input.state) {
      clauses.push("state = ?");
      values.push(input.state);
    }
    values.push(Math.max(1, Math.min(500, Math.floor(input.limit ?? 100))));
    const rows = this.db
      .prepare(
        `
      SELECT * FROM document_patch_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, proposal_id DESC
      LIMIT ?
    `,
      )
      .all(...values);
    return Array.isArray(rows) ? rows.filter(isProposalRow).map(mapRow) : [];
  }

  public settle(
    proposalId: string,
    state: Exclude<DocumentPatchProposalState, "pending">,
    input: {
      updatedAt: string;
      resolvedBy: string;
      appliedTargetId?: string;
      appliedRevision?: number;
      appliedContentHash?: string;
      conflictReason?: string;
    },
  ): DocumentPatchProposalRecord {
    const result = this.db
      .prepare(
        `
      UPDATE document_patch_proposals
      SET state = @state,
          applied_target_id = @appliedTargetId,
          applied_revision = @appliedRevision,
          applied_content_hash = @appliedContentHash,
          conflict_reason = @conflictReason,
          updated_at = @updatedAt,
          resolved_at = @updatedAt,
          resolved_by = @resolvedBy
      WHERE proposal_id = @proposalId AND state = 'pending'
    `,
      )
      .run({
        proposalId: requireText(proposalId, "proposalId"),
        state,
        appliedTargetId: input.appliedTargetId ?? null,
        appliedRevision: input.appliedRevision ?? null,
        appliedContentHash: input.appliedContentHash ?? null,
        conflictReason: input.conflictReason ?? null,
        updatedAt: input.updatedAt,
        resolvedBy: requireText(input.resolvedBy, "resolvedBy"),
      });
    if (result.changes !== 1) return this.get(proposalId);
    return this.get(proposalId);
  }
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  return trimmed;
}

function toParams(record: DocumentPatchProposalRecord): Record<string, unknown> {
  return {
    ...record,
    sessionId: record.sessionId ?? null,
    baseRevision: record.baseRevision ?? null,
    baseContentHash: record.baseContentHash ?? null,
    turnId: record.turnId ?? null,
    appliedTargetId: record.appliedTargetId ?? null,
    appliedRevision: record.appliedRevision ?? null,
    appliedContentHash: record.appliedContentHash ?? null,
    conflictReason: record.conflictReason ?? null,
    resolvedAt: record.resolvedAt ?? null,
    resolvedBy: record.resolvedBy ?? null,
  };
}

function isProposalRow(value: unknown): value is ProposalRow {
  const row = value as Partial<ProposalRow> | undefined;
  return (
    Boolean(row) &&
    typeof row?.proposal_id === "string" &&
    typeof row.workspace_id === "string" &&
    typeof row.target_id === "string" &&
    typeof row.proposed_content === "string" &&
    typeof row.derived_diff === "string" &&
    typeof row.author_id === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function mapRow(row: ProposalRow): DocumentPatchProposalRecord {
  return {
    proposalId: row.proposal_id,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
    sessionId: row.session_id ?? undefined,
    targetKind: row.target_kind,
    targetId: row.target_id,
    baseRevision: row.base_revision ?? undefined,
    baseContentHash: row.base_content_hash ?? undefined,
    proposedContent: row.proposed_content,
    derivedDiff: row.derived_diff,
    authorKind: row.author_kind,
    authorId: row.author_id,
    turnId: row.turn_id ?? undefined,
    state: row.state,
    appliedTargetId: row.applied_target_id ?? undefined,
    appliedRevision: row.applied_revision ?? undefined,
    appliedContentHash: row.applied_content_hash ?? undefined,
    conflictReason: row.conflict_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
  };
}
