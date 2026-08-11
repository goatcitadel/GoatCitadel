/** PostgreSQL 136: immutable protected-key admission pins/evidence and revocation lineage. */
export const REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_POSTGRES_SQL = `
  CREATE TABLE IF NOT EXISTS remote_worker_protected_admission_signer_pins (
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    keyset_generation BIGINT NOT NULL CHECK(keyset_generation > 0),
    keyset_receipt_sha256 TEXT NOT NULL CHECK(keyset_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    signer_spki_sha256 TEXT NOT NULL CHECK(signer_spki_sha256 ~ '^[0-9a-f]{64}$'),
    signer_spki_base64url TEXT NOT NULL CHECK(signer_spki_base64url ~ '^[A-Za-z0-9_-]{59}$'),
    authenticated_operator_actor_id TEXT NOT NULL CHECK(length(authenticated_operator_actor_id) BETWEEN 1 AND 256),
    authenticated_operator_actor_sha256 TEXT NOT NULL CHECK(authenticated_operator_actor_sha256 ~ '^[0-9a-f]{64}$'),
    pinned_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(pinned_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(pinned_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = pinned_at
    ),
    PRIMARY KEY(registry_workspace_id, bootstrap_id),
    UNIQUE(registry_workspace_id, worker_id, keyset_generation),
    FOREIGN KEY(registry_workspace_id, bootstrap_id)
      REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS remote_worker_protected_admission_evidence (
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    operation_id_base64url TEXT NOT NULL UNIQUE CHECK(operation_id_base64url ~ '^[A-Za-z0-9_-]{22}$'),
    evidence_nonce_sha256 TEXT NOT NULL UNIQUE CHECK(evidence_nonce_sha256 ~ '^[0-9a-f]{64}$'),
    envelope_sha256 TEXT NOT NULL UNIQUE CHECK(envelope_sha256 ~ '^[0-9a-f]{64}$'),
    envelope_base64url TEXT NOT NULL CHECK(envelope_base64url ~ '^[A-Za-z0-9_-]{384}$'),
    keyset_receipt_sha256 TEXT NOT NULL CHECK(keyset_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    signer_spki_sha256 TEXT NOT NULL CHECK(signer_spki_sha256 ~ '^[0-9a-f]{64}$'),
    signer_spki_base64url TEXT NOT NULL CHECK(signer_spki_base64url ~ '^[A-Za-z0-9_-]{59}$'),
    signature_base64url TEXT NOT NULL CHECK(signature_base64url ~ '^[A-Za-z0-9_-]{86}$'),
    context_sha256 TEXT NOT NULL CHECK(context_sha256 ~ '^[0-9a-f]{64}$'),
    runtime_manifest_sha256 TEXT NOT NULL CHECK(runtime_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    runtime_manifest_payload_sha256 TEXT NOT NULL CHECK(runtime_manifest_payload_sha256 ~ '^[0-9a-f]{64}$'),
    workspace_ceiling_sha256 TEXT NOT NULL CHECK(workspace_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
    capability_ceiling_sha256 TEXT NOT NULL CHECK(capability_ceiling_sha256 ~ '^[0-9a-f]{64}$'),
    worker_public_key_spki_sha256 TEXT NOT NULL CHECK(worker_public_key_spki_sha256 ~ '^[0-9a-f]{64}$'),
    worker_public_key_spki_base64url TEXT NOT NULL CHECK(worker_public_key_spki_base64url ~ '^[A-Za-z0-9_-]{59}$'),
    client_certificate_sha256 TEXT NOT NULL CHECK(client_certificate_sha256 ~ '^[0-9a-f]{64}$'),
    transport_trust_anchor_sha256 TEXT NOT NULL CHECK(transport_trust_anchor_sha256 ~ '^[0-9a-f]{64}$'),
    tls_exporter_sha256 TEXT NOT NULL CHECK(tls_exporter_sha256 ~ '^[0-9a-f]{64}$'),
    authenticated_remote_caller_binding_sha256 TEXT NOT NULL CHECK(
      authenticated_remote_caller_binding_sha256 ~ '^[0-9a-f]{64}$'
    ),
    download_verification_receipt_sha256 TEXT NOT NULL CHECK(download_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    installed_tree_attestation_sha256 TEXT NOT NULL CHECK(installed_tree_attestation_sha256 ~ '^[0-9a-f]{64}$'),
    installed_tree_verification_receipt_sha256 TEXT NOT NULL CHECK(
      installed_tree_verification_receipt_sha256 ~ '^[0-9a-f]{64}$'
    ),
    authenticated_operator_actor_id TEXT NOT NULL CHECK(length(authenticated_operator_actor_id) BETWEEN 1 AND 256),
    authenticated_operator_actor_sha256 TEXT NOT NULL CHECK(authenticated_operator_actor_sha256 ~ '^[0-9a-f]{64}$'),
    admitted_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(admitted_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(admitted_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = admitted_at
    ),
    PRIMARY KEY(registry_workspace_id, worker_id, worker_generation),
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
      REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, bootstrap_id)
      REFERENCES remote_worker_protected_admission_signer_pins(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT,
    FOREIGN KEY(registry_workspace_id, worker_id, worker_generation, bootstrap_id, evidence_nonce_sha256)
      REFERENCES remote_worker_bootstrap_request_nonces(
        registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256
      ) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS remote_worker_protected_admission_revocations (
    registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
    worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
    worker_generation BIGINT NOT NULL CHECK(worker_generation > 0),
    control_revision BIGINT NOT NULL CHECK(control_revision > 0),
    revoked_at TEXT NOT NULL CHECK(
      gc_try_parse_timestamptz(revoked_at) IS NOT NULL
      AND to_char(gc_try_parse_timestamptz(revoked_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = revoked_at
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

  CREATE OR REPLACE FUNCTION gc_remote_worker_protected_admission_signer_pin_guard()
  RETURNS trigger AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
      WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
        AND bootstrap.bootstrap_id = NEW.bootstrap_id
        AND bootstrap.worker_id = NEW.worker_id
        AND bootstrap.target_worker_generation = NEW.keyset_generation
        AND bootstrap.created_by_actor_id = NEW.authenticated_operator_actor_id
        AND bootstrap.created_at = NEW.pinned_at
    ) THEN
      RAISE EXCEPTION 'remote worker protected admission signer pin is not operator/bootstrap bound' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_protected_admission_evidence_guard()
  RETURNS trigger AS $$
  BEGIN
    IF NOT EXISTS (
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
            AND bootstrap.runtime_manifest_json::json ->> 'payloadSha256' = NEW.runtime_manifest_payload_sha256
        )
    ) THEN
      RAISE EXCEPTION 'remote worker protected admission evidence binding is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_remote_worker_protected_admission_revocation_guard()
  RETURNS trigger AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM remote_worker_generation_controls control
      WHERE control.registry_workspace_id = NEW.registry_workspace_id
        AND control.worker_id = NEW.worker_id
        AND control.worker_generation = NEW.worker_generation
        AND control.control_revision = NEW.control_revision
        AND control.action = 'revoke'
        AND control.created_at = NEW.revoked_at
    ) THEN
      RAISE EXCEPTION 'remote worker protected admission revocation binding is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_reject_remote_worker_protected_admission_mutation()
  RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'remote worker protected admission records are immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_signer_pins
    FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_protected_admission_signer_pin_guard();
  CREATE TRIGGER trg_remote_worker_protected_admission_evidence_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_evidence
    FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_protected_admission_evidence_guard();
  CREATE TRIGGER trg_remote_worker_protected_admission_revocations_insert_guard
    BEFORE INSERT ON remote_worker_protected_admission_revocations
    FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_protected_admission_revocation_guard();

  CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_signer_pins
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
  CREATE TRIGGER trg_remote_worker_protected_admission_signer_pins_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_signer_pins
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
  CREATE TRIGGER trg_remote_worker_protected_admission_evidence_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_evidence
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
  CREATE TRIGGER trg_remote_worker_protected_admission_evidence_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_evidence
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
  CREATE TRIGGER trg_remote_worker_protected_admission_revocations_no_update
    BEFORE UPDATE ON remote_worker_protected_admission_revocations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
  CREATE TRIGGER trg_remote_worker_protected_admission_revocations_no_delete
    BEFORE DELETE ON remote_worker_protected_admission_revocations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remote_worker_protected_admission_mutation();
`;
