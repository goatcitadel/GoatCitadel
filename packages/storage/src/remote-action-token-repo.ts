import type {
  RemoteActionTokenRecord,
  RemoteActionTokenState,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { safeJsonParse } from "./safe-json.js";

interface RemoteActionTokenRow {
  token_id: string;
  token_hash: string;
  action_type: RemoteActionTokenRecord["actionType"];
  approval_id: string | null;
  connector_id: string;
  mutation_json: string;
  created_at: string;
  expires_at: string;
  state: RemoteActionTokenState;
  consumed_at: string | null;
  consumed_by: string | null;
}

export class RemoteActionTokenRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByHashStmt;
  private readonly setStateStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO remote_action_tokens (
        token_id, token_hash, action_type, approval_id, connector_id, mutation_json,
        created_at, expires_at, state, consumed_at, consumed_by
      ) VALUES (
        @tokenId, @tokenHash, @actionType, @approvalId, @connectorId, @mutationJson,
        @createdAt, @expiresAt, @state, NULL, NULL
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM remote_action_tokens WHERE token_id = ?");
    this.getByHashStmt = db.prepare("SELECT * FROM remote_action_tokens WHERE token_hash = ?");
    this.setStateStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = @state,
          consumed_at = @consumedAt,
          consumed_by = @consumedBy
      WHERE token_id = @tokenId
    `);
  }

  public create(input: {
    tokenId?: string;
    tokenHash: string;
    actionType: RemoteActionTokenRecord["actionType"];
    approvalId?: string;
    connectorId: string;
    mutation?: Record<string, unknown>;
    createdAt?: string;
    expiresAt: string;
  }): RemoteActionTokenRecord {
    const record: RemoteActionTokenRecord = {
      tokenId: input.tokenId ?? randomUUID(),
      actionType: input.actionType,
      approvalId: input.approvalId?.trim() || undefined,
      connectorId: input.connectorId.trim(),
      mutation: normalizeObject(input.mutation),
      createdAt: input.createdAt ?? new Date().toISOString(),
      expiresAt: input.expiresAt,
      state: "pending",
    };
    if (!input.tokenHash.trim()) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "tokenHash" });
    }
    if (!record.connectorId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "connectorId" });
    }
    this.insertStmt.run({
      tokenId: record.tokenId,
      tokenHash: input.tokenHash.trim(),
      actionType: record.actionType,
      approvalId: record.approvalId ?? null,
      connectorId: record.connectorId,
      mutationJson: JSON.stringify(record.mutation),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      state: record.state,
    });
    return this.get(record.tokenId);
  }

  public get(tokenId: string): RemoteActionTokenRecord {
    const row = this.getStmt.get(tokenId) as RemoteActionTokenRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Remote action token", id: tokenId });
    }
    return mapRow(row);
  }

  public findByTokenHash(tokenHash: string): RemoteActionTokenRecord | undefined {
    const row = this.getByHashStmt.get(tokenHash) as RemoteActionTokenRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public updateState(
    tokenId: string,
    state: RemoteActionTokenState,
    input?: {
      consumedAt?: string;
      consumedBy?: string;
    },
  ): RemoteActionTokenRecord {
    const current = this.get(tokenId);
    this.setStateStmt.run({
      tokenId,
      state,
      consumedAt: input?.consumedAt ?? current.consumedAt ?? null,
      consumedBy: input?.consumedBy ?? current.consumedBy ?? null,
    });
    return this.get(tokenId);
  }
}

function mapRow(row: RemoteActionTokenRow): RemoteActionTokenRecord {
  return {
    tokenId: row.token_id,
    actionType: row.action_type,
    approvalId: row.approval_id ?? undefined,
    connectorId: row.connector_id,
    mutation: safeJsonParse<Record<string, unknown>>(row.mutation_json, {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state: row.state,
    consumedAt: row.consumed_at ?? undefined,
    consumedBy: row.consumed_by ?? undefined,
  };
}

function normalizeObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}
