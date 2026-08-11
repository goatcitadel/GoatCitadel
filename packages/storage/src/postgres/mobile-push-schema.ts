/** PostgreSQL 138, paired with SQLite 195. */
export const MOBILE_PUSH_POSTGRES_SCHEMA_SQL = `
  CREATE TABLE mobile_push_registrations (
    registration_id TEXT PRIMARY KEY CHECK(octet_length(TRIM(registration_id)) BETWEEN 1 AND 128),
    grant_id TEXT NOT NULL REFERENCES auth_device_grants(grant_id) ON DELETE RESTRICT
      CHECK(octet_length(TRIM(grant_id)) BETWEEN 1 AND 256),
    provider TEXT NOT NULL CHECK(provider IN ('expo', 'fcm')),
    token_secret_ref TEXT NOT NULL CHECK(
      octet_length(TRIM(token_secret_ref)) BETWEEN 1 AND 512
      AND token_secret_ref LIKE 'keychain:goatcitadel:mobile-push:%'
    ),
    token_sha256 TEXT CHECK(token_sha256 IS NULL OR token_sha256 ~ '^[0-9a-f]{64}$'),
    lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'revoked')),
    revision BIGINT NOT NULL CHECK(revision >= 1),
    companion_session_id TEXT CHECK(
      companion_session_id IS NULL OR octet_length(TRIM(companion_session_id)) BETWEEN 1 AND 256
    ),
    device_label TEXT CHECK(device_label IS NULL OR octet_length(TRIM(device_label)) BETWEEN 1 AND 160),
    app_version TEXT CHECK(app_version IS NULL OR octet_length(TRIM(app_version)) BETWEEN 1 AND 80),
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(grant_id, provider),
    CHECK(
      (lifecycle_state = 'active' AND token_sha256 IS NOT NULL AND revoked_at IS NULL)
      OR (lifecycle_state = 'revoked' AND revoked_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_mobile_push_registrations_grant_state
    ON mobile_push_registrations(grant_id, lifecycle_state, updated_at, registration_id);
  CREATE INDEX idx_mobile_push_registrations_state_provider
    ON mobile_push_registrations(lifecycle_state, provider, updated_at, registration_id);

  CREATE TABLE mobile_push_deliveries (
    delivery_id TEXT PRIMARY KEY CHECK(octet_length(TRIM(delivery_id)) BETWEEN 1 AND 128),
    registration_id TEXT NOT NULL REFERENCES mobile_push_registrations(registration_id) ON DELETE RESTRICT,
    source_realtime_event_id TEXT NOT NULL
      CHECK(octet_length(TRIM(source_realtime_event_id)) BETWEEN 1 AND 256),
    approval_id TEXT NOT NULL CHECK(octet_length(TRIM(approval_id)) BETWEEN 1 AND 256),
    event_kind TEXT NOT NULL CHECK(event_kind = 'approval_refresh'),
    payload_json TEXT NOT NULL CHECK(
      octet_length(payload_json) BETWEEN 2 AND 2048
      AND jsonb_typeof(payload_json::jsonb) = 'object'
    ),
    payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'running', 'retry_scheduled', 'delivered', 'invalid_token',
      'unknown_after_send', 'dead_lettered', 'custody_blocked', 'cancelled_revoked'
    )),
    attempt_count BIGINT NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 20),
    max_attempts BIGINT NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
    next_attempt_at TEXT,
    claimed_by TEXT CHECK(claimed_by IS NULL OR octet_length(TRIM(claimed_by)) BETWEEN 1 AND 256),
    claimed_at TEXT,
    lease_expires_at TEXT,
    version BIGINT NOT NULL DEFAULT 1 CHECK(version >= 1),
    last_classification TEXT CHECK(last_classification IS NULL OR last_classification IN (
      'delivered', 'invalid_token', 'retryable', 'unknown_after_send', 'provider_unavailable',
      'custody_unavailable', 'grant_validation_unavailable', 'custody_mismatch', 'registration_revoked'
    )),
    provider_receipt_sha256 TEXT CHECK(
      provider_receipt_sha256 IS NULL OR provider_receipt_sha256 ~ '^[0-9a-f]{64}$'
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(registration_id, approval_id, event_kind),
    CHECK(
      (status = 'running' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK(
      (status IN ('delivered', 'invalid_token', 'unknown_after_send', 'dead_lettered', 'custody_blocked', 'cancelled_revoked')
        AND completed_at IS NOT NULL)
      OR (status IN ('queued', 'running', 'retry_scheduled') AND completed_at IS NULL)
    )
  );

  CREATE INDEX idx_mobile_push_deliveries_due
    ON mobile_push_deliveries(status, next_attempt_at, created_at, delivery_id);
  CREATE INDEX idx_mobile_push_deliveries_registration_created
    ON mobile_push_deliveries(registration_id, created_at, delivery_id);
  CREATE INDEX idx_mobile_push_deliveries_source_event
    ON mobile_push_deliveries(source_realtime_event_id, event_kind, created_at, delivery_id);
  CREATE INDEX idx_mobile_push_deliveries_approval
    ON mobile_push_deliveries(approval_id, event_kind, created_at, delivery_id);
`;
