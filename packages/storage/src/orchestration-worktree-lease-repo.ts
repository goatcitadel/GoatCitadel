import type { DatabaseClient } from "./db.js";

interface OrchestrationWorktreeLeaseRow {
  worktree_path: string;
  run_id: string;
  owner_id: string;
  generation: number | string;
  lease_expires_at: string;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrchestrationWorktreeLeaseRecord {
  worktreePath: string;
  runId: string;
  ownerId: string;
  generation: number;
  leaseExpiresAt: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type OrchestrationWorktreeLeaseClaimResult =
  | {
      outcome: "claimed";
      claimKind: "new" | "renewed" | "reclaimed";
      lease: OrchestrationWorktreeLeaseRecord;
    }
  | {
      outcome: "blocked";
      lease: OrchestrationWorktreeLeaseRecord;
    };

export interface OrchestrationWorktreeLeaseToken {
  worktreePath: string;
  runId: string;
  ownerId: string;
  generation: number;
}

export class OrchestrationWorktreeLeaseRepository {
  private readonly databaseNowStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly renewStmt;
  private readonly reclaimStmt;
  private readonly releaseStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          SELECT to_char(
            clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS now_iso
        `
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso`,
    );
    this.getStmt = db.prepare("SELECT * FROM orchestration_worktree_leases WHERE worktree_path = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO orchestration_worktree_leases (
        worktree_path,
        run_id,
        owner_id,
        generation,
        lease_expires_at,
        released_at,
        created_at,
        updated_at
      ) VALUES (
        @worktreePath,
        @runId,
        @ownerId,
        1,
        @leaseExpiresAt,
        NULL,
        @now,
        @now
      )
      ON CONFLICT (worktree_path) DO NOTHING
    `);
    this.renewStmt = db.prepare(`
      UPDATE orchestration_worktree_leases
      SET lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE worktree_path = @worktreePath
        AND run_id = @runId
        AND owner_id = @ownerId
        AND generation = @generation
        AND released_at IS NULL
        AND lease_expires_at > @now
    `);
    const releasedAtMatches =
      db.dialect === "postgres"
        ? "released_at IS NOT DISTINCT FROM CAST(@expectedReleasedAt AS TEXT)"
        : "released_at IS @expectedReleasedAt";
    this.reclaimStmt = db.prepare(`
      UPDATE orchestration_worktree_leases
      SET run_id = @runId,
          owner_id = @ownerId,
          generation = @generation,
          lease_expires_at = @leaseExpiresAt,
          released_at = NULL,
          updated_at = @now
      WHERE worktree_path = @worktreePath
        AND run_id = @expectedRunId
        AND owner_id = @expectedOwnerId
        AND generation = @expectedGeneration
        AND lease_expires_at = @expectedLeaseExpiresAt
        AND updated_at = @expectedUpdatedAt
        AND ${releasedAtMatches}
    `);
    this.releaseStmt = db.prepare(`
      UPDATE orchestration_worktree_leases
      SET lease_expires_at = @releasedAt,
          released_at = @releasedAt,
          updated_at = @releasedAt
      WHERE worktree_path = @worktreePath
        AND run_id = @runId
        AND owner_id = @ownerId
        AND generation = @generation
        AND released_at IS NULL
    `);
  }

  public get(worktreePath: string): OrchestrationWorktreeLeaseRecord | undefined {
    const normalizedPath = normalizeRequiredString(worktreePath, "worktree path");
    const row = this.getStmt.get(normalizedPath) as OrchestrationWorktreeLeaseRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public claim(input: {
    worktreePath: string;
    runId: string;
    ownerId: string;
    leaseDurationMs: number;
    now?: string;
  }): OrchestrationWorktreeLeaseClaimResult {
    const worktreePath = normalizeRequiredString(input.worktreePath, "worktree path");
    const runId = normalizeRequiredString(input.runId, "run id");
    const ownerId = normalizeRequiredString(input.ownerId, "owner id");
    const leaseDurationMs = normalizeLeaseDurationMs(input.leaseDurationMs);

    return this.db.transaction("immediate", () => {
      const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "lease claim time");
      const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const existing = this.get(worktreePath);
      if (!existing) {
        const inserted = this.insertStmt.run({ worktreePath, runId, ownerId, leaseExpiresAt, now });
        if (inserted.changes > 0) {
          return { outcome: "claimed", claimKind: "new", lease: this.get(worktreePath)! };
        }
      }

      const current = existing ?? this.get(worktreePath);
      if (!current) {
        throw new Error("Orchestration worktree lease disappeared during acquisition.");
      }
      if (isLeaseActive(current, Date.parse(now))) {
        if (current.runId !== runId || current.ownerId !== ownerId) {
          return { outcome: "blocked", lease: current };
        }
        const renewed = this.renewStmt.run({
          worktreePath,
          runId,
          ownerId,
          generation: current.generation,
          leaseExpiresAt,
          now,
        });
        const lease = this.get(worktreePath) ?? current;
        return renewed.changes > 0
          ? { outcome: "claimed", claimKind: "renewed", lease }
          : { outcome: "blocked", lease };
      }

      const reclaimed = this.reclaimStmt.run({
        worktreePath,
        runId,
        ownerId,
        generation: current.generation + 1,
        leaseExpiresAt,
        now,
        expectedRunId: current.runId,
        expectedOwnerId: current.ownerId,
        expectedGeneration: current.generation,
        expectedLeaseExpiresAt: current.leaseExpiresAt,
        expectedReleasedAt: current.releasedAt ?? null,
        expectedUpdatedAt: current.updatedAt,
      });
      if (reclaimed.changes > 0) {
        return { outcome: "claimed", claimKind: "reclaimed", lease: this.get(worktreePath)! };
      }
      return { outcome: "blocked", lease: this.get(worktreePath) ?? current };
    });
  }

  public renew(
    input: OrchestrationWorktreeLeaseToken & { leaseDurationMs: number; now?: string },
  ): OrchestrationWorktreeLeaseRecord | undefined {
    const token = normalizeToken(input);
    const leaseDurationMs = normalizeLeaseDurationMs(input.leaseDurationMs);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "lease renewal time");
    const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
    const renewed = this.renewStmt.run({ ...token, leaseExpiresAt, now });
    if (renewed.changes > 0) {
      return this.get(token.worktreePath);
    }
    return undefined;
  }

  public release(input: OrchestrationWorktreeLeaseToken & { releasedAt?: string }): boolean {
    const token = normalizeToken(input);
    const releasedAt = normalizeTimestamp(input.releasedAt ?? this.readDatabaseNow(), "lease release time");
    const released = this.releaseStmt.run({ ...token, releasedAt });
    if (released.changes > 0) {
      return true;
    }
    const current = this.get(token.worktreePath);
    return Boolean(
      current?.releasedAt &&
      current.runId === token.runId &&
      current.ownerId === token.ownerId &&
      current.generation === token.generation,
    );
  }

  private readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (!row || typeof row.now_iso !== "string") {
      throw new Error("Database did not return an orchestration worktree lease timestamp.");
    }
    return row.now_iso;
  }
}

function mapRow(row: OrchestrationWorktreeLeaseRow): OrchestrationWorktreeLeaseRecord {
  return {
    worktreePath: row.worktree_path,
    runId: row.run_id,
    ownerId: row.owner_id,
    generation: Number(row.generation),
    leaseExpiresAt: row.lease_expires_at,
    releasedAt: row.released_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeToken(input: OrchestrationWorktreeLeaseToken): OrchestrationWorktreeLeaseToken {
  const generation = Number(input.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Orchestration worktree lease generation must be a positive safe integer.");
  }
  return {
    worktreePath: normalizeRequiredString(input.worktreePath, "worktree path"),
    runId: normalizeRequiredString(input.runId, "run id"),
    ownerId: normalizeRequiredString(input.ownerId, "owner id"),
    generation,
  };
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Orchestration worktree ${label} is required.`);
  }
  return normalized;
}

function normalizeLeaseDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Orchestration worktree lease duration must be a positive number of milliseconds.");
  }
  return Math.floor(value);
}

function normalizeTimestamp(value: string, label: string): string {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`Orchestration worktree ${label} must be a valid timestamp.`);
  }
  return new Date(timestampMs).toISOString();
}

function isLeaseActive(record: OrchestrationWorktreeLeaseRecord, nowMs: number): boolean {
  if (record.releasedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(record.leaseExpiresAt);
  // Malformed durable state must fail closed instead of authorizing cleanup.
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}
