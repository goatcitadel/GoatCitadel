import type { DatabaseSync } from "node:sqlite";

/** SQLite 194: immutable remote-worker -> HX-408 mesh-node authority lineage. */
export function createRemoteWorkerMeshNodeAdmissionSchema(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE mesh_capability_node_admissions
      ADD COLUMN provenance_kind TEXT NOT NULL DEFAULT 'legacy'
      CHECK(provenance_kind IN ('legacy', 'remote_worker'));

    CREATE TABLE remote_worker_mesh_join_authorities (
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
      credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation > 0),
      runtime_credential_token_sha256 TEXT NOT NULL CHECK(
        length(runtime_credential_token_sha256) = 64 AND runtime_credential_token_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      protected_evidence_envelope_sha256 TEXT NOT NULL CHECK(
        length(protected_evidence_envelope_sha256) = 64
        AND protected_evidence_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      protected_evidence_context_sha256 TEXT NOT NULL CHECK(
        length(protected_evidence_context_sha256) = 64
        AND protected_evidence_context_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      join_authority_generation INTEGER NOT NULL CHECK(
        typeof(join_authority_generation) = 'integer' AND join_authority_generation > 0
      ),
      target_admission_generation INTEGER NOT NULL CHECK(
        typeof(target_admission_generation) = 'integer' AND target_admission_generation > 0
      ),
      join_credential_sha256 TEXT NOT NULL CHECK(
        length(join_credential_sha256) = 64 AND join_credential_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      client_certificate_sha256 TEXT NOT NULL CHECK(
        length(client_certificate_sha256) = 64 AND client_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      issued_by_actor_id TEXT NOT NULL CHECK(length(issued_by_actor_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      issued_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+0 days') = issued_at
      ),
      expires_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') = expires_at
        AND expires_at > issued_at
        AND (julianday(expires_at) - julianday(issued_at)) * 86400 BETWEEN 1 AND 600
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

    CREATE TABLE remote_worker_mesh_join_authority_revocations (
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      join_authority_generation INTEGER NOT NULL CHECK(
        typeof(join_authority_generation) = 'integer' AND join_authority_generation > 0
      ),
      reason_code TEXT NOT NULL CHECK(
        length(reason_code) BETWEEN 1 AND 128
        AND reason_code NOT GLOB '*[^a-z0-9._-]*'
      ),
      reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256) = 64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
      revoked_by_actor_id TEXT NOT NULL CHECK(length(revoked_by_actor_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      revoked_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') = revoked_at
      ),
      PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation),
      UNIQUE(registry_workspace_id, idempotency_key),
      FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, join_authority_generation)
        REFERENCES remote_worker_mesh_join_authorities(
          registry_workspace_id, worker_id, worker_generation, join_authority_generation
        ) ON DELETE RESTRICT
    );

    CREATE TABLE remote_worker_mesh_node_bindings (
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
      admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
      provenance_kind TEXT NOT NULL CHECK(provenance_kind = 'remote_worker'),
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
      credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation > 0),
      runtime_credential_token_sha256 TEXT NOT NULL CHECK(
        length(runtime_credential_token_sha256) = 64 AND runtime_credential_token_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      protected_evidence_envelope_sha256 TEXT NOT NULL CHECK(
        length(protected_evidence_envelope_sha256) = 64
        AND protected_evidence_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      protected_evidence_context_sha256 TEXT NOT NULL CHECK(
        length(protected_evidence_context_sha256) = 64
        AND protected_evidence_context_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      join_authority_generation INTEGER NOT NULL CHECK(
        typeof(join_authority_generation) = 'integer' AND join_authority_generation > 0
      ),
      join_credential_sha256 TEXT NOT NULL CHECK(
        length(join_credential_sha256) = 64 AND join_credential_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      client_certificate_sha256 TEXT NOT NULL CHECK(
        length(client_certificate_sha256) = 64 AND client_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      stable_effect_sha256 TEXT NOT NULL CHECK(
        length(stable_effect_sha256) = 64 AND stable_effect_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      admitted_by_actor_id TEXT NOT NULL CHECK(length(admitted_by_actor_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      bound_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', bound_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', bound_at, '+0 days') = bound_at
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

    CREATE TABLE remote_worker_mesh_node_admission_attempts (
      attempt_sha256 TEXT PRIMARY KEY CHECK(
        length(attempt_sha256) = 64 AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      stable_effect_sha256 TEXT NOT NULL CHECK(
        length(stable_effect_sha256) = 64 AND stable_effect_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      outcome TEXT NOT NULL CHECK(outcome IN ('admitted', 'replayed')),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
      admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
      credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation > 0),
      join_authority_generation INTEGER NOT NULL CHECK(
        typeof(join_authority_generation) = 'integer' AND join_authority_generation > 0
      ),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      nonce_sha256 TEXT NOT NULL CHECK(length(nonce_sha256) = 64 AND nonce_sha256 NOT GLOB '*[^0-9a-f]*'),
      request_timestamp TEXT NOT NULL,
      nonce_expires_at TEXT NOT NULL,
      request_method TEXT NOT NULL CHECK(length(request_method) BETWEEN 1 AND 16),
      request_path TEXT NOT NULL CHECK(length(request_path) BETWEEN 1 AND 2048),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      protocol_body_sha256 TEXT NOT NULL CHECK(
        length(protocol_body_sha256) = 64 AND protocol_body_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      transport_receipt_sha256 TEXT NOT NULL CHECK(
        length(transport_receipt_sha256) = 64 AND transport_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(
        length(proof_of_possession_receipt_sha256) = 64
        AND proof_of_possession_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      tls_exporter_sha256 TEXT NOT NULL CHECK(
        length(tls_exporter_sha256) = 64 AND tls_exporter_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      attempted_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at, '+0 days') = attempted_at
      ),
      UNIQUE(workspace_id, idempotency_key, attempt_sha256),
      FOREIGN KEY(workspace_id, node_id, admission_generation)
        REFERENCES remote_worker_mesh_node_bindings(workspace_id, node_id, admission_generation) ON DELETE RESTRICT
    );

    CREATE INDEX idx_remote_worker_mesh_join_authorities_current
      ON remote_worker_mesh_join_authorities(
        registry_workspace_id, worker_id, worker_generation, join_authority_generation DESC
      );
    CREATE INDEX idx_remote_worker_mesh_node_attempts_effect
      ON remote_worker_mesh_node_admission_attempts(workspace_id, idempotency_key, stable_effect_sha256);

    CREATE TRIGGER trg_remote_worker_mesh_join_authorities_insert_guard
    BEFORE INSERT ON remote_worker_mesh_join_authorities
    WHEN
      abs((julianday(NEW.issued_at) - julianday('now')) * 86400) > 1
      OR NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      OR NEW.join_authority_generation <> 1 + COALESCE((
        SELECT MAX(prior.join_authority_generation)
        FROM remote_worker_mesh_join_authorities prior
        WHERE prior.registry_workspace_id = NEW.registry_workspace_id
          AND prior.worker_id = NEW.worker_id
          AND prior.worker_generation = NEW.worker_generation
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
          AND credential.expires_at >= NEW.expires_at
          AND credential.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND generation.bootstrap_id = NEW.bootstrap_id
          AND generation.node_id = NEW.node_id
          AND generation.client_certificate_sha256 = NEW.client_certificate_sha256
          AND generation.worker_generation = (
            SELECT MAX(latest.worker_generation) FROM remote_worker_generations latest
            WHERE latest.registry_workspace_id = NEW.registry_workspace_id
              AND latest.worker_id = NEW.worker_id
          )
          AND credential.credential_generation = (
            SELECT MAX(latest.credential_generation) FROM remote_worker_runtime_credentials latest
            WHERE latest.registry_workspace_id = NEW.registry_workspace_id
              AND latest.worker_id = NEW.worker_id
              AND latest.worker_generation = NEW.worker_generation
          )
          AND evidence.envelope_sha256 = NEW.protected_evidence_envelope_sha256
          AND evidence.context_sha256 = NEW.protected_evidence_context_sha256
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_generation_controls control
            WHERE control.registry_workspace_id = NEW.registry_workspace_id
              AND control.worker_id = NEW.worker_id
              AND control.worker_generation = NEW.worker_generation
          )
          AND NOT EXISTS (
            SELECT 1 FROM remote_worker_protected_admission_revocations revoked
            WHERE revoked.registry_workspace_id = NEW.registry_workspace_id
              AND revoked.worker_id = NEW.worker_id
              AND revoked.worker_generation = NEW.worker_generation
          )
      )
      OR NOT EXISTS (
        SELECT 1 FROM mesh_join_tokens token
        WHERE token.token_hash = NEW.join_credential_sha256
          AND token.used_at IS NULL
          AND token.expires_at = NEW.expires_at
          AND token.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      OR NEW.target_admission_generation <> 1 + COALESCE((
        SELECT MAX(admission.admission_generation) FROM mesh_capability_node_admissions admission
        WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
      ), 0)
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authority is stale or invalid'); END;

    CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_insert_guard
    BEFORE INSERT ON remote_worker_mesh_join_authority_revocations
    WHEN
      abs((julianday(NEW.revoked_at) - julianday('now')) * 86400) > 1
      OR NOT EXISTS (
        SELECT 1 FROM remote_worker_mesh_join_authorities authority
        WHERE authority.registry_workspace_id = NEW.registry_workspace_id
          AND authority.worker_id = NEW.worker_id
          AND authority.worker_generation = NEW.worker_generation
          AND authority.join_authority_generation = NEW.join_authority_generation
      )
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authority revocation is invalid'); END;

    CREATE TRIGGER trg_remote_worker_mesh_node_bindings_insert_guard
    BEFORE INSERT ON remote_worker_mesh_node_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM remote_worker_mesh_join_authorities authority
      JOIN mesh_capability_node_admissions admission
        ON admission.workspace_id = NEW.workspace_id
       AND admission.node_id = NEW.node_id
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
        AND authority.workspace_id = NEW.workspace_id
        AND authority.node_id = NEW.node_id
        AND authority.target_admission_generation = NEW.admission_generation
        AND authority.join_credential_sha256 = NEW.join_credential_sha256
        AND authority.client_certificate_sha256 = NEW.client_certificate_sha256
        AND authority.expires_at > NEW.bound_at
        AND admission.provenance_kind = 'remote_worker'
        AND admission.join_token_sha256 = NEW.join_credential_sha256
        AND admission.admitted_by_actor_id = NEW.admitted_by_actor_id
        AND admission.tls_fingerprint = NEW.client_certificate_sha256
        AND token.used_at = NEW.bound_at
        AND token.used_by_node_id = NEW.node_id
        AND NOT EXISTS (
          SELECT 1 FROM remote_worker_mesh_join_authority_revocations revoked
          WHERE revoked.registry_workspace_id = authority.registry_workspace_id
            AND revoked.worker_id = authority.worker_id
            AND revoked.worker_generation = authority.worker_generation
            AND revoked.join_authority_generation = authority.join_authority_generation
        )
    )
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node binding is invalid'); END;

    CREATE TRIGGER trg_remote_worker_mesh_node_admissions_provenance_guard
    BEFORE INSERT ON mesh_capability_node_admissions
    WHEN
      (
        EXISTS (
          SELECT 1 FROM remote_worker_mesh_join_authorities authority
          WHERE authority.join_credential_sha256 = NEW.join_token_sha256
        )
        AND NEW.provenance_kind <> 'remote_worker'
      )
      OR (
        NEW.provenance_kind = 'remote_worker'
        AND NOT EXISTS (
          SELECT 1
          FROM remote_worker_mesh_join_authorities authority
          JOIN remote_worker_runtime_credentials credential
            ON credential.registry_workspace_id = authority.registry_workspace_id
           AND credential.worker_id = authority.worker_id
           AND credential.worker_generation = authority.worker_generation
           AND credential.credential_generation = authority.credential_generation
           AND credential.credential_id = authority.credential_id
           AND credential.token_sha256 = authority.runtime_credential_token_sha256
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
          WHERE authority.join_credential_sha256 = NEW.join_token_sha256
            AND authority.workspace_id = NEW.workspace_id
            AND authority.node_id = NEW.node_id
            AND authority.target_admission_generation = NEW.admission_generation
            AND authority.client_certificate_sha256 = NEW.tls_fingerprint
            AND authority.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND authority.join_authority_generation = (
              SELECT MAX(latest.join_authority_generation)
              FROM remote_worker_mesh_join_authorities latest
              WHERE latest.registry_workspace_id = authority.registry_workspace_id
                AND latest.worker_id = authority.worker_id
                AND latest.worker_generation = authority.worker_generation
            )
            AND credential.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
              SELECT 1 FROM remote_worker_mesh_join_authority_revocations revoked
              WHERE revoked.registry_workspace_id = authority.registry_workspace_id
                AND revoked.worker_id = authority.worker_id
                AND revoked.worker_generation = authority.worker_generation
                AND revoked.join_authority_generation = authority.join_authority_generation
            )
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
        )
      )
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node admission provenance is invalid'); END;

    CREATE TRIGGER trg_remote_worker_mesh_join_tokens_guard
    BEFORE UPDATE ON mesh_join_tokens
    WHEN EXISTS (
      SELECT 1 FROM remote_worker_mesh_join_authorities authority WHERE authority.join_credential_sha256 = OLD.token_hash
    ) AND NOT (
      NEW.token_hash = OLD.token_hash
      AND NEW.created_at = OLD.created_at
      AND NEW.expires_at = OLD.expires_at
      AND OLD.used_at IS NULL
      AND NEW.used_at IS NOT NULL
      AND NEW.used_by_node_id = (
        SELECT authority.node_id FROM remote_worker_mesh_join_authorities authority
        WHERE authority.join_credential_sha256 = OLD.token_hash
      )
    )
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh join tokens are immutable except exact consumption'); END;

    CREATE TRIGGER trg_remote_worker_mesh_join_tokens_no_delete
    BEFORE DELETE ON mesh_join_tokens
    WHEN EXISTS (
      SELECT 1 FROM remote_worker_mesh_join_authorities authority WHERE authority.join_credential_sha256 = OLD.token_hash
    )
    BEGIN SELECT RAISE(ABORT, 'remote worker mesh join tokens cannot be deleted'); END;

    CREATE TRIGGER trg_remote_worker_mesh_join_authorities_no_update BEFORE UPDATE ON remote_worker_mesh_join_authorities
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authorities are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_join_authorities_no_delete BEFORE DELETE ON remote_worker_mesh_join_authorities
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authorities are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_no_update BEFORE UPDATE ON remote_worker_mesh_join_authority_revocations
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authority revocations are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_join_authority_revocations_no_delete BEFORE DELETE ON remote_worker_mesh_join_authority_revocations
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh join authority revocations are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_node_bindings_no_update BEFORE UPDATE ON remote_worker_mesh_node_bindings
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node bindings are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_node_bindings_no_delete BEFORE DELETE ON remote_worker_mesh_node_bindings
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node bindings are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_node_attempts_no_update BEFORE UPDATE ON remote_worker_mesh_node_admission_attempts
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node attempts are immutable'); END;
    CREATE TRIGGER trg_remote_worker_mesh_node_attempts_no_delete BEFORE DELETE ON remote_worker_mesh_node_admission_attempts
      BEGIN SELECT RAISE(ABORT, 'remote worker mesh-node attempts are immutable'); END;
  `);
}
