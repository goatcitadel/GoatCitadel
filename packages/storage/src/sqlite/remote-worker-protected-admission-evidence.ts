import type { DatabaseSync } from "node:sqlite";

/** SQLite 193: immutable protected-key admission pins/evidence and revocation lineage. */
export function createRemoteWorkerProtectedAdmissionEvidenceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE remote_worker_protected_admission_signer_pins (
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      keyset_generation INTEGER NOT NULL CHECK(typeof(keyset_generation) = 'integer' AND keyset_generation > 0),
      keyset_receipt_sha256 TEXT NOT NULL CHECK(
        length(keyset_receipt_sha256) = 64 AND keyset_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      signer_spki_sha256 TEXT NOT NULL CHECK(
        length(signer_spki_sha256) = 64 AND signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      signer_spki_base64url TEXT NOT NULL CHECK(
        length(signer_spki_base64url) = 59 AND signer_spki_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      authenticated_operator_actor_id TEXT NOT NULL CHECK(length(authenticated_operator_actor_id) BETWEEN 1 AND 256),
      authenticated_operator_actor_sha256 TEXT NOT NULL CHECK(
        length(authenticated_operator_actor_sha256) = 64
        AND authenticated_operator_actor_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      pinned_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', pinned_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', pinned_at, '+0 days') = pinned_at
      ),
      PRIMARY KEY(registry_workspace_id, bootstrap_id),
      UNIQUE(registry_workspace_id, worker_id, keyset_generation),
      FOREIGN KEY(registry_workspace_id, bootstrap_id)
        REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
    );

    CREATE TABLE remote_worker_protected_admission_evidence (
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      operation_id_base64url TEXT NOT NULL CHECK(
        length(operation_id_base64url) = 22 AND operation_id_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      evidence_nonce_sha256 TEXT NOT NULL CHECK(
        length(evidence_nonce_sha256) = 64 AND evidence_nonce_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      envelope_sha256 TEXT NOT NULL CHECK(
        length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      envelope_base64url TEXT NOT NULL CHECK(
        length(envelope_base64url) = 384 AND envelope_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      keyset_receipt_sha256 TEXT NOT NULL CHECK(
        length(keyset_receipt_sha256) = 64 AND keyset_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      signer_spki_sha256 TEXT NOT NULL CHECK(
        length(signer_spki_sha256) = 64 AND signer_spki_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      signer_spki_base64url TEXT NOT NULL CHECK(
        length(signer_spki_base64url) = 59 AND signer_spki_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      signature_base64url TEXT NOT NULL CHECK(
        length(signature_base64url) = 86 AND signature_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      context_sha256 TEXT NOT NULL CHECK(
        length(context_sha256) = 64 AND context_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      runtime_manifest_sha256 TEXT NOT NULL CHECK(
        length(runtime_manifest_sha256) = 64 AND runtime_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      runtime_manifest_payload_sha256 TEXT NOT NULL CHECK(
        length(runtime_manifest_payload_sha256) = 64
        AND runtime_manifest_payload_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      workspace_ceiling_sha256 TEXT NOT NULL CHECK(
        length(workspace_ceiling_sha256) = 64 AND workspace_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      capability_ceiling_sha256 TEXT NOT NULL CHECK(
        length(capability_ceiling_sha256) = 64 AND capability_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      worker_public_key_spki_sha256 TEXT NOT NULL CHECK(
        length(worker_public_key_spki_sha256) = 64 AND worker_public_key_spki_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      worker_public_key_spki_base64url TEXT NOT NULL CHECK(
        length(worker_public_key_spki_base64url) = 59
        AND worker_public_key_spki_base64url NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      client_certificate_sha256 TEXT NOT NULL CHECK(
        length(client_certificate_sha256) = 64 AND client_certificate_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      transport_trust_anchor_sha256 TEXT NOT NULL CHECK(
        length(transport_trust_anchor_sha256) = 64
        AND transport_trust_anchor_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      tls_exporter_sha256 TEXT NOT NULL CHECK(
        length(tls_exporter_sha256) = 64 AND tls_exporter_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      authenticated_remote_caller_binding_sha256 TEXT NOT NULL CHECK(
        length(authenticated_remote_caller_binding_sha256) = 64
        AND authenticated_remote_caller_binding_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      download_verification_receipt_sha256 TEXT NOT NULL CHECK(
        length(download_verification_receipt_sha256) = 64
        AND download_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      installed_tree_attestation_sha256 TEXT NOT NULL CHECK(
        length(installed_tree_attestation_sha256) = 64
        AND installed_tree_attestation_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      installed_tree_verification_receipt_sha256 TEXT NOT NULL CHECK(
        length(installed_tree_verification_receipt_sha256) = 64
        AND installed_tree_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      authenticated_operator_actor_id TEXT NOT NULL CHECK(length(authenticated_operator_actor_id) BETWEEN 1 AND 256),
      authenticated_operator_actor_sha256 TEXT NOT NULL CHECK(
        length(authenticated_operator_actor_sha256) = 64
        AND authenticated_operator_actor_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      admitted_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at, '+0 days') = admitted_at
      ),
      PRIMARY KEY(registry_workspace_id, worker_id, worker_generation),
      UNIQUE(operation_id_base64url),
      UNIQUE(evidence_nonce_sha256),
      UNIQUE(envelope_sha256),
      FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
        REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
      FOREIGN KEY(registry_workspace_id, bootstrap_id)
        REFERENCES remote_worker_protected_admission_signer_pins(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT,
      FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, bootstrap_id, evidence_nonce_sha256)
        REFERENCES remote_worker_bootstrap_request_nonces(
          registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256
        ) ON DELETE RESTRICT
    );

    CREATE TABLE remote_worker_protected_admission_revocations (
      registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
      worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
      control_revision INTEGER NOT NULL CHECK(typeof(control_revision) = 'integer' AND control_revision > 0),
      revoked_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') = revoked_at
      ),
      PRIMARY KEY(registry_workspace_id, worker_id, worker_generation),
      FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
        REFERENCES remote_worker_protected_admission_evidence(
          registry_workspace_id, worker_id, worker_generation
        ) ON DELETE RESTRICT,
      FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, control_revision)
        REFERENCES remote_worker_generation_controls(
          registry_workspace_id, worker_id, worker_generation, control_revision
        ) ON DELETE RESTRICT
    );

    CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_signer_pins
    WHEN NOT EXISTS (
      SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
      WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
        AND bootstrap.bootstrap_id = NEW.bootstrap_id
        AND bootstrap.worker_id = NEW.worker_id
        AND bootstrap.target_worker_generation = NEW.keyset_generation
        AND bootstrap.created_by_actor_id = NEW.authenticated_operator_actor_id
        AND bootstrap.created_at = NEW.pinned_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'remote worker protected admission signer pin is not operator/bootstrap bound');
    END;

    CREATE TRIGGER trg_remote_worker_protected_admission_evidence_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_evidence
    WHEN NOT EXISTS (
      SELECT 1
      FROM remote_worker_generations generation
      JOIN remote_worker_protected_admission_signer_pins pin
        ON pin.registry_workspace_id = generation.registry_workspace_id
       AND pin.bootstrap_id = generation.bootstrap_id
      WHERE generation.registry_workspace_id = NEW.registry_workspace_id
        AND generation.worker_id = NEW.worker_id
        AND generation.worker_generation = NEW.worker_generation
        AND generation.bootstrap_id = NEW.bootstrap_id
        AND generation.public_key_spki_sha256 = NEW.worker_public_key_spki_sha256
        AND generation.client_certificate_sha256 = NEW.client_certificate_sha256
        AND generation.transport_trust_anchor_sha256 = NEW.transport_trust_anchor_sha256
        AND generation.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
        AND generation.workspace_ceiling_sha256 = NEW.workspace_ceiling_sha256
        AND generation.capability_ceiling_sha256 = NEW.capability_ceiling_sha256
        AND generation.download_verification_receipt_sha256 = NEW.download_verification_receipt_sha256
        AND generation.installed_tree_attestation_sha256 = NEW.installed_tree_attestation_sha256
        AND generation.installed_tree_verification_receipt_sha256 = NEW.installed_tree_verification_receipt_sha256
        AND generation.admitted_at = NEW.admitted_at
        AND pin.keyset_generation = NEW.worker_generation
        AND pin.keyset_receipt_sha256 = NEW.keyset_receipt_sha256
        AND pin.signer_spki_sha256 = NEW.signer_spki_sha256
        AND pin.signer_spki_base64url = NEW.signer_spki_base64url
        AND pin.authenticated_operator_actor_id = NEW.authenticated_operator_actor_id
        AND pin.authenticated_operator_actor_sha256 = NEW.authenticated_operator_actor_sha256
        AND EXISTS (
          SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
          WHERE bootstrap.registry_workspace_id = generation.registry_workspace_id
            AND bootstrap.bootstrap_id = generation.bootstrap_id
            AND bootstrap.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
            AND json_extract(bootstrap.runtime_manifest_json, '$.payloadSha256') = NEW.runtime_manifest_payload_sha256
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'remote worker protected admission evidence binding is invalid');
    END;

    CREATE TRIGGER trg_remote_worker_protected_admission_revocations_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_revocations
    WHEN NOT EXISTS (
      SELECT 1 FROM remote_worker_generation_controls control
      WHERE control.registry_workspace_id = NEW.registry_workspace_id
        AND control.worker_id = NEW.worker_id
        AND control.worker_generation = NEW.worker_generation
        AND control.control_revision = NEW.control_revision
        AND control.action = 'revoke'
        AND control.created_at = NEW.revoked_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'remote worker protected admission revocation binding is invalid');
    END;

    CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_signer_pins
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission signer pins are immutable'); END;
    CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_signer_pins
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission signer pins are immutable'); END;
    CREATE TRIGGER trg_remote_worker_protected_admission_evidence_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_evidence
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_protected_admission_evidence_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_evidence
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_protected_admission_revocations_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_revocations
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission revocations are immutable'); END;
    CREATE TRIGGER trg_remote_worker_protected_admission_revocations_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_revocations
    BEGIN SELECT RAISE(ABORT, 'remote worker protected admission revocations are immutable'); END;
  `);
}
