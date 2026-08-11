/** PostgreSQL 137: immutable remote-worker -> HX-408 mesh-node authority lineage. */
export const REMOTE_WORKER_MESH_NODE_ADMISSION_POSTGRES_SQL = `
  ALTER TABLE mesh_capability_node_admissions
    ADD COLUMN provenance_kind TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE mesh_capability_node_admissions
    ADD CONSTRAINT mesh_capability_node_admissions_provenance_kind_check
    CHECK(provenance_kind IN ('legacy', 'remote_worker'));

  CREATE TABLE IF NOT EXISTS remote_worker_mesh_join_authorities (
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
    credential_generation BIGINT NOT NULL CHECK(credential_generation > 0),
    runtime_credential_token_sha256 TEXT NOT NULL CHECK(runtime_credential_token_sha256 ~ '^[0-9a-f]{64}$'),
    protected_evidence_envelope_sha256 TEXT NOT NULL CHECK(protected_evidence_envelope_sha256 ~ '^[0-9a-f]{64}$'),
    protected_evidence_context_sha256 TEXT NOT NULL CHECK(protected_evidence_context_sha256 ~ '^[0-9a-f]{64}$'),
    node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
    workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    join_authority_generation BIGINT NOT NULL CHECK(join_authority_generation > 0),
    target_admission_generation BIGINT NOT NULL CHECK(target_admission_generation > 0),
    join_credential_sha256 TEXT NOT NULL CHECK(join_credential_sha256 ~ '^[0-9a-f]{64}$'),
    client_certificate_sha256 TEXT NOT NULL CHECK(client_certificate_sha256 ~ '^[0-9a-f]{64}$'),
    issued_by_actor_id TEXT NOT NULL CHECK(length(issued_by_actor_id) BETWEEN 1 AND 256),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    issued_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(issued_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(issued_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = issued_at
    ),
    expires_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(expires_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = expires_at
      AND gc_try_parse_timestamptz(expires_at) > gc_try_parse_timestamptz(issued_at)
      AND EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(expires_at) - gc_try_parse_timestamptz(issued_at))) <= 600
    ),
    PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation),
    UNIQUE(registry_workspace_id, idempotency_key),
    UNIQUE(join_credential_sha256),
    UNIQUE(workspace_id, node_id, target_admission_generation),
    FOREIGN KEY(registry_workspace_id, bootstrap_id)
      REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
      REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id)
      REFERENCES remote_worker_runtime_credentials(
        registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id
      ) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
      REFERENCES remote_worker_protected_admission_evidence(
        registry_workspace_id, worker_id, worker_generation
      ) ON DELETE RESTRICT,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
    FOREIGN KEY(join_credential_sha256) REFERENCES mesh_join_tokens(token_hash) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS remote_worker_mesh_join_authority_revocations (
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    join_authority_generation BIGINT NOT NULL CHECK(join_authority_generation > 0),
    reason_code TEXT NOT NULL CHECK(reason_code ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
    reason_sha256 TEXT NOT NULL CHECK(reason_sha256 ~ '^[0-9a-f]{64}$'),
    revoked_by_actor_id TEXT NOT NULL CHECK(length(revoked_by_actor_id) BETWEEN 1 AND 256),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    revoked_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(revoked_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(revoked_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = revoked_at
    ),
    PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation),
    UNIQUE(registry_workspace_id, idempotency_key),
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation)
      REFERENCES remote_worker_mesh_join_authorities(
        registry_workspace_id, worker_id, worker_generation, join_authority_generation
      ) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS remote_worker_mesh_node_bindings (
    workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
    admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
    provenance_kind TEXT NOT NULL CHECK(provenance_kind = 'remote_worker'),
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
    credential_generation BIGINT NOT NULL CHECK(credential_generation > 0),
    runtime_credential_token_sha256 TEXT NOT NULL CHECK(runtime_credential_token_sha256 ~ '^[0-9a-f]{64}$'),
    protected_evidence_envelope_sha256 TEXT NOT NULL CHECK(protected_evidence_envelope_sha256 ~ '^[0-9a-f]{64}$'),
    protected_evidence_context_sha256 TEXT NOT NULL CHECK(protected_evidence_context_sha256 ~ '^[0-9a-f]{64}$'),
    join_authority_generation BIGINT NOT NULL CHECK(join_authority_generation > 0),
    join_credential_sha256 TEXT NOT NULL CHECK(join_credential_sha256 ~ '^[0-9a-f]{64}$'),
    client_certificate_sha256 TEXT NOT NULL CHECK(client_certificate_sha256 ~ '^[0-9a-f]{64}$'),
    stable_effect_sha256 TEXT NOT NULL CHECK(stable_effect_sha256 ~ '^[0-9a-f]{64}$'),
    admitted_by_actor_id TEXT NOT NULL CHECK(length(admitted_by_actor_id) BETWEEN 1 AND 256),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
    bound_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(bound_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(bound_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = bound_at
    ),
    PRIMARY KEY(workspace_id, node_id, admission_generation),
    UNIQUE(registry_workspace_id, worker_id, worker_generation, join_authority_generation),
    UNIQUE(join_credential_sha256),
    UNIQUE(workspace_id, idempotency_key),
    FOREIGN KEY(workspace_id, node_id, admission_generation)
      REFERENCES mesh_capability_node_admissions(workspace_id, node_id, admission_generation) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation)
      REFERENCES remote_worker_mesh_join_authorities(
        registry_workspace_id, worker_id, worker_generation, join_authority_generation
      ) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS remote_worker_mesh_node_admission_attempts (
    attempt_sha256 TEXT PRIMARY KEY CHECK(attempt_sha256 ~ '^[0-9a-f]{64}$'),
    stable_effect_sha256 TEXT NOT NULL CHECK(stable_effect_sha256 ~ '^[0-9a-f]{64}$'),
    outcome TEXT NOT NULL CHECK(outcome IN ('admitted', 'replayed')),
    workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
    node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
    admission_generation BIGINT NOT NULL CHECK(admission_generation > 0),
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
    credential_generation BIGINT NOT NULL CHECK(credential_generation > 0),
    join_authority_generation BIGINT NOT NULL CHECK(join_authority_generation > 0),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
    nonce_sha256 TEXT NOT NULL CHECK(nonce_sha256 ~ '^[0-9a-f]{64}$'),
    request_timestamp TEXT NOT NULL CHECK(gc_try_parse_timestamptz(request_timestamp) IS NOT NULL),
    nonce_expires_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(nonce_expires_at) IS NOT NULL),
    request_method TEXT NOT NULL CHECK(length(request_method) BETWEEN 1 AND 16),
    request_path TEXT NOT NULL CHECK(length(request_path) BETWEEN 1 AND 2048),
    operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
    protocol_body_sha256 TEXT NOT NULL CHECK(protocol_body_sha256 ~ '^[0-9a-f]{64}$'),
    transport_receipt_sha256 TEXT NOT NULL CHECK(transport_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(proof_of_possession_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    tls_exporter_sha256 TEXT NOT NULL CHECK(tls_exporter_sha256 ~ '^[0-9a-f]{64}$'),
    attempted_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(attempted_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(attempted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = attempted_at
    ),
    UNIQUE(workspace_id, idempotency_key, attempt_sha256),
    FOREIGN KEY(workspace_id, node_id, admission_generation)
      REFERENCES remote_worker_mesh_node_bindings(workspace_id, node_id, admission_generation) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_remote_worker_mesh_join_authorities_current
    ON remote_worker_mesh_join_authorities(
      registry_workspace_id, worker_id, worker_generation, join_authority_generation DESC
    );
  CREATE INDEX IF NOT EXISTS idx_remote_worker_mesh_node_attempts_effect
    ON remote_worker_mesh_node_admission_attempts(workspace_id, idempotency_key, stable_effect_sha256);

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_join_authority_guard()
  RETURNS trigger AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id || ':' || NEW.workspace_id || ':' || NEW.node_id, 505));
    IF abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.issued_at) - clock_timestamp()))) > 1
      OR gc_try_parse_timestamptz(NEW.expires_at) <= clock_timestamp()
      OR NEW.join_authority_generation <> 1 + COALESCE((
        SELECT MAX(prior.join_authority_generation)
        FROM remote_worker_mesh_join_authorities prior
        WHERE prior.registry_workspace_id = NEW.registry_workspace_id
          AND prior.worker_id = NEW.worker_id
          AND prior.worker_generation = NEW.worker_generation
      ), 0)
      OR NEW.target_admission_generation <> 1 + COALESCE((
        SELECT MAX(admission.admission_generation) FROM mesh_capability_node_admissions admission
        WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
      ), 0)
      OR NOT EXISTS (
        SELECT 1
        FROM remote_worker_runtime_credentials credential
        JOIN remote_worker_generations generation
          ON generation.registry_workspace_id = credential.registry_workspace_id
         AND generation.worker_id = credential.worker_id
         AND generation.worker_generation = credential.worker_generation
        JOIN remote_worker_protected_admission_evidence evidence
          ON evidence.registry_workspace_id = generation.registry_workspace_id
         AND evidence.worker_id = generation.worker_id
         AND evidence.worker_generation = generation.worker_generation
        JOIN remote_worker_bootstrap_allowed_workspaces allowed
          ON allowed.registry_workspace_id = generation.registry_workspace_id
         AND allowed.bootstrap_id = generation.bootstrap_id
         AND allowed.allowed_workspace_id = NEW.workspace_id
        WHERE credential.registry_workspace_id = NEW.registry_workspace_id
          AND credential.worker_id = NEW.worker_id
          AND credential.worker_generation = NEW.worker_generation
          AND credential.credential_id = NEW.credential_id
          AND credential.credential_generation = NEW.credential_generation
          AND credential.token_sha256 = NEW.runtime_credential_token_sha256
          AND gc_try_parse_timestamptz(credential.expires_at) >= gc_try_parse_timestamptz(NEW.expires_at)
          AND gc_try_parse_timestamptz(credential.expires_at) > clock_timestamp()
          AND generation.bootstrap_id = NEW.bootstrap_id
          AND generation.node_id = NEW.node_id
          AND generation.client_certificate_sha256 = NEW.client_certificate_sha256
          AND generation.worker_generation = (
            SELECT MAX(latest.worker_generation) FROM remote_worker_generations latest
            WHERE latest.registry_workspace_id = NEW.registry_workspace_id AND latest.worker_id = NEW.worker_id
          )
          AND credential.credential_generation = (
            SELECT MAX(latest.credential_generation) FROM remote_worker_runtime_credentials latest
            WHERE latest.registry_workspace_id = NEW.registry_workspace_id
              AND latest.worker_id = NEW.worker_id AND latest.worker_generation = NEW.worker_generation
          )
          AND evidence.envelope_sha256 = NEW.protected_evidence_envelope_sha256
          AND evidence.context_sha256 = NEW.protected_evidence_context_sha256
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_generation_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id
              AND control.worker_id = NEW.worker_id AND control.worker_generation = NEW.worker_generation
          )
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_protected_admission_revocations revoked
            WHERE revoked.registry_workspace_id = NEW.registry_workspace_id
              AND revoked.worker_id = NEW.worker_id AND revoked.worker_generation = NEW.worker_generation
          )
      )
      OR NOT EXISTS (
        SELECT 1 FROM mesh_join_tokens token
        WHERE token.token_hash = NEW.join_credential_sha256
          AND token.used_at IS NULL
          AND token.expires_at = NEW.expires_at
          AND gc_try_parse_timestamptz(token.expires_at) > clock_timestamp()
      ) THEN
      RAISE EXCEPTION 'remote worker mesh join authority is stale or invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_join_authority_revocation_guard()
  RETURNS trigger AS $$
  DECLARE authority_node_id TEXT;
  BEGIN
    SELECT node_id INTO authority_node_id FROM remote_worker_mesh_join_authorities
    WHERE registry_workspace_id = NEW.registry_workspace_id AND worker_id = NEW.worker_id
      AND worker_generation = NEW.worker_generation AND join_authority_generation = NEW.join_authority_generation
      AND workspace_id = NEW.workspace_id;
    IF authority_node_id IS NULL THEN
      RAISE EXCEPTION 'remote worker mesh join authority revocation is invalid' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || authority_node_id, 412));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id || ':' || NEW.workspace_id || ':' || authority_node_id, 505));
    IF abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(NEW.revoked_at) - clock_timestamp()))) > 1 THEN
      RAISE EXCEPTION 'remote worker mesh join authority revocation clock is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_node_binding_guard()
  RETURNS trigger AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id, 501));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id, 502));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.registry_workspace_id || ':' || NEW.worker_id || ':' || NEW.workspace_id || ':' || NEW.node_id, 505));
    IF NOT EXISTS (
      SELECT 1
      FROM remote_worker_mesh_join_authorities authority
      JOIN mesh_capability_node_admissions admission
        ON admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
       AND admission.admission_generation = NEW.admission_generation
      JOIN mesh_join_tokens token ON token.token_hash = NEW.join_credential_sha256
      WHERE authority.registry_workspace_id = NEW.registry_workspace_id
        AND authority.bootstrap_id = NEW.bootstrap_id
        AND authority.worker_id = NEW.worker_id
        AND authority.worker_generation = NEW.worker_generation
        AND authority.credential_id = NEW.credential_id
        AND authority.credential_generation = NEW.credential_generation
        AND authority.runtime_credential_token_sha256 = NEW.runtime_credential_token_sha256
        AND authority.protected_evidence_envelope_sha256 = NEW.protected_evidence_envelope_sha256
        AND authority.protected_evidence_context_sha256 = NEW.protected_evidence_context_sha256
        AND authority.join_authority_generation = NEW.join_authority_generation
        AND authority.workspace_id = NEW.workspace_id AND authority.node_id = NEW.node_id
        AND authority.target_admission_generation = NEW.admission_generation
        AND authority.join_credential_sha256 = NEW.join_credential_sha256
        AND authority.client_certificate_sha256 = NEW.client_certificate_sha256
        AND gc_try_parse_timestamptz(authority.expires_at) > gc_try_parse_timestamptz(NEW.bound_at)
        AND admission.provenance_kind = 'remote_worker'
        AND admission.join_token_sha256 = NEW.join_credential_sha256
        AND admission.tls_fingerprint = NEW.client_certificate_sha256
        AND admission.admitted_by_actor_id = NEW.admitted_by_actor_id
        AND token.used_at = NEW.bound_at AND token.used_by_node_id = NEW.node_id
        AND NOT EXISTS (
          SELECT 1 FROM remote_worker_mesh_join_authority_revocations revoked
          WHERE revoked.registry_workspace_id = authority.registry_workspace_id
            AND revoked.worker_id = authority.worker_id AND revoked.worker_generation = authority.worker_generation
            AND revoked.join_authority_generation = authority.join_authority_generation
        )
    ) THEN
      RAISE EXCEPTION 'remote worker mesh-node binding is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_node_admission_provenance_guard()
  RETURNS trigger AS $$
  DECLARE authority remote_worker_mesh_join_authorities%ROWTYPE;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 411));
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.node_id, 412));
    SELECT * INTO authority FROM remote_worker_mesh_join_authorities
    WHERE join_credential_sha256 = NEW.join_token_sha256;
    IF authority.registry_workspace_id IS NOT NULL AND NEW.provenance_kind <> 'remote_worker' THEN
      RAISE EXCEPTION 'remote worker mesh-node admission provenance downgrade is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_kind <> 'remote_worker' THEN RETURN NEW; END IF;
    IF authority.registry_workspace_id IS NULL THEN
      RAISE EXCEPTION 'remote worker mesh-node admission authority is missing' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.registry_workspace_id, 501));
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.registry_workspace_id || ':' || authority.worker_id, 502));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      authority.registry_workspace_id || ':' || authority.worker_id || ':' || authority.workspace_id || ':' || authority.node_id,
      505
    ));
    IF authority.workspace_id <> NEW.workspace_id
      OR authority.node_id <> NEW.node_id
      OR authority.target_admission_generation <> NEW.admission_generation
      OR authority.client_certificate_sha256 IS DISTINCT FROM NEW.tls_fingerprint
      OR gc_try_parse_timestamptz(authority.expires_at) <= clock_timestamp()
      OR authority.join_authority_generation <> (
        SELECT MAX(latest.join_authority_generation) FROM remote_worker_mesh_join_authorities latest
        WHERE latest.registry_workspace_id = authority.registry_workspace_id
          AND latest.worker_id = authority.worker_id
          AND latest.worker_generation = authority.worker_generation
      )
      OR EXISTS (
        SELECT 1 FROM remote_worker_mesh_join_authority_revocations revoked
        WHERE revoked.registry_workspace_id = authority.registry_workspace_id
          AND revoked.worker_id = authority.worker_id
          AND revoked.worker_generation = authority.worker_generation
          AND revoked.join_authority_generation = authority.join_authority_generation
      )
      OR NOT EXISTS (
        SELECT 1
        FROM remote_worker_runtime_credentials credential
        JOIN remote_worker_generations generation
          ON generation.registry_workspace_id = authority.registry_workspace_id
         AND generation.worker_id = authority.worker_id
         AND generation.worker_generation = authority.worker_generation
        JOIN remote_worker_protected_admission_evidence evidence
          ON evidence.registry_workspace_id = authority.registry_workspace_id
         AND evidence.worker_id = authority.worker_id
         AND evidence.worker_generation = authority.worker_generation
        JOIN remote_worker_bootstrap_allowed_workspaces allowed
          ON allowed.registry_workspace_id = authority.registry_workspace_id
         AND allowed.bootstrap_id = authority.bootstrap_id
         AND allowed.allowed_workspace_id = authority.workspace_id
        WHERE credential.registry_workspace_id = authority.registry_workspace_id
          AND credential.worker_id = authority.worker_id
          AND credential.worker_generation = authority.worker_generation
          AND credential.credential_generation = authority.credential_generation
          AND credential.credential_id = authority.credential_id
          AND credential.token_sha256 = authority.runtime_credential_token_sha256
          AND gc_try_parse_timestamptz(credential.expires_at) > clock_timestamp()
          AND credential.credential_generation = (
            SELECT MAX(latest.credential_generation) FROM remote_worker_runtime_credentials latest
            WHERE latest.registry_workspace_id = authority.registry_workspace_id
              AND latest.worker_id = authority.worker_id
              AND latest.worker_generation = authority.worker_generation
          )
          AND generation.bootstrap_id = authority.bootstrap_id
          AND generation.node_id = authority.node_id
          AND generation.client_certificate_sha256 = authority.client_certificate_sha256
          AND generation.worker_generation = (
            SELECT MAX(latest.worker_generation) FROM remote_worker_generations latest
            WHERE latest.registry_workspace_id = authority.registry_workspace_id
              AND latest.worker_id = authority.worker_id
          )
          AND evidence.envelope_sha256 = authority.protected_evidence_envelope_sha256
          AND evidence.context_sha256 = authority.protected_evidence_context_sha256
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_generation_controls control
            WHERE control.registry_workspace_id = authority.registry_workspace_id
              AND control.worker_id = authority.worker_id
              AND control.worker_generation = authority.worker_generation
          )
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_protected_admission_revocations revoked
            WHERE revoked.registry_workspace_id = authority.registry_workspace_id
              AND revoked.worker_id = authority.worker_id
              AND revoked.worker_generation = authority.worker_generation
          )
      ) THEN
      RAISE EXCEPTION 'remote worker mesh-node admission authority is stale or invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_join_token_guard()
  RETURNS trigger AS $$
  DECLARE authority remote_worker_mesh_join_authorities%ROWTYPE;
  BEGIN
    SELECT * INTO authority FROM remote_worker_mesh_join_authorities WHERE join_credential_sha256 = OLD.token_hash;
    IF authority.registry_workspace_id IS NULL THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.workspace_id, 411));
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.workspace_id || ':' || authority.node_id, 412));
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.registry_workspace_id, 501));
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.registry_workspace_id || ':' || authority.worker_id, 502));
    PERFORM pg_advisory_xact_lock(hashtextextended(authority.registry_workspace_id || ':' || authority.worker_id || ':' || authority.workspace_id || ':' || authority.node_id, 505));
    IF NEW.token_hash <> OLD.token_hash OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
      OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.used_by_node_id <> authority.node_id THEN
      RAISE EXCEPTION 'remote worker mesh join tokens are immutable except exact consumption' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_mesh_join_token_delete_guard()
  RETURNS trigger AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM remote_worker_mesh_join_authorities authority
      WHERE authority.join_credential_sha256 = OLD.token_hash
    ) THEN
      RAISE EXCEPTION 'remote worker mesh join tokens cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_reject_remote_worker_mesh_node_mutation()
  RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'remote worker mesh-node authority records are immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_remote_worker_mesh_join_authorities_insert_guard
    BEFORE INSERT ON remote_worker_mesh_join_authorities FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_mesh_join_authority_guard();
  CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_insert_guard
    BEFORE INSERT ON remote_worker_mesh_join_authority_revocations FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_mesh_join_authority_revocation_guard();
  CREATE TRIGGER trg_remote_worker_mesh_node_bindings_insert_guard
    BEFORE INSERT ON remote_worker_mesh_node_bindings FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_mesh_node_binding_guard();
  CREATE TRIGGER trg_remote_worker_mesh_node_admissions_provenance_guard
    BEFORE INSERT ON mesh_capability_node_admissions FOR EACH ROW
    EXECUTE FUNCTION gc_remote_worker_mesh_node_admission_provenance_guard();
  CREATE TRIGGER trg_remote_worker_mesh_join_tokens_guard
    BEFORE UPDATE ON mesh_join_tokens FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_mesh_join_token_guard();
  CREATE TRIGGER trg_remote_worker_mesh_join_tokens_no_delete
    BEFORE DELETE ON mesh_join_tokens FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_mesh_join_token_delete_guard();

  CREATE TRIGGER trg_remote_worker_mesh_join_authorities_no_update BEFORE UPDATE ON remote_worker_mesh_join_authorities
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_join_authorities_no_delete BEFORE DELETE ON remote_worker_mesh_join_authorities
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_no_update BEFORE UPDATE ON remote_worker_mesh_join_authority_revocations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_no_delete BEFORE DELETE ON remote_worker_mesh_join_authority_revocations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_node_bindings_no_update BEFORE UPDATE ON remote_worker_mesh_node_bindings
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_node_bindings_no_delete BEFORE DELETE ON remote_worker_mesh_node_bindings
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_node_attempts_no_update BEFORE UPDATE ON remote_worker_mesh_node_admission_attempts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
  CREATE TRIGGER trg_remote_worker_mesh_node_attempts_no_delete BEFORE DELETE ON remote_worker_mesh_node_admission_attempts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_mesh_node_mutation();
`;
