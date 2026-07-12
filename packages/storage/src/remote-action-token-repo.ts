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
const MAX_REMOTE_ACTION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type RemoteActionTokenClaimOutcome = "claimed" | "resumed" | "fingerprint_mismatch" | "unavailable";

export interface RemoteActionTokenClaimResult {
  outcome: RemoteActionTokenClaimOutcome;
  record?: RemoteActionTokenRecord;
}

export class RemoteActionTokenRepository {
  private readonly insertStmt;
  private readonly insertWithTtlStmt;
  private readonly getStmt;
  private readonly getPendingFreshStmt;
  private readonly getByHashStmt;
  private readonly listByApprovalStmt;
  private readonly listPendingExpiredStmt;
  private readonly listPendingExpiredAtDatabaseClockStmt;
  private readonly setStateStmt;
  private readonly consumePendingStmt;
  private readonly claimPendingStmt;
  private readonly expirePendingStmt;
  private readonly expirePendingIfExpiredStmt;
  private readonly expirePendingByApprovalStmt;

  public constructor(private readonly db: DatabaseClient) {
    const freshExpiryPredicate =
      db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(expires_at) > clock_timestamp()"
        : "julianday(expires_at) > julianday('now')";
    const expiredByDatabaseClockPredicate =
      db.dialect === "postgres"
        ? "COALESCE(gc_try_parse_timestamptz(expires_at) <= clock_timestamp(), TRUE)"
        : "COALESCE(julianday(expires_at) <= julianday('now'), 1)";
    const databaseNowText =
      db.dialect === "postgres"
        ? `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
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
    this.insertWithTtlStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          WITH database_clock AS (
            SELECT clock_timestamp() AS now_instant
          )
          INSERT INTO remote_action_tokens (
            token_id, token_hash, action_type, approval_id, connector_id, mutation_json,
            created_at, expires_at, state, consumed_at, consumed_by
          )
          SELECT
            @tokenId, @tokenHash, @actionType, @approvalId, @connectorId, @mutationJson,
            to_char(now_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            to_char(
              (now_instant + (CAST(@expiresInMs AS DOUBLE PRECISION) * interval '1 millisecond')) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'pending', NULL, NULL
          FROM database_clock
        `
        : `
          WITH database_clock AS (
            SELECT julianday('now') AS now_instant
          )
          INSERT INTO remote_action_tokens (
            token_id, token_hash, action_type, approval_id, connector_id, mutation_json,
            created_at, expires_at, state, consumed_at, consumed_by
          )
          SELECT
            @tokenId, @tokenHash, @actionType, @approvalId, @connectorId, @mutationJson,
            strftime('%Y-%m-%dT%H:%M:%fZ', now_instant),
            strftime('%Y-%m-%dT%H:%M:%fZ', now_instant + (CAST(@expiresInMs AS REAL) / 86400000.0)),
            'pending', NULL, NULL
          FROM database_clock
        `,
    );
    this.getStmt = db.prepare("SELECT * FROM remote_action_tokens WHERE token_id = ?");
    this.getPendingFreshStmt = db.prepare(`
      SELECT *
      FROM remote_action_tokens
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND ${freshExpiryPredicate}
    `);
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
    this.listPendingExpiredAtDatabaseClockStmt = db.prepare(`
      SELECT *
      FROM remote_action_tokens
      WHERE state = 'pending'
        AND ${expiredByDatabaseClockPredicate}
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
          consumed_at = ${databaseNowText},
          consumed_by = @consumedBy
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND ${freshExpiryPredicate}
    `);
    this.claimPendingStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'consumed',
          consumed_at = ${databaseNowText},
          consumed_by = @consumedBy,
          mutation_json = @mutationJson
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND ${freshExpiryPredicate}
    `);
    this.expirePendingStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'expired'
      WHERE token_id = @tokenId
        AND state = 'pending'
    `);
    this.expirePendingIfExpiredStmt = db.prepare(`
      UPDATE remote_action_tokens
      SET state = 'expired'
      WHERE token_id = @tokenId
        AND state = 'pending'
        AND ${expiredByDatabaseClockPredicate}
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

  /** Creates a pending token whose issued-at instant and relative TTL are owned by the database clock. */
  public createWithTtl(input: {
    tokenId?: string;
    tokenHash: string;
    actionType: RemoteActionTokenRecord["actionType"];
    approvalId?: string;
    connectorId: string;
    mutation?: Record<string, unknown>;
    expiresInMs: number;
  }): RemoteActionTokenRecord {
    const tokenId = input.tokenId ?? randomUUID();
    const tokenHash = input.tokenHash.trim();
    const connectorId = input.connectorId.trim();
    if (!tokenHash) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "tokenHash" });
    }
    if (!connectorId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "connectorId" });
    }
    const expiresInMs = Math.floor(input.expiresInMs);
    if (!Number.isFinite(input.expiresInMs) || expiresInMs < 1) {
      throw new ValidationError({ message: "Remote action token TTL must be a positive duration." });
    }
    if (expiresInMs > MAX_REMOTE_ACTION_TOKEN_TTL_MS) {
      throw new ValidationError({ message: "Remote action token TTL cannot exceed 24 hours." });
    }
    const mutation = normalizeObject(input.mutation);
    delete mutation[REMOTE_ACTION_CLAIM_FINGERPRINT_MUTATION_KEY];
    this.insertWithTtlStmt.run({
      tokenId,
      tokenHash,
      actionType: input.actionType,
      approvalId: input.approvalId?.trim() || null,
      connectorId,
      mutationJson: JSON.stringify(mutation),
      expiresInMs,
    });
    return this.get(tokenId);
  }

  public get(tokenId: string): RemoteActionTokenRecord {
    const row = this.getStmt.get(tokenId) as RemoteActionTokenRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Remote action token", id: tokenId });
    }
    return mapRow(row);
  }

  /** Returns a pending token only while the database clock says it is fresh. */
  public findPendingFresh(tokenId: string): RemoteActionTokenRecord | undefined {
    const row = this.getPendingFreshStmt.get({ tokenId }) as RemoteActionTokenRow | undefined;
    return row ? mapRow(row) : undefined;
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

  public listPendingExpired(limit = 100): RemoteActionTokenRecord[] {
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
    return (this.listPendingExpiredAtDatabaseClockStmt.all({ limit: boundedLimit }) as RemoteActionTokenRow[]).map(
      mapRow,
    );
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

  /** Expires a pending token only when the database clock owns that decision. */
  public expirePendingIfExpired(tokenId: string): RemoteActionTokenRecord {
    this.expirePendingIfExpiredStmt.run({ tokenId });
    return this.get(tokenId);
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
