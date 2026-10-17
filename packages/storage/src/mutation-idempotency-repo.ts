import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";

export type MutationIdempotencyStatus = "pending" | "completed" | "failed" | "unknown_after_send";

export interface MutationIdempotencyRecord {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope: string;
  payloadHash: string;
  status: MutationIdempotencyStatus;
  claimToken?: string;
  claimExpiresAt?: string;
  /** Set once the claim holder crossed the external dispatch boundary. */
  dispatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface MutationIdempotencyRow {
  method: string;
  route_path: string;
  idempotency_key: string;
  actor_scope: string;
  payload_hash: string;
  status: MutationIdempotencyStatus;
  claim_token: string | null;
  claim_expires_at: string | null;
  dispatched_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type MutationIdempotencyClaimResult =
  | {
      outcome: "claimed";
      record: MutationIdempotencyRecord;
      claimKind: "new" | "retry_after_failure" | "retry_after_stale_claim" | "redispatch_after_stale_send";
    }
  | { outcome: "unknown_after_send"; record: MutationIdempotencyRecord }
  | { outcome: "in_progress"; record: MutationIdempotencyRecord }
  | { outcome: "duplicate"; record: MutationIdempotencyRecord }
  | { outcome: "payload_mismatch"; record: MutationIdempotencyRecord };

export type MutationIdempotencyDispatchResult =
  | { outcome: "dispatched"; record: MutationIdempotencyRecord }
  | { outcome: "claim_lost"; record?: MutationIdempotencyRecord };

interface MutationIdempotencyIdentityInput {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope?: string;
}

export class MutationIdempotencyRepository {
  private readonly databaseNowStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly updateStatusStmt;
  private readonly updateOwnedStatusStmt;
  private readonly discardOwnedPendingStmt;
  private readonly reviveFailedStmt;
  private readonly takeoverStaleStmt;
  private readonly settleStaleDispatchedStmt;
  private readonly markDispatchedStmt;
  private readonly markReconciledCompletedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          SELECT to_char(
            clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS now_iso
        `
        : `
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso
        `,
    );
    this.getStmt = db.prepare(`
      SELECT *
      FROM mutation_idempotency
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO mutation_idempotency (
        method,
        route_path,
        idempotency_key,
        actor_scope,
        payload_hash,
        status,
        claim_token,
        claim_expires_at,
        created_at,
        updated_at
      ) VALUES (
        @method,
        @routePath,
        @idempotencyKey,
        @actorScope,
        @payloadHash,
        'pending',
        @claimToken,
        @claimExpiresAt,
        @now,
        @now
      )
      ON CONFLICT (method, route_path, idempotency_key, actor_scope) DO NOTHING
    `);
    // Unowned (token-less) settlement never rewrites an ambiguous sent claim:
    // turning it into `failed` would make the next claim redispatch it.
    this.updateStatusStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET status = @status,
          claim_expires_at = NULL,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status <> 'unknown_after_send'
    `);
    this.markReconciledCompletedStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET status = 'completed',
          claim_expires_at = NULL,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status = 'unknown_after_send'
    `);
    this.updateOwnedStatusStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET status = @status,
          claim_expires_at = NULL,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status = 'pending'
        AND claim_token = @claimToken
    `);
    this.discardOwnedPendingStmt = db.prepare(`
      DELETE FROM mutation_idempotency
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND payload_hash = @payloadHash
        AND status = 'pending'
        AND claim_token = @claimToken
    `);
    this.reviveFailedStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET payload_hash = @payloadHash,
          status = 'pending',
          claim_token = @claimToken,
          claim_expires_at = @claimExpiresAt,
          dispatched_at = NULL,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status = 'failed'
    `);
    const previousClaimTokenMatchesSql =
      db.dialect === "postgres"
        ? "claim_token IS NOT DISTINCT FROM CAST(@previousClaimToken AS TEXT)"
        : "claim_token IS @previousClaimToken";
    this.takeoverStaleStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET payload_hash = @payloadHash,
          status = 'pending',
          claim_token = @claimToken,
          claim_expires_at = @claimExpiresAt,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status = 'pending'
        AND (claim_expires_at IS NULL OR claim_expires_at <= @updatedAt)
        AND ${previousClaimTokenMatchesSql}
    `);
    // A stale holder that already crossed the dispatch boundary may have
    // produced the external side effect. Without a provider-enforced
    // idempotency key nobody may redispatch, so the row settles terminally and
    // the token rotates to a fresh value no caller holds.
    this.settleStaleDispatchedStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET status = 'unknown_after_send',
          claim_token = @claimToken,
          claim_expires_at = NULL,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND payload_hash = @payloadHash
        AND status = 'pending'
        AND dispatched_at IS NOT NULL
        AND (claim_expires_at IS NULL OR claim_expires_at <= @updatedAt)
        AND ${previousClaimTokenMatchesSql}
    `);
    this.markDispatchedStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET dispatched_at = @now,
          claim_token = @nextClaimToken,
          claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
        AND status = 'pending'
        AND claim_token = @claimToken
    `);
  }

  public get(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
  }): MutationIdempotencyRecord | undefined {
    const row = this.getStmt.get({
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope: input.actorScope?.trim() ?? "",
    }) as MutationIdempotencyRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public claim(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    payloadHash: string;
    now?: string;
    leaseDurationMs?: number;
    /**
     * True only when the downstream provider itself deduplicates on the
     * idempotency key, which makes redispatching a sent stale claim safe.
     */
    providerIdempotencyKeyEnforced?: boolean;
  }): MutationIdempotencyClaimResult {
    const actorScope = input.actorScope?.trim() ?? "";
    const leaseDurationMs = normalizeLeaseDurationMs(input.leaseDurationMs);
    const identity = {
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope,
    };

    return this.db.transaction("immediate", () => {
      const now = normalizeClaimTime(input.now ?? this.readDatabaseNow());
      const nowMs = Date.parse(now);
      const claimExpiresAt = leaseDurationMs === undefined ? null : new Date(nowMs + leaseDurationMs).toISOString();
      const existing = this.get(identity);
      if (!existing) {
        const claimToken = randomUUID();
        const inserted = this.insertStmt.run({
          ...identity,
          payloadHash: input.payloadHash,
          claimToken,
          claimExpiresAt,
          now,
        });
        if (inserted.changes > 0) {
          return {
            outcome: "claimed" as const,
            claimKind: "new" as const,
            record: this.get(identity)!,
          };
        }
      }
      const current = existing ?? this.get(identity);
      if (!current) {
        throw new Error("Mutation idempotency claim disappeared during acquisition.");
      }
      if (current.payloadHash !== input.payloadHash) {
        return {
          outcome: "payload_mismatch" as const,
          record: current,
        };
      }
      if (current.status === "completed") {
        return { outcome: "duplicate", record: current };
      }
      if (current.status === "unknown_after_send") {
        return { outcome: "unknown_after_send", record: current };
      }
      if (current.status === "failed") {
        const claimToken = randomUUID();
        const revived = this.reviveFailedStmt.run({
          ...identity,
          payloadHash: input.payloadHash,
          claimToken,
          claimExpiresAt,
          updatedAt: now,
        });
        if (revived.changes > 0) {
          return {
            outcome: "claimed" as const,
            claimKind: "retry_after_failure" as const,
            record: this.get(identity)!,
          };
        }
        return classifyConcurrentClaim(this.get(identity) ?? current, input.payloadHash);
      }
      // Stale takeover is opt-in. External-side-effect callers use this same
      // repository but do not yet carry generation tokens end-to-end, so a
      // time-only takeover there would permit duplicate provider mutations.
      if (leaseDurationMs === undefined || isClaimLeaseActive(current, nowMs)) {
        return { outcome: "in_progress", record: current };
      }
      const claimToken = randomUUID();
      if (current.dispatchedAt && input.providerIdempotencyKeyEnforced !== true) {
        const settled = this.settleStaleDispatchedStmt.run({
          ...identity,
          payloadHash: input.payloadHash,
          claimToken,
          previousClaimToken: current.claimToken ?? null,
          updatedAt: now,
        });
        if (settled.changes > 0) {
          return { outcome: "unknown_after_send" as const, record: this.get(identity)! };
        }
        return classifyConcurrentClaim(this.get(identity) ?? current, input.payloadHash);
      }
      const reclaimed = this.takeoverStaleStmt.run({
        ...identity,
        payloadHash: input.payloadHash,
        claimToken,
        claimExpiresAt,
        previousClaimToken: current.claimToken ?? null,
        updatedAt: now,
      });
      if (reclaimed.changes > 0) {
        return {
          outcome: "claimed" as const,
          claimKind: current.dispatchedAt
            ? ("redispatch_after_stale_send" as const)
            : ("retry_after_stale_claim" as const),
          record: this.get(identity)!,
        };
      }
      return classifyConcurrentClaim(this.get(identity) ?? current, input.payloadHash);
    });
  }

  /**
   * Records that the owning generation is about to cross the external dispatch
   * boundary. The CAS rotates the claim token so any holder of the pre-dispatch
   * token is fenced; the caller must use the returned record's token afterwards.
   */
  public markDispatched(
    input: MutationIdempotencyIdentityInput & {
      claimToken: string;
      leaseDurationMs?: number;
      now?: string;
    },
  ): MutationIdempotencyDispatchResult {
    const identity = normalizeIdentity(input);
    const claimToken = input.claimToken.trim();
    const leaseDurationMs = normalizeLeaseDurationMs(input.leaseDurationMs);
    return this.db.transaction("immediate", () => {
      if (!claimToken) {
        return { outcome: "claim_lost" as const, record: this.get(identity) };
      }
      const now = normalizeClaimTime(input.now ?? this.readDatabaseNow());
      const claimExpiresAt =
        leaseDurationMs === undefined ? null : new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const marked = this.markDispatchedStmt.run({
        ...identity,
        claimToken,
        nextClaimToken: randomUUID(),
        claimExpiresAt,
        now,
      });
      const record = this.get(identity);
      if (marked.changes > 0 && record) {
        return { outcome: "dispatched" as const, record };
      }
      return { outcome: "claim_lost" as const, record };
    });
  }

  /**
   * Settles the caller's own still-pending generation (dispatched or not)
   * whose external outcome cannot be proven either way, e.g. a callback that
   * returned without recording its dispatch boundary. Terminal: later claims
   * report `unknown_after_send` instead of redispatching.
   */
  public markUnknownAfterSend(
    input: MutationIdempotencyIdentityInput & { claimToken: string; updatedAt?: string },
  ): boolean {
    if (!input.claimToken.trim()) {
      return false;
    }
    return this.updateStatus(input, "unknown_after_send");
  }

  /**
   * Settles an ambiguous sent claim as completed once a provider probe has
   * proven the effect landed. Only unknown_after_send is eligible; any other
   * status (including a concurrent winner) is left untouched.
   */
  public markReconciledCompleted(input: MutationIdempotencyIdentityInput & { updatedAt?: string }): boolean {
    return (
      this.markReconciledCompletedStmt.run({
        method: input.method,
        routePath: input.routePath,
        idempotencyKey: input.idempotencyKey,
        actorScope: input.actorScope?.trim() ?? "",
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      }).changes > 0
    );
  }

  private readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (!row || typeof row.now_iso !== "string") {
      throw new Error("Database did not return a mutation idempotency claim timestamp.");
    }
    return row.now_iso;
  }

  public markCompleted(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    updatedAt?: string;
    claimToken?: string;
  }): boolean {
    return this.updateStatus(input, "completed");
  }

  public markFailed(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    updatedAt?: string;
    claimToken?: string;
  }): boolean {
    return this.updateStatus(input, "failed");
  }

  /**
   * Removes only the caller's still-pending generation when a separate durable
   * authority proves the mutation must not proceed. Completed, failed, or
   * replacement generations are never removed.
   */
  public discardPending(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    payloadHash: string;
    claimToken: string;
  }): boolean {
    const identity = {
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope: input.actorScope?.trim() ?? "",
    };
    const claimToken = input.claimToken.trim();
    if (!claimToken) {
      return false;
    }
    const discarded = this.discardOwnedPendingStmt.run({
      ...identity,
      payloadHash: input.payloadHash,
      claimToken,
    });
    return discarded.changes > 0 || this.get(identity) === undefined;
  }

  private updateStatus(
    input: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope?: string;
      updatedAt?: string;
      claimToken?: string;
    },
    status: MutationIdempotencyStatus,
  ): boolean {
    const identity = {
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope: input.actorScope?.trim() ?? "",
    };
    const claimToken = input.claimToken?.trim();
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const update = claimToken
      ? this.updateOwnedStatusStmt.run({ ...identity, status, updatedAt, claimToken })
      : this.updateStatusStmt.run({ ...identity, status, updatedAt });
    if (update.changes > 0) {
      return true;
    }
    if (!claimToken) {
      return false;
    }
    const current = this.get(identity);
    return current?.status === status && current.claimToken === claimToken;
  }
}

function normalizeClaimTime(value: string): string {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) {
    throw new Error("Mutation idempotency claim time must be a valid ISO timestamp.");
  }
  return new Date(timestampMs).toISOString();
}

function normalizeLeaseDurationMs(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Mutation idempotency claim lease duration must be a positive number.");
  }
  return Math.floor(value);
}

function isClaimLeaseActive(record: MutationIdempotencyRecord, nowMs: number): boolean {
  const expiresAtMs = record.claimExpiresAt ? Date.parse(record.claimExpiresAt) : Number.NaN;
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function classifyConcurrentClaim(
  record: MutationIdempotencyRecord,
  payloadHash: string,
): Exclude<MutationIdempotencyClaimResult, { outcome: "claimed" }> {
  if (record.payloadHash !== payloadHash) {
    return { outcome: "payload_mismatch", record };
  }
  if (record.status === "unknown_after_send") {
    return { outcome: "unknown_after_send", record };
  }
  return { outcome: record.status === "completed" ? "duplicate" : "in_progress", record };
}

function normalizeIdentity(input: MutationIdempotencyIdentityInput): Required<MutationIdempotencyIdentityInput> {
  return {
    method: input.method,
    routePath: input.routePath,
    idempotencyKey: input.idempotencyKey,
    actorScope: input.actorScope?.trim() ?? "",
  };
}

function mapRow(row: MutationIdempotencyRow): MutationIdempotencyRecord {
  return {
    method: row.method,
    routePath: row.route_path,
    idempotencyKey: row.idempotency_key,
    actorScope: row.actor_scope,
    payloadHash: row.payload_hash,
    status: row.status,
    claimToken: row.claim_token ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    dispatchedAt: row.dispatched_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
