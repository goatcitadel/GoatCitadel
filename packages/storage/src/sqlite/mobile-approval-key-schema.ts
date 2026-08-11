import type { DatabaseSync } from "node:sqlite";

/** SQLite 197, paired with PostgreSQL 141. */
export function createMobileApprovalKeySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE mobile_approval_keys (
      key_id TEXT PRIMARY KEY CHECK(length(TRIM(key_id)) BETWEEN 1 AND 128),
      grant_id TEXT NOT NULL REFERENCES auth_device_grants(grant_id) ON DELETE RESTRICT
        CHECK(length(TRIM(grant_id)) BETWEEN 1 AND 256),
      algorithm TEXT NOT NULL CHECK(algorithm = 'ed25519'),
      public_key_pem TEXT NOT NULL CHECK(
        length(TRIM(public_key_pem)) BETWEEN 1 AND 512
        AND public_key_pem GLOB '-----BEGIN PUBLIC KEY-----*-----END PUBLIC KEY-----*'
      ),
      public_key_sha256 TEXT NOT NULL CHECK(
        length(public_key_sha256) = 64 AND public_key_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      key_provenance TEXT NOT NULL CHECK(key_provenance IN ('secure_hardware', 'software', 'unknown')),
      lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'revoked')),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
      companion_session_id TEXT CHECK(
        companion_session_id IS NULL OR length(TRIM(companion_session_id)) BETWEEN 1 AND 256
      ),
      device_label TEXT CHECK(device_label IS NULL OR length(TRIM(device_label)) BETWEEN 1 AND 160),
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(grant_id),
      UNIQUE(public_key_sha256),
      CHECK(
        (lifecycle_state = 'active' AND revoked_at IS NULL)
        OR (lifecycle_state = 'revoked' AND revoked_at IS NOT NULL)
      )
    );

    CREATE INDEX idx_mobile_approval_keys_grant_state
      ON mobile_approval_keys(grant_id, lifecycle_state, updated_at, key_id);
    CREATE INDEX idx_mobile_approval_keys_state_updated
      ON mobile_approval_keys(lifecycle_state, updated_at, key_id);
  `);
}
