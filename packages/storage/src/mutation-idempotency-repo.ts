import type { DatabaseClient } from "./db.js";

export type MutationIdempotencyStatus = "pending" | "completed" | "failed";

export interface MutationIdempotencyRecord {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope: string;
  payloadHash: string;
  status: MutationIdempotencyStatus;
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
  created_at: string;
  updated_at: string;
}

export type MutationIdempotencyClaimResult =
  | { outcome: "claimed"; record: MutationIdempotencyRecord }
  | { outcome: "in_progress"; record: MutationIdempotencyRecord }
  | { outcome: "duplicate"; record: MutationIdempotencyRecord }
  | { outcome: "payload_mismatch"; record: MutationIdempotencyRecord };

export class MutationIdempotencyRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly updateStatusStmt;
  private readonly reviveStmt;

  public constructor(private readonly db: DatabaseClient) {
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
        created_at,
        updated_at
      ) VALUES (
        @method,
        @routePath,
        @idempotencyKey,
        @actorScope,
        @payloadHash,
        'pending',
        @now,
        @now
      )
    `);
    this.updateStatusStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET status = @status,
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
    `);
    this.reviveStmt = db.prepare(`
      UPDATE mutation_idempotency
      SET payload_hash = @payloadHash,
          status = 'pending',
          updated_at = @updatedAt
      WHERE method = @method
        AND route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
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
  }): MutationIdempotencyClaimResult {
    const actorScope = input.actorScope?.trim() ?? "";
    const now = input.now ?? new Date().toISOString();
    const identity = {
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope,
    };

    return this.db.transaction("immediate", () => {
      const existing = this.get(identity);
      if (!existing) {
        this.insertStmt.run({
          ...identity,
          payloadHash: input.payloadHash,
          now,
        });
        return {
          outcome: "claimed" as const,
          record: this.get(identity)!,
        };
      }
      if (existing.payloadHash !== input.payloadHash) {
        return {
          outcome: "payload_mismatch" as const,
          record: existing,
        };
      }
      if (existing.status === "failed") {
        this.reviveStmt.run({
          ...identity,
          payloadHash: input.payloadHash,
          updatedAt: now,
        });
        return {
          outcome: "claimed" as const,
          record: this.get(identity)!,
        };
      }
      return {
        outcome: existing.status === "pending" ? "in_progress" : "duplicate",
        record: existing,
      };
    });
  }

  public markCompleted(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    updatedAt?: string;
  }): void {
    this.updateStatus(input, "completed");
  }

  public markFailed(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    updatedAt?: string;
  }): void {
    this.updateStatus(input, "failed");
  }

  private updateStatus(
    input: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope?: string;
      updatedAt?: string;
    },
    status: MutationIdempotencyStatus,
  ): void {
    this.updateStatusStmt.run({
      method: input.method,
      routePath: input.routePath,
      idempotencyKey: input.idempotencyKey,
      actorScope: input.actorScope?.trim() ?? "",
      status,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
  }
}

function mapRow(row: MutationIdempotencyRow): MutationIdempotencyRecord {
  return {
    method: row.method,
    routePath: row.route_path,
    idempotencyKey: row.idempotency_key,
    actorScope: row.actor_scope,
    payloadHash: row.payload_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
