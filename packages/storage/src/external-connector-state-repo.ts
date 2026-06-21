import type {
  ExternalConnectorReviewStatePatchInput,
  ExternalConnectorReviewStateRecord,
  ExternalConnectorReviewStatus,
  ExternalConnectorSourceId,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ExternalConnectorReviewStateRow {
  workspace_id: string;
  source_id: ExternalConnectorSourceId;
  service_id: string;
  action_id: string;
  status: ExternalConnectorReviewStatus;
  pinned: number;
  note: string | null;
  proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalConnectorReviewStateLookup {
  workspaceId?: string;
  sourceId: ExternalConnectorSourceId;
  serviceId: string;
  actionId?: string;
}

export interface ExternalConnectorReviewStateListQuery {
  workspaceId?: string;
  sourceId?: ExternalConnectorSourceId;
  serviceId?: string;
}

export class ExternalConnectorReviewStateRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM external_connector_review_states
      WHERE workspace_id = @workspaceId
        AND source_id = @sourceId
        AND service_id = @serviceId
        AND action_id = @actionId
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO external_connector_review_states (
        workspace_id, source_id, service_id, action_id, status, pinned, note, proposal_id, created_at, updated_at
      ) VALUES (
        @workspaceId, @sourceId, @serviceId, @actionId, @status, @pinned, @note, @proposalId, @createdAt, @updatedAt
      )
      ON CONFLICT(workspace_id, source_id, service_id, action_id) DO UPDATE SET
        status = excluded.status,
        pinned = excluded.pinned,
        note = excluded.note,
        proposal_id = excluded.proposal_id,
        updated_at = excluded.updated_at
    `);
  }

  public list(query: ExternalConnectorReviewStateListQuery = {}): ExternalConnectorReviewStateRecord[] {
    const params: Record<string, unknown> = {
      workspaceId: sanitizeWorkspaceId(query.workspaceId),
    };
    const clauses = ["workspace_id = @workspaceId"];
    if (query.sourceId) {
      params.sourceId = query.sourceId;
      clauses.push("source_id = @sourceId");
    }
    if (query.serviceId?.trim()) {
      params.serviceId = sanitizeRequired(query.serviceId, "serviceId");
      clauses.push("service_id = @serviceId");
    }
    const rows = toRows(
      this.db
        .prepare(
          `
            SELECT *
            FROM external_connector_review_states
            WHERE ${clauses.join(" AND ")}
            ORDER BY pinned DESC, updated_at DESC, service_id ASC, action_id ASC
          `,
        )
        .all(params),
    );
    return rows.map(mapRow);
  }

  public find(input: ExternalConnectorReviewStateLookup): ExternalConnectorReviewStateRecord | undefined {
    const row = toRow(
      this.getStmt.get({
        workspaceId: sanitizeWorkspaceId(input.workspaceId),
        sourceId: input.sourceId,
        serviceId: sanitizeRequired(input.serviceId, "serviceId"),
        actionId: sanitizeActionId(input.actionId),
      }),
    );
    return row ? mapRow(row) : undefined;
  }

  public upsert(
    lookup: ExternalConnectorReviewStateLookup,
    patch: ExternalConnectorReviewStatePatchInput,
    now = new Date().toISOString(),
  ): ExternalConnectorReviewStateRecord {
    const current = this.find(lookup);
    const record: ExternalConnectorReviewStateRecord = {
      workspaceId: sanitizeWorkspaceId(lookup.workspaceId),
      sourceId: lookup.sourceId,
      serviceId: sanitizeRequired(lookup.serviceId, "serviceId"),
      actionId: sanitizeActionId(lookup.actionId) || undefined,
      status: patch.status ?? current?.status ?? "reviewed",
      pinned: patch.pinned ?? current?.pinned ?? false,
      note: patch.note === undefined ? current?.note : (patch.note ?? undefined),
      proposalId: patch.proposalId === undefined ? current?.proposalId : (patch.proposalId ?? undefined),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.upsertStmt.run({
      workspaceId: record.workspaceId,
      sourceId: record.sourceId,
      serviceId: record.serviceId,
      actionId: record.actionId ?? "",
      status: record.status,
      pinned: record.pinned ? 1 : 0,
      note: record.note ?? null,
      proposalId: record.proposalId ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    const stored = this.find(lookup);
    if (!stored) {
      throw new Error("Failed to persist external connector review state.");
    }
    return stored;
  }
}

function mapRow(row: ExternalConnectorReviewStateRow): ExternalConnectorReviewStateRecord {
  return {
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    serviceId: row.service_id,
    actionId: row.action_id || undefined,
    status: row.status,
    pinned: Boolean(row.pinned),
    note: row.note ?? undefined,
    proposalId: row.proposal_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeWorkspaceId(value?: string): string {
  const normalized = value?.trim() || "default";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return normalized;
}

function sanitizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function sanitizeActionId(value?: string): string {
  return value?.trim() || "";
}

function toRow(value: unknown): ExternalConnectorReviewStateRow | undefined {
  return isRow(value) ? value : undefined;
}

function toRows(value: unknown): ExternalConnectorReviewStateRow[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is ExternalConnectorReviewStateRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.workspace_id === "string" &&
    typeof row.source_id === "string" &&
    typeof row.service_id === "string" &&
    typeof row.action_id === "string" &&
    typeof row.status === "string" &&
    typeof row.pinned === "number" &&
    (typeof row.note === "string" || row.note === null) &&
    (typeof row.proposal_id === "string" || row.proposal_id === null) &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}
