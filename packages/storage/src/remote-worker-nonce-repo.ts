import { normalizeRemoteWorkerNonceAuthority, type RemoteWorkerNonceAuthority } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";

/**
 * HX-501B1 durable remote-worker request-nonce consumption owner. Replaces the
 * single-process replay cache with a durable, authority-scoped, hash-only
 * store. Only the nonce digest, canonical request timestamp, and expiry cross
 * this port alongside the strict discriminated authority; the raw nonce,
 * authorization credential, TLS exporter, certificate, public key, request
 * body, and proof never reach storage.
 *
 * Consumption is fail-closed: an exact duplicate under one authority returns
 * `false`; every other failure (stale/rotated/quarantined/revoked/expired
 * authority, an out-of-window request timestamp, a malformed digest, or a
 * missing parent) throws. The database independently enforces the plus/minus
 * 60-second request window against its own clock, the exact 60-second expiry,
 * authority currency, live-row immutability, and delete-only-after-expiry.
 *
 * Pruning is deterministic and bounded: a consume removes at most 128 expired
 * rows per table, explicit maintenance at most 1,000 per table, both in a
 * stable order by expiry then identity, and never a live row.
 */
export interface RemoteWorkerNonceConsumeInput {
  readonly authority: RemoteWorkerNonceAuthority;
  readonly nonceSha256: string;
  readonly timestamp: string;
  readonly expiresAt: string;
}

export interface RemoteWorkerNoncePruneResult {
  readonly bootstrap: number;
  readonly credential: number;
}

const NONCE_TTL_MS = 60_000;
const CONSUME_PRUNE_LIMIT = 128;
const MAINTENANCE_PRUNE_LIMIT = 1_000;

export class RemoteWorkerNonceRepository {
  private readonly nowSql: string;
  private readonly bootstrapExistsStmt: DbStatement;
  private readonly bootstrapInsertStmt: DbStatement;
  private readonly bootstrapPruneStmt: DbStatement;
  private readonly credentialExistsStmt: DbStatement;
  private readonly credentialInsertStmt: DbStatement;
  private readonly credentialPruneStmt: DbStatement;

  public constructor(private readonly db: DatabaseClient) {
    this.nowSql =
      db.dialect === "postgres"
        ? `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

    this.bootstrapExistsStmt = db.prepare(`
      SELECT 1 FROM remote_worker_bootstrap_request_nonces
      WHERE registry_workspace_id = @registryWorkspaceId
        AND worker_id = @workerId
        AND target_worker_generation = @targetWorkerGeneration
        AND bootstrap_id = @bootstrapId
        AND nonce_sha256 = @nonceSha256
    `);
    this.bootstrapInsertStmt = db.prepare(`
      INSERT INTO remote_worker_bootstrap_request_nonces (
        registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256,
        request_timestamp, consumed_at, expires_at
      ) VALUES (
        @registryWorkspaceId, @workerId, @targetWorkerGeneration, @bootstrapId, @nonceSha256,
        @timestamp, ${this.nowSql}, @expiresAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.bootstrapPruneStmt = db.prepare(`
      DELETE FROM remote_worker_bootstrap_request_nonces
      WHERE (registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256) IN (
        SELECT registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256
        FROM remote_worker_bootstrap_request_nonces
        WHERE expires_at <= ${this.nowSql}
        ORDER BY expires_at ASC, registry_workspace_id ASC, worker_id ASC,
                 target_worker_generation ASC, bootstrap_id ASC, nonce_sha256 ASC
        LIMIT @limit
      )
    `);

    this.credentialExistsStmt = db.prepare(`
      SELECT 1 FROM remote_worker_credential_request_nonces
      WHERE registry_workspace_id = @registryWorkspaceId
        AND worker_id = @workerId
        AND worker_generation = @workerGeneration
        AND credential_generation = @credentialGeneration
        AND credential_id = @credentialId
        AND nonce_sha256 = @nonceSha256
    `);
    this.credentialInsertStmt = db.prepare(`
      INSERT INTO remote_worker_credential_request_nonces (
        registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id, nonce_sha256,
        request_timestamp, consumed_at, expires_at
      ) VALUES (
        @registryWorkspaceId, @workerId, @workerGeneration, @credentialGeneration, @credentialId, @nonceSha256,
        @timestamp, ${this.nowSql}, @expiresAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.credentialPruneStmt = db.prepare(`
      DELETE FROM remote_worker_credential_request_nonces
      WHERE (registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id, nonce_sha256) IN (
        SELECT registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id, nonce_sha256
        FROM remote_worker_credential_request_nonces
        WHERE expires_at <= ${this.nowSql}
        ORDER BY expires_at ASC, registry_workspace_id ASC, worker_id ASC,
                 worker_generation ASC, credential_generation ASC, credential_id ASC, nonce_sha256 ASC
        LIMIT @limit
      )
    `);
  }

  /**
   * Consume a request nonce under its exact authority. Returns `true` when the
   * nonce is newly recorded and `false` for an exact duplicate under the same
   * authority; throws fail-closed on every other rejection.
   */
  public consume(input: RemoteWorkerNonceConsumeInput): boolean {
    const authority = normalizeRemoteWorkerNonceAuthority(input.authority);
    const nonceSha256 = assertNonceDigest(input.nonceSha256);
    const timestamp = assertCanonicalTimestamp(input.timestamp, "request timestamp");
    const expiresAt = assertCanonicalTimestamp(input.expiresAt, "expiry");
    if (Date.parse(expiresAt) - Date.parse(timestamp) !== NONCE_TTL_MS) {
      throw new TypeError("Remote worker request-nonce expiry must be exactly the request timestamp plus 60 seconds.");
    }
    return this.db.transaction("immediate", () =>
      authority.kind === "bootstrap"
        ? this.consumeBootstrap(authority, nonceSha256, timestamp, expiresAt)
        : this.consumeCredential(authority, nonceSha256, timestamp, expiresAt),
    );
  }

  /**
   * Explicit bounded maintenance: remove up to `limit` (capped at 1,000)
   * database-clock-expired rows per table in a stable order. Never deletes a
   * live row. Returns the per-table deletion counts.
   */
  public pruneExpired(limit: number = MAINTENANCE_PRUNE_LIMIT): RemoteWorkerNoncePruneResult {
    const bounded = boundPruneLimit(limit, MAINTENANCE_PRUNE_LIMIT);
    return this.db.transaction("immediate", () => ({
      bootstrap: this.bootstrapPruneStmt.run({ limit: bounded }).changes,
      credential: this.credentialPruneStmt.run({ limit: bounded }).changes,
    }));
  }

  private consumeBootstrap(
    authority: Extract<RemoteWorkerNonceAuthority, { kind: "bootstrap" }>,
    nonceSha256: string,
    timestamp: string,
    expiresAt: string,
  ): boolean {
    const key = {
      registryWorkspaceId: authority.registryWorkspaceId,
      workerId: authority.workerId,
      targetWorkerGeneration: authority.targetWorkerGeneration,
      bootstrapId: authority.bootstrapId,
      nonceSha256,
    };
    if (this.bootstrapExistsStmt.get(key) !== undefined) return false;
    this.bootstrapPruneStmt.run({ limit: CONSUME_PRUNE_LIMIT });
    const inserted = this.bootstrapInsertStmt.run({ ...key, timestamp, expiresAt }).changes;
    if (inserted === 1) return true;
    if (this.bootstrapExistsStmt.get(key) !== undefined) return false;
    throw new Error("Remote worker bootstrap request-nonce consumption did not persist.");
  }

  private consumeCredential(
    authority: Extract<RemoteWorkerNonceAuthority, { kind: "credential" }>,
    nonceSha256: string,
    timestamp: string,
    expiresAt: string,
  ): boolean {
    const key = {
      registryWorkspaceId: authority.registryWorkspaceId,
      workerId: authority.workerId,
      workerGeneration: authority.workerGeneration,
      credentialGeneration: authority.credentialGeneration,
      credentialId: authority.credentialId,
      nonceSha256,
    };
    if (this.credentialExistsStmt.get(key) !== undefined) return false;
    this.credentialPruneStmt.run({ limit: CONSUME_PRUNE_LIMIT });
    const inserted = this.credentialInsertStmt.run({ ...key, timestamp, expiresAt }).changes;
    if (inserted === 1) return true;
    if (this.credentialExistsStmt.get(key) !== undefined) return false;
    throw new Error("Remote worker credential request-nonce consumption did not persist.");
  }
}

function assertNonceDigest(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("Remote worker request-nonce digest must be a lower-case SHA-256 hex string.");
  }
  return value;
}

function assertCanonicalTimestamp(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`Remote worker request-nonce ${label} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function boundPruneLimit(limit: number, maximum: number): number {
  if (!Number.isFinite(limit)) return maximum;
  return Math.max(0, Math.min(Math.trunc(limit), maximum));
}
