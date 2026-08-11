import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { buildActiveGrantExpiryPredicate } from "./active-grant-predicate.js";
import type { DatabaseClient } from "./db.js";

export type MobileApprovalKeyLifecycle = "active" | "revoked";
export type MobileApprovalKeyProvenance = "secure_hardware" | "software" | "unknown";

export interface MobileApprovalKeyRecord {
  keyId: string;
  grantId: string;
  algorithm: "ed25519";
  publicKeyPem: string;
  publicKeySha256: string;
  keyProvenance: MobileApprovalKeyProvenance;
  lifecycleState: MobileApprovalKeyLifecycle;
  revision: number;
  companionSessionId?: string;
  deviceLabel?: string;
  registeredAt: string;
  updatedAt: string;
  revokedAt?: string;
}

interface MobileApprovalKeyRow {
  key_id: string;
  grant_id: string;
  algorithm: string;
  public_key_pem: string;
  public_key_sha256: string;
  key_provenance: string;
  lifecycle_state: string;
  revision: number;
  companion_session_id: string | null;
  device_label: string | null;
  registered_at: string;
  updated_at: string;
  revoked_at: string | null;
}

/**
 * Durable owner for the Gateway-verifiable consumer approval key: one Ed25519
 * device public key per durable companion grant. Registration is fenced on the
 * active grant row; revocation is idempotent and keeps the public material for
 * operator forensics. The `approval_key` capability stays `scaffolded` until
 * the mobile client ships its side; this owner only makes the server side
 * verifiable.
 */
export class MobileApprovalKeyRepository {
  private readonly getByGrantStmt;
  private readonly getByIdStmt;
  private readonly listStmt;
  private readonly getActiveGrantForUpdateStmt;
  private readonly upsertActiveKeyStmt;
  private readonly ensureRevokedKeyStmt;

  public constructor(private readonly db: DatabaseClient) {
    const distinct = (left: string, right: string) =>
      db.dialect === "postgres" ? `${left} IS DISTINCT FROM ${right}` : `${left} IS NOT ${right}`;
    const keyChanged = [
      distinct("mobile_approval_keys.public_key_pem", "excluded.public_key_pem"),
      distinct("mobile_approval_keys.public_key_sha256", "excluded.public_key_sha256"),
      distinct("mobile_approval_keys.key_provenance", "excluded.key_provenance"),
      "mobile_approval_keys.lifecycle_state <> 'active'",
      distinct("mobile_approval_keys.companion_session_id", "excluded.companion_session_id"),
      distinct("mobile_approval_keys.device_label", "excluded.device_label"),
    ].join(" OR ");
    // UPDATE SET expressions read the pre-update row in both dialects, so the
    // active->revoked transition predicate stays consistent across columns.
    const revokeTransition = "mobile_approval_keys.lifecycle_state <> 'revoked'";

    this.getByGrantStmt = db.prepare(`
      SELECT * FROM mobile_approval_keys
      WHERE grant_id = @grantId
      LIMIT 1
    `);
    this.getByIdStmt = db.prepare(`
      SELECT * FROM mobile_approval_keys
      WHERE key_id = @keyId
      LIMIT 1
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM mobile_approval_keys
      ORDER BY registered_at ASC, key_id ASC
      LIMIT @limit
    `);
    this.getActiveGrantForUpdateStmt = db.prepare(`
      SELECT grant_id
      FROM auth_device_grants
      WHERE grant_id = @grantId
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR ${buildActiveGrantExpiryPredicate(db.dialect, "expires_at")})
      LIMIT 1${db.dialect === "postgres" ? " FOR UPDATE" : ""}
    `);
    this.upsertActiveKeyStmt = db.prepare(`
      INSERT INTO mobile_approval_keys (
        key_id, grant_id, algorithm, public_key_pem, public_key_sha256, key_provenance,
        lifecycle_state, revision, companion_session_id, device_label, registered_at, updated_at, revoked_at
      ) VALUES (
        @keyId, @grantId, 'ed25519', @publicKeyPem, @publicKeySha256, @keyProvenance,
        'active', 1, @companionSessionId, @deviceLabel, @registeredAt, @updatedAt, NULL
      )
      ON CONFLICT(grant_id) DO UPDATE SET
        public_key_pem = excluded.public_key_pem,
        public_key_sha256 = excluded.public_key_sha256,
        key_provenance = excluded.key_provenance,
        lifecycle_state = 'active',
        revision = CASE WHEN ${keyChanged}
          THEN mobile_approval_keys.revision + 1
          ELSE mobile_approval_keys.revision END,
        companion_session_id = excluded.companion_session_id,
        device_label = excluded.device_label,
        updated_at = CASE WHEN ${keyChanged}
          THEN excluded.updated_at ELSE mobile_approval_keys.updated_at END,
        revoked_at = NULL
    `);
    this.ensureRevokedKeyStmt = db.prepare(`
      UPDATE mobile_approval_keys
      SET lifecycle_state = 'revoked',
          revision = CASE WHEN ${revokeTransition}
            THEN mobile_approval_keys.revision + 1
            ELSE mobile_approval_keys.revision END,
          companion_session_id = CASE WHEN ${revokeTransition}
            THEN @companionSessionId ELSE mobile_approval_keys.companion_session_id END,
          updated_at = CASE WHEN ${revokeTransition}
            THEN @revokedAt ELSE mobile_approval_keys.updated_at END,
          revoked_at = CASE WHEN ${revokeTransition}
            THEN @revokedAt ELSE mobile_approval_keys.revoked_at END
      WHERE grant_id = @grantId
    `);
  }

  public getByGrant(grantId: string): MobileApprovalKeyRecord | undefined {
    const row = this.getByGrantStmt.get({ grantId });
    return row ? mapApprovalKey(row as MobileApprovalKeyRow) : undefined;
  }

  public getById(keyId: string): MobileApprovalKeyRecord | undefined {
    const row = this.getByIdStmt.get({ keyId });
    return row ? mapApprovalKey(row as MobileApprovalKeyRow) : undefined;
  }

  public list(limit = 200): MobileApprovalKeyRecord[] {
    return (this.listStmt.all({ limit: clampLimit(limit, 500) }) as MobileApprovalKeyRow[]).map(mapApprovalKey);
  }

  /** Returns the active key for signature verification, or undefined when absent/revoked. */
  public getActiveByGrant(grantId: string): MobileApprovalKeyRecord | undefined {
    const record = this.getByGrant(grantId);
    return record?.lifecycleState === "active" ? record : undefined;
  }

  public upsertActiveKey(input: {
    keyId: string;
    grantId: string;
    publicKeyPem: string;
    publicKeySha256: string;
    keyProvenance: MobileApprovalKeyProvenance;
    companionSessionId?: string;
    deviceLabel?: string;
    now?: string;
  }): MobileApprovalKeyRecord {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const activeGrant = this.getActiveGrantForUpdateStmt.get({ grantId: input.grantId });
      if (!activeGrant) {
        throw new ValidationError({ message: "An active durable device grant is required for a mobile approval key." });
      }
      this.upsertActiveKeyStmt.run({
        keyId: input.keyId,
        grantId: input.grantId,
        publicKeyPem: input.publicKeyPem,
        publicKeySha256: input.publicKeySha256,
        keyProvenance: input.keyProvenance,
        companionSessionId: input.companionSessionId ?? null,
        deviceLabel: input.deviceLabel ?? null,
        registeredAt: now,
        updatedAt: now,
      });
      return this.requireByGrant(input.grantId);
    });
  }

  /** Idempotent revoke; a grant without a registered key is a no-op returning undefined. */
  public ensureRevoked(input: {
    grantId: string;
    companionSessionId?: string;
    now?: string;
  }): MobileApprovalKeyRecord | undefined {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      this.ensureRevokedKeyStmt.run({
        grantId: input.grantId,
        companionSessionId: input.companionSessionId ?? null,
        revokedAt: now,
      });
      return this.getByGrant(input.grantId);
    });
  }

  public revokeAllByGrant(grantId: string, now = new Date().toISOString()): MobileApprovalKeyRecord[] {
    const revoked = this.ensureRevoked({ grantId, now });
    return revoked ? [revoked] : [];
  }

  private requireByGrant(grantId: string): MobileApprovalKeyRecord {
    const record = this.getByGrant(grantId);
    if (!record) {
      throw new NotFoundError({ entity: "mobile approval key", id: grantId });
    }
    return record;
  }
}

export function deriveMobileApprovalKeyId(grantId: string): string {
  return `mak_${sha256(`grant:${grantId.trim()}\nalgorithm:ed25519`).slice(0, 40)}`;
}

function mapApprovalKey(row: MobileApprovalKeyRow): MobileApprovalKeyRecord {
  if (
    row.algorithm !== "ed25519" ||
    !isApprovalKeyLifecycle(row.lifecycle_state) ||
    !isApprovalKeyProvenance(row.key_provenance)
  ) {
    throw new ValidationError({ message: "Stored mobile approval key is invalid." });
  }
  return {
    keyId: row.key_id,
    grantId: row.grant_id,
    algorithm: "ed25519",
    publicKeyPem: row.public_key_pem,
    publicKeySha256: row.public_key_sha256,
    keyProvenance: row.key_provenance,
    lifecycleState: row.lifecycle_state,
    revision: Number(row.revision),
    companionSessionId: row.companion_session_id ?? undefined,
    deviceLabel: row.device_label ?? undefined,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function isApprovalKeyLifecycle(value: string): value is MobileApprovalKeyLifecycle {
  return value === "active" || value === "revoked";
}

function isApprovalKeyProvenance(value: string): value is MobileApprovalKeyProvenance {
  return value === "secure_hardware" || value === "software" || value === "unknown";
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
