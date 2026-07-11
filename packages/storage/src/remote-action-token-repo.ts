import type { RemoteActionTokenRecord, RemoteActionTokenState } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
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

export const REMOTE_ACTION_CLAIM_FINGERPRINT_MUTATION_KEY = "__remoteActionClaimFingerprint";

export type RemoteActionTokenClaimOutcome = "claimed" | "resumed" | "fingerprint_mismatch" | "unavailable";

export interface RemoteActionTokenClaimResult {
  outcome: RemoteActionTokenClaimOutcome;
  record?: RemoteActionTokenRecord;
}

export class RemoteActionTokenRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByHashStmt;
  private readonly listByApprovalStmt;
  private readonly listPendingExpiredStmt;
  private readonly setStateStmt;
  private readonly consumePendingStmt;
  private readonly claimPendingStmt;
  private readonly expirePendingStmt;
  private readonly expirePendingByApprovalStmt;

  public constructor(private readonly db: DatabaseClient) {
    const freshExpiryPredicate =
      db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(expires_at) > clock_timestamp()"
        : "julianday(expires_at) > julianday('now')";
    const expiredAtBoundaryPredicate =
      db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(expires_at) <= gc_try_parse_timestamptz(@boundaryAt)"
        : "julianday(expires_at) <= julianday(@boundaryAt)";
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
    this.listByApprovalStmt = db.prepare(`
      SELECT *
      FROM remote_action_tokens
      WHERE approval_id = ?
      ORDER BY created_at ASC, token_id ASC
    `);
    this.listPendingExpiredStmt = db.prepare(`
      SELECT *
      FROM remote_action_tokens
      WHERE state = 'pending'
        AND ${expiredAtBoundaryPredicate}
      ORDER BY expires_at ASC, token_id ASC
      LIMIT @limit
    `);
    this.setStateStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = @state,
          consumed_at = @consumedAt,
          consumed_by = @consumedBy
      WHERE token_id = @tokenId
    `);
    this.consumePendingStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'consumed',
          consumed_at = @consumedAt,
          consumed_by = @consumedBy
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND expires_at > @consumedAt
        AND ${freshExpiryPredicate}
    `);
    this.claimPendingStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'consumed',
          consumed_at = @consumedAt,
          consumed_by = @consumedBy,
          mutation_json = @mutationJson
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND expires_at > @consumedAt
        AND ${freshExpiryPredicate}
    `);
    this.expirePendingStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'expired'
      WHERE token_id = @tokenId
        AND state = 'pending'
    `);
    this.expirePendingByApprovalStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'expired'
      WHERE approval_id = @approvalId
        AND state = 'pending'
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
    const mutation = normalizeObject(input.mutation);
    delete mutation[REMOTE_ACTION_CLAIM_FINGERPRINT_MUTATION_KEY];
    const record: RemoteActionTokenRecord = {
      tokenId: input.tokenId ?? randomUUID(),
      actionType: input.actionType,
      approvalId: input.approvalId?.trim() || undefined,
      connectorId: input.connectorId.trim(),
      mutation,
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

  public listByApprovalId(approvalId: string): RemoteActionTokenRecord[] {
    const normalizedApprovalId = approvalId.trim();
    if (!normalizedApprovalId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "approvalId" });
    }
    return (this.listByApprovalStmt.all(normalizedApprovalId) as RemoteActionTokenRow[]).map(mapRow);
  }

  public listPendingExpiredAtOrBefore(boundaryAt: string, limit = 100): RemoteActionTokenRecord[] {
    if (!Number.isFinite(Date.parse(boundaryAt))) {
      throw new ValidationError({ message: "Remote action token expiry boundary must be a valid timestamp." });
    }
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
    return (this.listPendingExpiredStmt.all({ boundaryAt, limit: boundedLimit }) as RemoteActionTokenRow[]).map(mapRow);
  }

  /** Expire every still-pending token for a terminal approval without overwriting a consumed winner. */
  public expirePendingByApprovalId(approvalId: string): number {
    const normalizedApprovalId = approvalId.trim();
    if (!normalizedApprovalId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "approvalId" });
    }
    const result = this.expirePendingByApprovalStmt.run({ approvalId: normalizedApprovalId });
    return Number(result.changes ?? 0);
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

  public consumePending(
    tokenId: string,
    input: {
      consumedAt: string;
      consumedBy: string;
    },
  ): RemoteActionTokenRecord | undefined {
    const result = this.consumePendingStmt.run({
      tokenId,
      consumedAt: input.consumedAt,
      consumedBy: input.consumedBy,
    });
    return (result.changes ?? 0) > 0 ? this.get(tokenId) : undefined;
  }

  /**
   * Atomically consumes a pending token while binding it to one stable request
   * fingerprint. A retry with the same fingerprint resumes the first consumed
   * record without changing its original consumer metadata; a competing
   * fingerprint is reported distinctly so callers can fail closed.
   */
  public claimPending(
    tokenId: string,
    input: {
      consumedAt: string;
      consumedBy: string;
      claimFingerprint: string;
    },
  ): RemoteActionTokenClaimResult {
    const claimFingerprint = normalizeClaimFingerprint(input.claimFingerprint);
    const current = this.get(tokenId);
    const existing = classifyExistingClaim(current, claimFingerprint);
    if (existing) {
      return existing;
    }

    const mutation = {
      ...current.mutation,
      [REMOTE_ACTION_CLAIM_FINGERPRINT_MUTATION_KEY]: claimFingerprint,
    };
    const result = this.claimPendingStmt.run({
      tokenId,
      consumedAt: input.consumedAt,
      consumedBy: input.consumedBy,
      mutationJson: JSON.stringify(mutation),
    });
    if ((result.changes ?? 0) > 0) {
      return {
        outcome: "claimed",
        record: this.get(tokenId),
      };
    }

    // Another claimant may have won after our initial read. Classify the
    // persisted winner instead of trusting the stale pre-CAS record.
    const persisted = this.get(tokenId);
    return (
      classifyExistingClaim(persisted, claimFingerprint) ?? {
        outcome: "unavailable",
        record: persisted,
      }
    );
  }

  public readClaimFingerprint(record: RemoteActionTokenRecord | undefined): string | undefined {
    return readRemoteActionTokenClaimFingerprint(record);
  }

  /** Marks a token expired only while it is still unclaimed. */
  public expirePending(tokenId: string): RemoteActionTokenRecord | undefined {
    const result = this.expirePendingStmt.run({ tokenId });
    return (result.changes ?? 0) > 0 ? this.get(tokenId) : undefined;
  }

  /**
   * Settles the expiry boundary inside the repository that owns the token CAS.
   * The returned record is always the latest persisted winner, so callers do
   * not need a separate read/expire sequence that could misclassify a claim.
   */
  public expirePendingAtOrBefore(tokenId: string, boundaryAt: string): RemoteActionTokenRecord {
    const boundaryMs = Date.parse(boundaryAt);
    if (!Number.isFinite(boundaryMs)) {
      throw new ValidationError({ message: "Remote action token expiry boundary must be a valid timestamp." });
    }
    const current = this.get(tokenId);
    const expiresAt = Date.parse(current.expiresAt);
    if (current.state !== "pending" || !Number.isFinite(expiresAt) || expiresAt > boundaryMs) {
      return current;
    }
    return this.expirePending(tokenId) ?? this.get(tokenId);
  }
}

export function readRemoteActionTokenClaimFingerprint(record: RemoteActionTokenRecord | undefined): string | undefined {
  const value = record?.mutation[REMOTE_ACTION_CLAIM_FINGERPRINT_MUTATION_KEY];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function classifyExistingClaim(
  record: RemoteActionTokenRecord,
  claimFingerprint: string,
): RemoteActionTokenClaimResult | undefined {
  if (record.state === "pending") {
    return undefined;
  }
  if (record.state !== "consumed") {
    return { outcome: "unavailable", record };
  }
  return readRemoteActionTokenClaimFingerprint(record) === claimFingerprint
    ? { outcome: "resumed", record }
    : { outcome: "fingerprint_mismatch", record };
}

function normalizeClaimFingerprint(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "claimFingerprint" });
  }
  return normalized;
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
  return { ...value };
}
