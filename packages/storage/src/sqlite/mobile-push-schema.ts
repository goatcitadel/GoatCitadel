import type { DatabaseSync } from "node:sqlite";

/** SQLite 195, paired with PostgreSQL 138. */
export function createMobilePushSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE mobile_push_registrations (
      registration_id TEXT PRIMARY KEY CHECK(length(TRIM(registration_id)) BETWEEN 1 AND 128),
      grant_id TEXT NOT NULL REFERENCES auth_device_grants(grant_id) ON DELETE RESTRICT
        CHECK(length(TRIM(grant_id)) BETWEEN 1 AND 256),
      provider TEXT NOT NULL CHECK(provider IN ('expo', 'fcm')),
      token_secret_ref TEXT NOT NULL CHECK(
        length(TRIM(token_secret_ref)) BETWEEN 1 AND 512
        AND token_secret_ref GLOB 'keychain:goatcitadel:mobile-push:*'
      ),
      token_sha256 TEXT CHECK(
        token_sha256 IS NULL OR (
          length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'revoked')),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
      companion_session_id TEXT CHECK(
        companion_session_id IS NULL OR length(TRIM(companion_session_id)) BETWEEN 1 AND 256
      ),
      device_label TEXT CHECK(device_label IS NULL OR length(TRIM(device_label)) BETWEEN 1 AND 160),
      app_version TEXT CHECK(app_version IS NULL OR length(TRIM(app_version)) BETWEEN 1 AND 80),
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
      delivery_id TEXT PRIMARY KEY CHECK(length(TRIM(delivery_id)) BETWEEN 1 AND 128),
      registration_id TEXT NOT NULL REFERENCES mobile_push_registrations(registration_id) ON DELETE RESTRICT,
      source_realtime_event_id TEXT NOT NULL
        CHECK(length(TRIM(source_realtime_event_id)) BETWEEN 1 AND 256),
      approval_id TEXT NOT NULL CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
      event_kind TEXT NOT NULL CHECK(event_kind = 'approval_refresh'),
      payload_json TEXT NOT NULL CHECK(
        length(payload_json) BETWEEN 2 AND 2048
        AND json_valid(payload_json)
        AND json_type(payload_json) = 'object'
      ),
      payload_sha256 TEXT NOT NULL CHECK(
        length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'retry_scheduled', 'delivered', 'invalid_token',
        'unknown_after_send', 'dead_lettered', 'custody_blocked', 'cancelled_revoked'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK(typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 20),
      max_attempts INTEGER NOT NULL DEFAULT 5
        CHECK(typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 20),
      next_attempt_at TEXT,
      claimed_by TEXT CHECK(claimed_by IS NULL OR length(TRIM(claimed_by)) BETWEEN 1 AND 256),
      claimed_at TEXT,
      lease_expires_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version >= 1),
      last_classification TEXT CHECK(last_classification IS NULL OR last_classification IN (
        'delivered', 'invalid_token', 'retryable', 'unknown_after_send', 'provider_unavailable',
        'custody_unavailable', 'grant_validation_unavailable', 'custody_mismatch', 'registration_revoked'
      )),
      provider_receipt_sha256 TEXT CHECK(
        provider_receipt_sha256 IS NULL OR (
          length(provider_receipt_sha256) = 64
          AND provider_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
        )
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
  `);
}
