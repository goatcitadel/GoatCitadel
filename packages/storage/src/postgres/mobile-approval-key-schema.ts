/** PostgreSQL 141, paired with SQLite 197. */
export const MOBILE_APPROVAL_KEY_POSTGRES_SCHEMA_SQL = `
  CREATE TABLE mobile_approval_keys (
    key_id TEXT PRIMARY KEY CHECK(octet_length(TRIM(key_id)) BETWEEN 1 AND 128),
    grant_id TEXT NOT NULL REFERENCES auth_device_grants(grant_id) ON DELETE RESTRICT
      CHECK(octet_length(TRIM(grant_id)) BETWEEN 1 AND 256),
    algorithm TEXT NOT NULL CHECK(algorithm = 'ed25519'),
    public_key_pem TEXT NOT NULL CHECK(
      octet_length(TRIM(public_key_pem)) BETWEEN 1 AND 512
      AND public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%-----END PUBLIC KEY-----%'
    ),
    public_key_sha256 TEXT NOT NULL CHECK(public_key_sha256 ~ '^[0-9a-f]{64}$'),
    key_provenance TEXT NOT NULL CHECK(key_provenance IN ('secure_hardware', 'software', 'unknown')),
    lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'revoked')),
    revision BIGINT NOT NULL CHECK(revision >= 1),
    companion_session_id TEXT CHECK(
      companion_session_id IS NULL OR octet_length(TRIM(companion_session_id)) BETWEEN 1 AND 256
    ),
    device_label TEXT CHECK(device_label IS NULL OR octet_length(TRIM(device_label)) BETWEEN 1 AND 160),
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
`;
