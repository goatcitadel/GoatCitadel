/* eslint-disable max-lines -- Remote worker admission keeps cross-dialect replay, fencing, and redaction invariants in one audited repository boundary. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT,
  REMOTE_WORKER_REGISTRY_MAX_LIMIT,
  REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
  ValidationError,
  assertRemoteWorkerBootstrapRecord,
  assertRemoteWorkerGenerationControlRecord,
  assertRemoteWorkerGenerationRecord,
  assertRemoteWorkerRegistryAdmission,
  assertRemoteWorkerRegistryControl,
  assertRemoteWorkerRuntimeCredentialRecord,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  compareRemoteWorkerCanonicalIdentifiers,
  normalizeCreateRemoteWorkerBootstrapCommand,
  normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand,
  normalizeRemoteWorkerGenerationControlInput,
  normalizeRotateRemoteWorkerRuntimeCredentialCommand,
  remoteWorkerBootstrapAdmissionReplayMaterial,
  remoteWorkerBootstrapReplayMaterial,
  remoteWorkerRuntimeCredentialRotationReplayMaterial,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerCapabilityClass,
  type RemoteWorkerGenerationControlInput,
  type RemoteWorkerGenerationControlRecord,
  type RemoteWorkerGenerationRecord,
  type RemoteWorkerRegistryAdmission,
  type RemoteWorkerRegistryControl,
  type RemoteWorkerRuntimeCredentialRecord,
  type RemoteWorkerRuntimeCredentialClaims,
  type RotateRemoteWorkerRuntimeCredentialCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface CreateRemoteWorkerBootstrapOutcome {
  disposition: "created" | "replayed_without_secret";
  record: RemoteWorkerBootstrapRecord;
}

export interface FinalizeRemoteWorkerBootstrapAdmissionOutcome {
  disposition: "admitted" | "replayed_without_credential_secret";
  generation: RemoteWorkerGenerationRecord;
  credential: RemoteWorkerRuntimeCredentialRecord;
}

export interface RotateRemoteWorkerRuntimeCredentialOutcome {
  disposition: "created" | "replayed_without_credential_secret";
  credential: RemoteWorkerRuntimeCredentialRecord;
}

export interface ResolvedRemoteWorkerRuntimeCredential {
  generation: RemoteWorkerGenerationRecord;
  credential: RemoteWorkerRuntimeCredentialRecord;
  allowedWorkspaceIds: string[];
  capabilityClasses: RemoteWorkerCapabilityClass[];
}

export interface ListRemoteWorkersOptions {
  limit?: number;
  cursor?: string;
}

export interface ListRemoteWorkersResult {
  items: RemoteWorkerGenerationRecord[];
  nextCursor?: string;
}

export interface RemoteWorkerRegistryRecord {
  readonly admission: RemoteWorkerRegistryAdmission;
  readonly control?: RemoteWorkerRegistryControl;
}

export interface ListRemoteWorkerRegistryResult {
  readonly items: readonly RemoteWorkerRegistryRecord[];
  readonly nextCursor?: string;
}

interface BootstrapRow {
  registry_workspace_id: string;
  bootstrap_id: string;
  worker_id: string;
  node_id: string;
  target_worker_generation: number | bigint | string;
  worker_label: string;
  platform: string;
  architecture: string;
  runtime_manifest_json: string;
  runtime_manifest_sha256: string;
  allowed_workspace_count: number | bigint | string;
  workspace_ceiling_sha256: string;
  capability_class_count: number | bigint | string;
  capability_ceiling_sha256: string;
  bootstrap_secret_sha256: string;
  expires_at: string;
  created_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface GenerationRow {
  registry_workspace_id: string;
  worker_id: string;
  node_id: string;
  worker_generation: number | bigint | string;
  bootstrap_id: string;
  public_key_spki_sha256: string;
  client_certificate_sha256: string;
  transport_identity_source: string;
  transport_trust_anchor_sha256: string;
  transport_verification_receipt_sha256: string;
  proof_of_possession_receipt_sha256: string;
  download_verification_receipt_sha256: string;
  installed_tree_attestation_sha256: string;
  installed_tree_verification_receipt_sha256: string;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  exchange_idempotency_key: string;
  exchange_request_sha256: string;
  admitted_at: string;
}

interface CredentialRow {
  registry_workspace_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  credential_generation: number | bigint | string;
  credential_id: string;
  purpose: string;
  token_sha256: string;
  transport_verification_receipt_sha256: string;
  proof_of_possession_receipt_sha256: string;
  claims_json: string;
  claims_sha256: string;
  issuance_proof_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  issued_at: string;
  expires_at: string;
}

interface ControlRow {
  registry_workspace_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  control_revision: number | bigint | string;
  action: string;
  reason_code: string;
  reason_sha256: string;
  actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface RegistryRow {
  registry_workspace_id: string;
  worker_id: string;
  node_id: string;
  worker_generation: number | bigint | string;
  bootstrap_id: string;
  public_key_spki_sha256: string;
  client_certificate_sha256: string;
  transport_identity_source: string;
  transport_trust_anchor_sha256: string;
  transport_verification_receipt_sha256: string;
  proof_of_possession_receipt_sha256: string;
  download_verification_receipt_sha256: string;
  installed_tree_attestation_sha256: string;
  installed_tree_verification_receipt_sha256: string;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  admitted_at: string;
  bootstrap_worker_id: string;
  bootstrap_node_id: string;
  bootstrap_target_worker_generation: number | bigint | string;
  bootstrap_worker_label: string;
  bootstrap_platform: string;
  bootstrap_architecture: string;
  bootstrap_runtime_manifest_sha256: string;
  bootstrap_allowed_workspace_count: number | bigint | string;
  bootstrap_workspace_ceiling_sha256: string;
  bootstrap_capability_class_count: number | bigint | string;
  bootstrap_capability_ceiling_sha256: string;
  control_worker_generation: number | bigint | string | null;
  control_revision: number | bigint | string | null;
  control_action: string | null;
  control_created_at: string | null;
}

const REMOTE_WORKER_REGISTRY_SELECT = `
  SELECT
    generation.registry_workspace_id,
    generation.worker_id,
    generation.node_id,
    generation.worker_generation,
    generation.bootstrap_id,
    generation.public_key_spki_sha256,
    generation.client_certificate_sha256,
    generation.transport_identity_source,
    generation.transport_trust_anchor_sha256,
    generation.transport_verification_receipt_sha256,
    generation.proof_of_possession_receipt_sha256,
    generation.download_verification_receipt_sha256,
    generation.installed_tree_attestation_sha256,
    generation.installed_tree_verification_receipt_sha256,
    generation.runtime_manifest_sha256,
    generation.workspace_ceiling_sha256,
    generation.capability_ceiling_sha256,
    generation.admitted_at,
    bootstrap.worker_id AS bootstrap_worker_id,
    bootstrap.node_id AS bootstrap_node_id,
    bootstrap.target_worker_generation AS bootstrap_target_worker_generation,
    bootstrap.worker_label AS bootstrap_worker_label,
    bootstrap.platform AS bootstrap_platform,
    bootstrap.architecture AS bootstrap_architecture,
    bootstrap.runtime_manifest_sha256 AS bootstrap_runtime_manifest_sha256,
    bootstrap.allowed_workspace_count AS bootstrap_allowed_workspace_count,
    bootstrap.workspace_ceiling_sha256 AS bootstrap_workspace_ceiling_sha256,
    bootstrap.capability_class_count AS bootstrap_capability_class_count,
    bootstrap.capability_ceiling_sha256 AS bootstrap_capability_ceiling_sha256,
    control.worker_generation AS control_worker_generation,
    control.control_revision,
    control.action AS control_action,
    control.created_at AS control_created_at
  FROM remote_worker_generations generation
  INNER JOIN remote_worker_bootstrap_requests bootstrap
    ON bootstrap.registry_workspace_id = generation.registry_workspace_id
    AND bootstrap.bootstrap_id = generation.bootstrap_id
  LEFT JOIN remote_worker_generation_controls control
    ON control.registry_workspace_id = generation.registry_workspace_id
    AND control.worker_id = generation.worker_id
    AND control.worker_generation = generation.worker_generation
    AND control.control_revision = (
      SELECT MAX(latest_control.control_revision)
      FROM remote_worker_generation_controls latest_control
      WHERE latest_control.registry_workspace_id = generation.registry_workspace_id
        AND latest_control.worker_id = generation.worker_id
        AND latest_control.worker_generation = generation.worker_generation
    )
`;

export class RemoteWorkerAdmissionRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public createBootstrap(input: CreateRemoteWorkerBootstrapCommand): CreateRemoteWorkerBootstrapOutcome {
    const normalized = normalizeCreateRemoteWorkerBootstrapCommand(input);
    const workerId =
      normalized.existingWorkerId ??
      deriveServerId("remote-worker", normalized.registryWorkspaceId, normalized.idempotencyKey);
    const bootstrapId = deriveServerId(
      "remote-worker-bootstrap",
      normalized.registryWorkspaceId,
      normalized.idempotencyKey,
    );
    const requestSha256 = sha256(remoteWorkerBootstrapReplayMaterial(normalized));

    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.registryWorkspaceId, workerId);
      const replay = this.findBootstrapByIdempotency(normalized.registryWorkspaceId, normalized.idempotencyKey);
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker bootstrap");
        return { disposition: "replayed_without_secret", record: this.mapBootstrap(replay) };
      }

      const current = this.findCurrentGenerationRow(normalized.registryWorkspaceId, workerId);
      if (normalized.existingWorkerId !== undefined && !current) {
        throw unavailable("remote worker generation");
      }
      if (normalized.existingWorkerId === undefined && current) {
        throw invariantConflict("remote worker bootstrap");
      }
      if (current) {
        const control = this.findLatestControlRow(
          normalized.registryWorkspaceId,
          workerId,
          asPositiveInteger(current.worker_generation),
        );
        if (control?.action !== "revoke") {
          throw invariantConflict("remote worker bootstrap");
        }
      }
      const targetWorkerGeneration = current ? asPositiveInteger(current.worker_generation) + 1 : 1;
      const nodeId = current?.node_id ?? deriveServerId("remote-worker-node", normalized.registryWorkspaceId, workerId);
      const runtimeManifestJson = canonicalJsonString(normalized.runtimeManifest);
      const runtimeManifestSha256 = sha256Bytes(runtimeManifestJson);
      const workspaceCeilingSha256 = sha256(normalized.allowedWorkspaceIds);
      const capabilityCeilingSha256 = sha256(normalized.capabilityClasses);
      const clock = this.databaseClockWithTtl(normalized.expiresInSeconds);

      try {
        this.db
          .prepare(
            `
            INSERT INTO remote_worker_bootstrap_requests (
              registry_workspace_id, bootstrap_id, worker_id, node_id, target_worker_generation,
              worker_label, platform, architecture, runtime_manifest_json, runtime_manifest_sha256,
              allowed_workspace_count, workspace_ceiling_sha256, capability_class_count,
              capability_ceiling_sha256, bootstrap_secret_sha256, expires_at, created_by_actor_id,
              idempotency_key, request_sha256, created_at
            ) VALUES (
              @registryWorkspaceId, @bootstrapId, @workerId, @nodeId, @targetWorkerGeneration,
              @workerLabel, @platform, @architecture, @runtimeManifestJson, @runtimeManifestSha256,
              @allowedWorkspaceCount, @workspaceCeilingSha256, @capabilityClassCount,
              @capabilityCeilingSha256, @bootstrapSecretSha256, @expiresAt, @createdByActorId,
              @idempotencyKey, @requestSha256, @createdAt
            )
          `,
          )
          .run({
            registryWorkspaceId: normalized.registryWorkspaceId,
            bootstrapId,
            workerId,
            nodeId,
            targetWorkerGeneration,
            workerLabel: normalized.workerLabel,
            platform: normalized.platform,
            architecture: normalized.architecture,
            runtimeManifestJson,
            runtimeManifestSha256,
            allowedWorkspaceCount: normalized.allowedWorkspaceIds.length,
            workspaceCeilingSha256,
            capabilityClassCount: normalized.capabilityClasses.length,
            capabilityCeilingSha256,
            bootstrapSecretSha256: normalized.bootstrapSecretSha256,
            expiresAt: clock.expiresAt,
            createdByActorId: normalized.createdByActorId,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            createdAt: clock.now,
          });
        const workspaceStmt = this.db.prepare(`
          INSERT INTO remote_worker_bootstrap_allowed_workspaces (
            registry_workspace_id, bootstrap_id, allowed_workspace_id
          ) VALUES (@registryWorkspaceId, @bootstrapId, @allowedWorkspaceId)
        `);
        const insertionOrder = [
          normalized.registryWorkspaceId,
          ...normalized.allowedWorkspaceIds.filter(
            (allowedWorkspaceId) => allowedWorkspaceId !== normalized.registryWorkspaceId,
          ),
        ];
        for (const allowedWorkspaceId of insertionOrder) {
          workspaceStmt.run({
            registryWorkspaceId: normalized.registryWorkspaceId,
            bootstrapId,
            allowedWorkspaceId,
          });
        }
        const capabilityStmt = this.db.prepare(`
          INSERT INTO remote_worker_bootstrap_capability_classes (
            registry_workspace_id, bootstrap_id, capability_class
          ) VALUES (@registryWorkspaceId, @bootstrapId, @capabilityClass)
        `);
        for (const capabilityClass of normalized.capabilityClasses) {
          capabilityStmt.run({ registryWorkspaceId: normalized.registryWorkspaceId, bootstrapId, capabilityClass });
        }
      } catch (error) {
        throw normalizeWriteError(error, "remote worker bootstrap");
      }
      return { disposition: "created", record: this.getBootstrap(normalized.registryWorkspaceId, bootstrapId) };
    });
  }

  public finalizeBootstrapAdmission(
    input: FinalizeRemoteWorkerBootstrapAdmissionCommand,
  ): FinalizeRemoteWorkerBootstrapAdmissionOutcome {
    const normalized = normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand(input);
    const hint = this.findBootstrapBySecretHash(normalized.bootstrapSecretSha256);
    if (!hint) throw unavailable("remote worker bootstrap");

    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(hint.registry_workspace_id, hint.worker_id);
      const bootstrapRow = this.findBootstrapBySecretHash(normalized.bootstrapSecretSha256);
      if (!bootstrapRow || bootstrapRow.bootstrap_id !== hint.bootstrap_id)
        throw unavailable("remote worker bootstrap");
      const bootstrap = this.mapBootstrap(bootstrapRow);
      this.assertExpectedBootstrapBinding(bootstrap, normalized);
      const claims = buildRemoteWorkerRuntimeCredentialClaims({
        registryWorkspaceId: bootstrap.registryWorkspaceId,
        workerId: bootstrap.workerId,
        workerGeneration: bootstrap.targetWorkerGeneration,
        allowedWorkspaceIds: bootstrap.allowedWorkspaceIds,
        capabilityClasses: bootstrap.capabilityClasses,
      });
      const exchangeRequestSha256 = sha256(
        remoteWorkerBootstrapAdmissionReplayMaterial(normalized, bootstrap.bootstrapId, claims),
      );
      const replay = this.findGenerationByExchangeIdempotency(
        bootstrap.registryWorkspaceId,
        normalized.exchangeIdempotencyKey,
      );
      if (replay) {
        assertExactReplay(replay.exchange_request_sha256, exchangeRequestSha256, "remote worker admission exchange");
        if (replay.bootstrap_id !== bootstrap.bootstrapId) throw invariantConflict("remote worker admission exchange");
        const generation = mapGeneration(replay);
        const credentialRow = this.getCredentialRowByIdempotency(
          replay.registry_workspace_id,
          replay.worker_id,
          replay.worker_generation,
          normalized.exchangeIdempotencyKey,
        );
        this.assertGenerationBootstrapBindings(generation, bootstrap);
        const credential = this.mapAuthoritativeCredential(credentialRow, generation, bootstrap);
        return {
          disposition: "replayed_without_credential_secret",
          generation,
          credential,
        };
      }

      if (bootstrap.state !== "pending") {
        throw invariantConflict("remote worker admission exchange");
      }
      this.assertVerifiedBootstrapBindings(bootstrap, normalized);
      this.assertReadmissionEvidenceRotated(bootstrap, normalized);
      if (this.findGenerationByBootstrap(bootstrap.registryWorkspaceId, bootstrap.bootstrapId)) {
        throw invariantConflict("remote worker admission exchange");
      }
      const clock = this.databaseClockWithTtl(normalized.credentialExpiresInSeconds);
      const credentialId = deriveServerId(
        "remote-worker-credential",
        bootstrap.registryWorkspaceId,
        bootstrap.workerId,
        String(bootstrap.targetWorkerGeneration),
        normalized.exchangeIdempotencyKey,
      );

      try {
        this.db
          .prepare(
            `
            INSERT INTO remote_worker_generations (
              registry_workspace_id, worker_id, node_id, worker_generation, bootstrap_id,
              public_key_spki_sha256, client_certificate_sha256, transport_identity_source,
              transport_trust_anchor_sha256, transport_verification_receipt_sha256,
              proof_of_possession_receipt_sha256, download_verification_receipt_sha256,
              installed_tree_attestation_sha256, installed_tree_verification_receipt_sha256,
              runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              exchange_idempotency_key, exchange_request_sha256, admitted_at
            ) VALUES (
              @registryWorkspaceId, @workerId, @nodeId, @workerGeneration, @bootstrapId,
              @publicKeySpkiSha256, @clientCertificateSha256, @transportIdentitySource,
              @transportTrustAnchorSha256, @transportVerificationReceiptSha256,
              @proofOfPossessionReceiptSha256, @downloadVerificationReceiptSha256,
              @installedTreeAttestationSha256, @installedTreeVerificationReceiptSha256,
              @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @exchangeIdempotencyKey, @exchangeRequestSha256, @admittedAt
            )
          `,
          )
          .run({
            registryWorkspaceId: bootstrap.registryWorkspaceId,
            workerId: bootstrap.workerId,
            nodeId: bootstrap.nodeId,
            workerGeneration: bootstrap.targetWorkerGeneration,
            bootstrapId: bootstrap.bootstrapId,
            publicKeySpkiSha256: normalized.verifiedPublicKeySpkiSha256,
            clientCertificateSha256: normalized.verifiedClientCertificateSha256,
            transportIdentitySource: normalized.verifiedTransportIdentitySource,
            transportTrustAnchorSha256: normalized.verifiedTransportTrustAnchorSha256,
            transportVerificationReceiptSha256: normalized.verifiedTransportReceiptSha256,
            proofOfPossessionReceiptSha256: normalized.verifiedProofOfPossessionReceiptSha256,
            downloadVerificationReceiptSha256: normalized.verifiedDownloadReceiptSha256,
            installedTreeAttestationSha256: normalized.verifiedInstalledTreeAttestationSha256,
            installedTreeVerificationReceiptSha256: normalized.verifiedInstalledTreeReceiptSha256,
            runtimeManifestSha256: normalized.verifiedRuntimeManifestSha256,
            workspaceCeilingSha256: normalized.verifiedWorkspaceCeilingSha256,
            capabilityCeilingSha256: normalized.verifiedCapabilityCeilingSha256,
            exchangeIdempotencyKey: normalized.exchangeIdempotencyKey,
            exchangeRequestSha256,
            admittedAt: clock.now,
          });
        this.insertCredential({
          registryWorkspaceId: bootstrap.registryWorkspaceId,
          workerId: bootstrap.workerId,
          workerGeneration: bootstrap.targetWorkerGeneration,
          credentialGeneration: 1,
          credentialId,
          tokenSha256: normalized.credentialTokenSha256,
          transportVerificationReceiptSha256: normalized.verifiedTransportReceiptSha256,
          proofOfPossessionReceiptSha256: normalized.verifiedProofOfPossessionReceiptSha256,
          claims,
          issuanceProofSha256: normalized.credentialIssuanceProofSha256,
          idempotencyKey: normalized.exchangeIdempotencyKey,
          requestSha256: exchangeRequestSha256,
          issuedAt: clock.now,
          expiresAt: clock.expiresAt,
        });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker admission exchange");
      }

      const generation = this.getGeneration(
        bootstrap.registryWorkspaceId,
        bootstrap.workerId,
        bootstrap.targetWorkerGeneration,
      );
      const credentialRow = this.getCredentialRowByIdempotency(
        generation.registryWorkspaceId,
        generation.workerId,
        generation.workerGeneration,
        normalized.exchangeIdempotencyKey,
      );
      this.assertGenerationBootstrapBindings(
        generation,
        this.getBootstrap(bootstrap.registryWorkspaceId, bootstrap.bootstrapId),
      );
      const credential = this.mapAuthoritativeCredential(credentialRow, generation, bootstrap);
      return {
        disposition: "admitted",
        generation,
        credential,
      };
    });
  }

  public rotateRuntimeCredential(
    input: RotateRemoteWorkerRuntimeCredentialCommand,
  ): RotateRemoteWorkerRuntimeCredentialOutcome {
    const normalized = normalizeRotateRemoteWorkerRuntimeCredentialCommand(input);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.registryWorkspaceId, normalized.workerId);
      const generation = this.getGeneration(
        normalized.registryWorkspaceId,
        normalized.workerId,
        normalized.workerGeneration,
      );
      const bootstrap = this.mapBootstrap(this.getBootstrapRow(generation.registryWorkspaceId, generation.bootstrapId));
      this.assertGenerationBootstrapBindings(generation, bootstrap);
      const claims = buildRemoteWorkerRuntimeCredentialClaims({
        registryWorkspaceId: bootstrap.registryWorkspaceId,
        workerId: bootstrap.workerId,
        workerGeneration: generation.workerGeneration,
        allowedWorkspaceIds: bootstrap.allowedWorkspaceIds,
        capabilityClasses: bootstrap.capabilityClasses,
      });
      const requestSha256 = sha256(remoteWorkerRuntimeCredentialRotationReplayMaterial(normalized, claims));
      const replay = this.findCredentialByIdempotency(
        normalized.registryWorkspaceId,
        normalized.workerId,
        normalized.workerGeneration,
        normalized.idempotencyKey,
      );
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, "remote worker credential rotation");
        const expectedCredential = this.findCredentialByIdentity(
          normalized.registryWorkspaceId,
          normalized.workerId,
          normalized.workerGeneration,
          normalized.expectedCredentialId,
          normalized.expectedCredentialGeneration,
        );
        if (
          !expectedCredential ||
          asPositiveInteger(replay.credential_generation) - 1 !== normalized.expectedCredentialGeneration
        ) {
          throw invariantConflict("remote worker credential rotation");
        }
        this.mapAuthoritativeCredential(expectedCredential, generation, bootstrap);
        const credential = this.mapAuthoritativeCredential(replay, generation, bootstrap);
        return { disposition: "replayed_without_credential_secret", credential };
      }

      const current = this.findLatestCredentialRow(
        generation.registryWorkspaceId,
        generation.workerId,
        generation.workerGeneration,
      );
      if (!current) throw invariantConflict("remote worker credential rotation");
      if (
        current.credential_id !== normalized.expectedCredentialId ||
        asPositiveInteger(current.credential_generation) !== normalized.expectedCredentialGeneration
      ) {
        throw invariantConflict("remote worker credential rotation");
      }
      const latestGeneration = this.findCurrentGenerationRow(normalized.registryWorkspaceId, normalized.workerId);
      const control = this.findLatestControlRow(
        normalized.registryWorkspaceId,
        normalized.workerId,
        normalized.workerGeneration,
      );
      if (
        !latestGeneration ||
        asPositiveInteger(latestGeneration.worker_generation) !== normalized.workerGeneration ||
        control ||
        !this.isTimestampFresh(current.expires_at) ||
        current.transport_verification_receipt_sha256 === normalized.verifiedTransportReceiptSha256 ||
        current.proof_of_possession_receipt_sha256 === normalized.verifiedProofOfPossessionReceiptSha256
      ) {
        throw invariantConflict("remote worker credential rotation");
      }
      this.mapAuthoritativeCredential(current, generation, bootstrap);
      const credentialGeneration = asPositiveInteger(current.credential_generation) + 1;
      const clock = this.databaseClockWithTtl(normalized.expiresInSeconds);
      const credentialId = deriveServerId(
        "remote-worker-credential",
        normalized.registryWorkspaceId,
        normalized.workerId,
        String(normalized.workerGeneration),
        normalized.idempotencyKey,
      );
      try {
        this.insertCredential({
          registryWorkspaceId: normalized.registryWorkspaceId,
          workerId: normalized.workerId,
          workerGeneration: normalized.workerGeneration,
          credentialGeneration,
          credentialId,
          tokenSha256: normalized.credentialTokenSha256,
          transportVerificationReceiptSha256: normalized.verifiedTransportReceiptSha256,
          proofOfPossessionReceiptSha256: normalized.verifiedProofOfPossessionReceiptSha256,
          claims,
          issuanceProofSha256: normalized.credentialIssuanceProofSha256,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          issuedAt: clock.now,
          expiresAt: clock.expiresAt,
        });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker credential rotation");
      }
      const credentialRow = this.getCredentialRowByIdempotency(
        normalized.registryWorkspaceId,
        normalized.workerId,
        normalized.workerGeneration,
        normalized.idempotencyKey,
      );
      return {
        disposition: "created",
        credential: this.mapAuthoritativeCredential(credentialRow, generation, bootstrap),
      };
    });
  }

  public resolveRuntimeCredentialByHash(tokenSha256: string): ResolvedRemoteWorkerRuntimeCredential | undefined {
    const normalizedTokenSha256 = digest(tokenSha256, "tokenSha256");
    const hint = this.findCredentialByTokenHash(normalizedTokenSha256);
    if (!hint) return undefined;
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(hint.registry_workspace_id, hint.worker_id);
      const row = this.db
        .prepare(
          `
          SELECT credential.* FROM remote_worker_runtime_credentials credential
          JOIN remote_worker_generations generation
            ON generation.registry_workspace_id = credential.registry_workspace_id
           AND generation.worker_id = credential.worker_id
           AND generation.worker_generation = credential.worker_generation
          WHERE credential.token_sha256 = @tokenSha256
            AND credential.purpose = 'worker_runtime'
            AND credential.worker_generation = (
              SELECT MAX(current.worker_generation) FROM remote_worker_generations current
              WHERE current.registry_workspace_id = credential.registry_workspace_id
                AND current.worker_id = credential.worker_id
            )
            AND credential.credential_generation = (
              SELECT MAX(current.credential_generation) FROM remote_worker_runtime_credentials current
              WHERE current.registry_workspace_id = credential.registry_workspace_id
                AND current.worker_id = credential.worker_id
                AND current.worker_generation = credential.worker_generation
            )
            AND ${this.freshTimestampPredicate("credential.expires_at")}
            AND NOT EXISTS (
              SELECT 1 FROM remote_worker_generation_controls control
              WHERE control.registry_workspace_id = credential.registry_workspace_id
                AND control.worker_id = credential.worker_id
                AND control.worker_generation = credential.worker_generation
            )
        `,
        )
        .get({ tokenSha256: normalizedTokenSha256 }) as CredentialRow | undefined;
      if (!row) return undefined;
      const generation = this.getGeneration(
        row.registry_workspace_id,
        row.worker_id,
        asPositiveInteger(row.worker_generation),
      );
      const bootstrap = this.mapBootstrap(this.getBootstrapRow(generation.registryWorkspaceId, generation.bootstrapId));
      this.assertGenerationBootstrapBindings(generation, bootstrap);
      const credential = this.mapAuthoritativeCredential(row, generation, bootstrap);
      return {
        generation,
        credential,
        allowedWorkspaceIds: [...bootstrap.allowedWorkspaceIds],
        capabilityClasses: [...bootstrap.capabilityClasses],
      };
    });
  }

  public quarantineGeneration(input: RemoteWorkerGenerationControlInput): RemoteWorkerGenerationControlRecord {
    return this.controlGeneration("quarantine", input);
  }

  public revokeGeneration(input: RemoteWorkerGenerationControlInput): RemoteWorkerGenerationControlRecord {
    return this.controlGeneration("revoke", input);
  }

  public getBootstrap(registryWorkspaceId: string, bootstrapId: string): RemoteWorkerBootstrapRecord {
    const row = this.getBootstrapRow(
      identifier(registryWorkspaceId, "registryWorkspaceId"),
      identifier(bootstrapId, "bootstrapId"),
    );
    return this.mapBootstrap(row);
  }

  public findCurrentGeneration(
    registryWorkspaceId: string,
    workerId: string,
  ): RemoteWorkerGenerationRecord | undefined {
    const row = this.findCurrentGenerationRow(
      identifier(registryWorkspaceId, "registryWorkspaceId"),
      identifier(workerId, "workerId"),
    );
    return row ? this.mapAuthoritativeGeneration(row) : undefined;
  }

  public listWorkers(registryWorkspaceId: string, options: ListRemoteWorkersOptions = {}): ListRemoteWorkersResult {
    const workspace = identifier(registryWorkspaceId, "registryWorkspaceId");
    const limit = options.limit === undefined ? 50 : boundedInteger(options.limit, "limit", 200);
    const cursor = options.cursor === undefined ? "" : identifier(options.cursor, "cursor");
    const rows = this.db
      .prepare(
        `
        SELECT generation.* FROM remote_worker_generations generation
        WHERE generation.registry_workspace_id = @registryWorkspaceId
          AND generation.worker_id > @cursor
          AND generation.worker_generation = (
            SELECT MAX(current.worker_generation) FROM remote_worker_generations current
            WHERE current.registry_workspace_id = generation.registry_workspace_id
              AND current.worker_id = generation.worker_id
          )
        ORDER BY generation.worker_id ASC
        LIMIT @fetchLimit
      `,
      )
      .all({ registryWorkspaceId: workspace, cursor, fetchLimit: limit + 1 }) as GenerationRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const items = selected.map((row) => this.mapAuthoritativeGeneration(row));
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1)!.workerId } : {}),
    };
  }

  public findWorkerRegistryEntry(
    registryWorkspaceId: string,
    workerId: string,
  ): RemoteWorkerRegistryRecord | undefined {
    const row = this.db
      .prepare(
        `${REMOTE_WORKER_REGISTRY_SELECT}
         WHERE generation.registry_workspace_id = @registryWorkspaceId
           AND generation.worker_id = @workerId
         ORDER BY generation.worker_generation DESC
         LIMIT 1`,
      )
      .get({
        registryWorkspaceId: identifier(registryWorkspaceId, "registryWorkspaceId"),
        workerId: identifier(workerId, "workerId"),
      }) as RegistryRow | undefined;
    return row ? mapRegistryRow(row) : undefined;
  }

  public listWorkerRegistry(
    registryWorkspaceId: string,
    options: ListRemoteWorkersOptions = {},
  ): ListRemoteWorkerRegistryResult {
    const workspace = identifier(registryWorkspaceId, "registryWorkspaceId");
    const limit =
      options.limit === undefined
        ? REMOTE_WORKER_REGISTRY_DEFAULT_LIMIT
        : boundedInteger(options.limit, "limit", REMOTE_WORKER_REGISTRY_MAX_LIMIT);
    const cursor = options.cursor === undefined ? "" : identifier(options.cursor, "cursor");
    const rows = this.db
      .prepare(
        `${REMOTE_WORKER_REGISTRY_SELECT}
         WHERE generation.registry_workspace_id = @registryWorkspaceId
           AND generation.worker_id > @cursor
           AND generation.worker_generation = (
             SELECT MAX(latest_generation.worker_generation)
             FROM remote_worker_generations latest_generation
             WHERE latest_generation.registry_workspace_id = generation.registry_workspace_id
               AND latest_generation.worker_id = generation.worker_id
           )
         ORDER BY generation.worker_id ASC
         LIMIT @fetchLimit`,
      )
      .all({ registryWorkspaceId: workspace, cursor, fetchLimit: limit + 1 }) as RegistryRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const items = selected.map(mapRegistryRow);
    return Object.freeze({
      items: Object.freeze(items),
      ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1)!.admission.workerId } : {}),
    });
  }

  private controlGeneration(
    action: "quarantine" | "revoke",
    input: RemoteWorkerGenerationControlInput,
  ): RemoteWorkerGenerationControlRecord {
    const normalized = normalizeRemoteWorkerGenerationControlInput(input);
    const requestSha256 = sha256({ action, ...normalized });
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.registryWorkspaceId, normalized.workerId);
      const replay = this.findControlByIdempotency(normalized.registryWorkspaceId, normalized.idempotencyKey);
      if (replay) {
        assertExactReplay(replay.request_sha256, requestSha256, `remote worker generation ${action}`);
        return mapControl(replay);
      }
      this.getGeneration(normalized.registryWorkspaceId, normalized.workerId, normalized.workerGeneration);
      const latestGeneration = this.findCurrentGenerationRow(normalized.registryWorkspaceId, normalized.workerId);
      if (!latestGeneration || asPositiveInteger(latestGeneration.worker_generation) !== normalized.workerGeneration) {
        throw invariantConflict(`remote worker generation ${action}`);
      }
      const current = this.findLatestControlRow(
        normalized.registryWorkspaceId,
        normalized.workerId,
        normalized.workerGeneration,
      );
      if (
        (action === "quarantine" && current !== undefined) ||
        (action === "revoke" &&
          current !== undefined &&
          !(asPositiveInteger(current.control_revision) === 1 && current.action === "quarantine"))
      ) {
        throw invariantConflict(`remote worker generation ${action}`);
      }
      const controlRevision = current ? asPositiveInteger(current.control_revision) + 1 : 1;
      try {
        this.db
          .prepare(
            `
            INSERT INTO remote_worker_generation_controls (
              registry_workspace_id, worker_id, worker_generation, control_revision, action,
              reason_code, reason_sha256, actor_id, idempotency_key, request_sha256, created_at
            ) VALUES (
              @registryWorkspaceId, @workerId, @workerGeneration, @controlRevision, @action,
              @reasonCode, @reasonSha256, @actorId, @idempotencyKey, @requestSha256, @createdAt
            )
          `,
          )
          .run({ ...normalized, action, controlRevision, requestSha256, createdAt: this.databaseNow() });
      } catch (error) {
        throw normalizeWriteError(error, `remote worker generation ${action}`);
      }
      return mapControl(
        this.getControlRow(
          normalized.registryWorkspaceId,
          normalized.workerId,
          normalized.workerGeneration,
          controlRevision,
        ),
      );
    });
  }

  private insertCredential(input: {
    registryWorkspaceId: string;
    workerId: string;
    workerGeneration: number;
    credentialGeneration: number;
    credentialId: string;
    tokenSha256: string;
    transportVerificationReceiptSha256: string;
    proofOfPossessionReceiptSha256: string;
    claims: RemoteWorkerRuntimeCredentialClaims;
    issuanceProofSha256: string;
    idempotencyKey: string;
    requestSha256: string;
    issuedAt: string;
    expiresAt: string;
  }): void {
    const { claims, ...bindings } = input;
    const claimsJson = canonicalJsonString(claims);
    const claimsSha256 = sha256Bytes(claimsJson);
    this.db
      .prepare(
        `
        INSERT INTO remote_worker_runtime_credentials (
          registry_workspace_id, worker_id, worker_generation, credential_generation,
          credential_id, purpose, token_sha256, transport_verification_receipt_sha256,
          proof_of_possession_receipt_sha256, claims_json, claims_sha256, issuance_proof_sha256,
          idempotency_key, request_sha256, issued_at, expires_at
        ) VALUES (
          @registryWorkspaceId, @workerId, @workerGeneration, @credentialGeneration,
          @credentialId, 'worker_runtime', @tokenSha256, @transportVerificationReceiptSha256,
          @proofOfPossessionReceiptSha256, @claimsJson, @claimsSha256, @issuanceProofSha256,
          @idempotencyKey, @requestSha256, @issuedAt, @expiresAt
        )
      `,
      )
      .run({ ...bindings, claimsJson, claimsSha256 });
  }

  private assertVerifiedBootstrapBindings(
    bootstrap: RemoteWorkerBootstrapRecord,
    input: ReturnType<typeof normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand>,
  ): void {
    const matches =
      sha256Bytes(canonicalJsonString(bootstrap.runtimeManifest)) === input.verifiedRuntimeManifestSha256 &&
      bootstrap.workspaceCeilingSha256 === input.verifiedWorkspaceCeilingSha256 &&
      bootstrap.capabilityCeilingSha256 === input.verifiedCapabilityCeilingSha256;
    if (!matches) throw invariantConflict("remote worker admission exchange");
  }

  private assertExpectedBootstrapBinding(
    bootstrap: RemoteWorkerBootstrapRecord,
    input: ReturnType<typeof normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand>,
  ): void {
    if (
      bootstrap.registryWorkspaceId !== input.expectedRegistryWorkspaceId ||
      bootstrap.bootstrapId !== input.expectedBootstrapId ||
      bootstrap.targetWorkerGeneration !== input.expectedTargetWorkerGeneration
    ) {
      throw invariantConflict("remote worker admission exchange");
    }
  }

  private assertReadmissionEvidenceRotated(
    bootstrap: RemoteWorkerBootstrapRecord,
    input: ReturnType<typeof normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand>,
  ): void {
    if (bootstrap.targetWorkerGeneration === 1) return;
    const prior = this.getGeneration(
      bootstrap.registryWorkspaceId,
      bootstrap.workerId,
      bootstrap.targetWorkerGeneration - 1,
    );
    if (
      prior.nodeId !== bootstrap.nodeId ||
      prior.publicKeySpkiSha256 === input.verifiedPublicKeySpkiSha256 ||
      prior.clientCertificateSha256 === input.verifiedClientCertificateSha256 ||
      prior.installedTreeAttestationSha256 === input.verifiedInstalledTreeAttestationSha256
    ) {
      throw invariantConflict("remote worker admission exchange");
    }
  }

  private assertGenerationBootstrapBindings(
    generation: RemoteWorkerGenerationRecord,
    bootstrap: RemoteWorkerBootstrapRecord,
  ): void {
    if (
      bootstrap.state !== "consumed" ||
      generation.registryWorkspaceId !== bootstrap.registryWorkspaceId ||
      generation.workerId !== bootstrap.workerId ||
      generation.nodeId !== bootstrap.nodeId ||
      generation.workerGeneration !== bootstrap.targetWorkerGeneration ||
      generation.bootstrapId !== bootstrap.bootstrapId ||
      generation.runtimeManifestSha256 !== sha256Bytes(canonicalJsonString(bootstrap.runtimeManifest)) ||
      generation.workspaceCeilingSha256 !== bootstrap.workspaceCeilingSha256 ||
      generation.capabilityCeilingSha256 !== bootstrap.capabilityCeilingSha256
    ) {
      throw invalidState();
    }
  }

  private mapAuthoritativeGeneration(row: GenerationRow): RemoteWorkerGenerationRecord {
    const generation = mapGeneration(row);
    const bootstrap = this.mapBootstrap(this.getBootstrapRow(generation.registryWorkspaceId, generation.bootstrapId));
    this.assertGenerationBootstrapBindings(generation, bootstrap);
    return generation;
  }

  private mapAuthoritativeCredential(
    row: CredentialRow,
    generation: RemoteWorkerGenerationRecord,
    bootstrap: RemoteWorkerBootstrapRecord,
  ): RemoteWorkerRuntimeCredentialRecord {
    const credential = mapCredential(row);
    this.assertCredentialAuthority(credential, generation, bootstrap);
    if (
      credential.credentialGeneration === 1 &&
      (row.idempotency_key !== generation.exchangeIdempotencyKey ||
        row.request_sha256 !== generation.exchangeRequestSha256 ||
        row.transport_verification_receipt_sha256 !== generation.transportVerificationReceiptSha256 ||
        row.proof_of_possession_receipt_sha256 !== generation.proofOfPossessionReceiptSha256)
    ) {
      throw invalidState();
    }
    return credential;
  }

  private assertCredentialAuthority(
    credential: RemoteWorkerRuntimeCredentialRecord,
    generation: RemoteWorkerGenerationRecord,
    bootstrap: RemoteWorkerBootstrapRecord,
  ): void {
    const expectedClaims = buildRemoteWorkerRuntimeCredentialClaims({
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      workerGeneration: generation.workerGeneration,
      allowedWorkspaceIds: bootstrap.allowedWorkspaceIds,
      capabilityClasses: bootstrap.capabilityClasses,
    });
    if (
      credential.registryWorkspaceId !== generation.registryWorkspaceId ||
      credential.workerId !== generation.workerId ||
      credential.workerGeneration !== generation.workerGeneration ||
      canonicalJsonString(credential.claims) !== canonicalJsonString(expectedClaims)
    ) {
      throw invalidState();
    }
  }

  private mapBootstrap(row: BootstrapRow): RemoteWorkerBootstrapRecord {
    try {
      digest(row.bootstrap_secret_sha256, "bootstrapSecretSha256");
      const runtimeManifest = safeJsonParse<unknown>(row.runtime_manifest_json, undefined);
      if (!runtimeManifest || canonicalJsonString(runtimeManifest) !== row.runtime_manifest_json) throw new Error();
      const consumed = Boolean(this.findGenerationByBootstrap(row.registry_workspace_id, row.bootstrap_id));
      const expired = !this.isTimestampFresh(row.expires_at);
      const record: RemoteWorkerBootstrapRecord = {
        registryWorkspaceId: row.registry_workspace_id,
        bootstrapId: row.bootstrap_id,
        workerId: row.worker_id,
        nodeId: row.node_id,
        targetWorkerGeneration: asPositiveInteger(row.target_worker_generation),
        workerLabel: row.worker_label,
        platform: row.platform,
        architecture: row.architecture,
        runtimeManifest: runtimeManifest as RemoteWorkerBootstrapRecord["runtimeManifest"],
        allowedWorkspaceIds: this.readAllowedWorkspaceIds(row.registry_workspace_id, row.bootstrap_id),
        workspaceCeilingSha256: row.workspace_ceiling_sha256,
        capabilityClasses: this.readCapabilityClasses(row.registry_workspace_id, row.bootstrap_id),
        capabilityCeilingSha256: row.capability_ceiling_sha256,
        state: consumed ? "consumed" : expired ? "expired" : "pending",
        expiresAt: row.expires_at,
        createdByActorId: row.created_by_actor_id,
        idempotencyKey: row.idempotency_key,
        requestSha256: row.request_sha256,
        createdAt: row.created_at,
      };
      if (
        record.allowedWorkspaceIds.length !== asPositiveInteger(row.allowed_workspace_count) ||
        record.capabilityClasses.length !== asPositiveInteger(row.capability_class_count) ||
        sha256(record.allowedWorkspaceIds) !== row.workspace_ceiling_sha256 ||
        sha256(record.capabilityClasses) !== row.capability_ceiling_sha256 ||
        sha256Bytes(row.runtime_manifest_json) !== row.runtime_manifest_sha256
      ) {
        throw new Error();
      }
      assertRemoteWorkerBootstrapRecord(record);
      return record;
    } catch {
      throw invalidState();
    }
  }

  private getGeneration(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number | bigint | string,
  ): RemoteWorkerGenerationRecord {
    const row = this.db
      .prepare(
        `
        SELECT * FROM remote_worker_generations
        WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
          AND worker_generation = @workerGeneration
      `,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration: asPositiveInteger(workerGeneration) }) as
      | GenerationRow
      | undefined;
    if (!row) throw unavailable("remote worker generation");
    return mapGeneration(row);
  }

  private getBootstrapRow(registryWorkspaceId: string, bootstrapId: string): BootstrapRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_bootstrap_requests
         WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId`,
      )
      .get({ registryWorkspaceId, bootstrapId }) as BootstrapRow | undefined;
    if (!row) throw unavailable("remote worker bootstrap");
    return row;
  }

  private getCredentialRowByIdempotency(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number | bigint | string,
    idempotencyKey: string,
  ): CredentialRow {
    const row = this.findCredentialByIdempotency(
      registryWorkspaceId,
      workerId,
      asPositiveInteger(workerGeneration),
      idempotencyKey,
    );
    if (!row) throw invalidState();
    return row;
  }

  private getControlRow(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
    controlRevision: number,
  ): ControlRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_generation_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration AND control_revision = @controlRevision`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration, controlRevision }) as ControlRow | undefined;
    if (!row) throw invalidState();
    return row;
  }

  private findBootstrapByIdempotency(registryWorkspaceId: string, idempotencyKey: string): BootstrapRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_bootstrap_requests
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as BootstrapRow | undefined;
  }

  private findBootstrapBySecretHash(bootstrapSecretSha256: string): BootstrapRow | undefined {
    return this.db
      .prepare("SELECT * FROM remote_worker_bootstrap_requests WHERE bootstrap_secret_sha256 = @bootstrapSecretSha256")
      .get({ bootstrapSecretSha256 }) as BootstrapRow | undefined;
  }

  private findGenerationByExchangeIdempotency(
    registryWorkspaceId: string,
    exchangeIdempotencyKey: string,
  ): GenerationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_generations
         WHERE registry_workspace_id = @registryWorkspaceId
           AND exchange_idempotency_key = @exchangeIdempotencyKey`,
      )
      .get({ registryWorkspaceId, exchangeIdempotencyKey }) as GenerationRow | undefined;
  }

  private findGenerationByBootstrap(registryWorkspaceId: string, bootstrapId: string): GenerationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_generations
         WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId`,
      )
      .get({ registryWorkspaceId, bootstrapId }) as GenerationRow | undefined;
  }

  private findCurrentGenerationRow(registryWorkspaceId: string, workerId: string): GenerationRow | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM remote_worker_generations
        WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
        ORDER BY worker_generation DESC LIMIT 1
      `,
      )
      .get({ registryWorkspaceId, workerId }) as GenerationRow | undefined;
  }

  private findCredentialByIdempotency(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
    idempotencyKey: string,
  ): CredentialRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_runtime_credentials
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration, idempotencyKey }) as CredentialRow | undefined;
  }

  private findCredentialByTokenHash(tokenSha256: string): CredentialRow | undefined {
    return this.db
      .prepare("SELECT * FROM remote_worker_runtime_credentials WHERE token_sha256 = @tokenSha256")
      .get({ tokenSha256 }) as CredentialRow | undefined;
  }

  private findCredentialByIdentity(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
    credentialId: string,
    credentialGeneration: number,
  ): CredentialRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_runtime_credentials
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration AND credential_id = @credentialId
           AND credential_generation = @credentialGeneration`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration, credentialId, credentialGeneration }) as
      | CredentialRow
      | undefined;
  }

  private findLatestCredentialRow(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
  ): CredentialRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_runtime_credentials
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration
         ORDER BY credential_generation DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration }) as CredentialRow | undefined;
  }

  private findControlByIdempotency(registryWorkspaceId: string, idempotencyKey: string): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_generation_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as ControlRow | undefined;
  }

  private findLatestControlRow(
    registryWorkspaceId: string,
    workerId: string,
    workerGeneration: number,
  ): ControlRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_generation_controls
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration
         ORDER BY control_revision DESC LIMIT 1`,
      )
      .get({ registryWorkspaceId, workerId, workerGeneration }) as ControlRow | undefined;
  }

  private readAllowedWorkspaceIds(registryWorkspaceId: string, bootstrapId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT allowed_workspace_id FROM remote_worker_bootstrap_allowed_workspaces
           WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId
           ORDER BY allowed_workspace_id ASC`,
        )
        .all({ registryWorkspaceId, bootstrapId }) as Array<{ allowed_workspace_id?: unknown }>
    )
      .map((row) => {
        if (typeof row.allowed_workspace_id !== "string") throw invalidState();
        return row.allowed_workspace_id;
      })
      .sort(compareRemoteWorkerCanonicalIdentifiers);
  }

  private readCapabilityClasses(registryWorkspaceId: string, bootstrapId: string): RemoteWorkerCapabilityClass[] {
    return (
      this.db
        .prepare(
          `SELECT capability_class FROM remote_worker_bootstrap_capability_classes
           WHERE registry_workspace_id = @registryWorkspaceId AND bootstrap_id = @bootstrapId
           ORDER BY capability_class ASC`,
        )
        .all({ registryWorkspaceId, bootstrapId }) as Array<{ capability_class?: unknown }>
    )
      .map((row) => {
        if (typeof row.capability_class !== "string") throw invalidState();
        return row.capability_class as RemoteWorkerCapabilityClass;
      })
      .sort(compareRemoteWorkerCanonicalIdentifiers);
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get() as { now?: unknown } | undefined;
    if (typeof row?.now !== "string") throw invalidState();
    return row.now;
  }

  private databaseClockWithTtl(seconds: number): { now: string; expiresAt: string } {
    const sql =
      this.db.dialect === "postgres"
        ? `WITH captured AS (SELECT clock_timestamp() AS now)
           SELECT
             to_char(captured.now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
             to_char((captured.now + (@seconds * interval '1 second')) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
           FROM captured`
        : `SELECT
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', @seconds)) AS expires_at`;
    const row = this.db.prepare(sql).get({ seconds }) as { now?: unknown; expires_at?: unknown } | undefined;
    if (typeof row?.now !== "string" || typeof row.expires_at !== "string") throw invalidState();
    return { now: row.now, expiresAt: row.expires_at };
  }

  private isTimestampFresh(value: string): boolean {
    const row = this.db
      .prepare(`SELECT CASE WHEN ${this.freshTimestampPredicate("@value")} THEN 1 ELSE 0 END AS fresh`)
      .get({ value }) as { fresh?: unknown } | undefined;
    return Number(row?.fresh) === 1;
  }

  private freshTimestampPredicate(expression: string): string {
    return this.db.dialect === "postgres"
      ? `gc_try_parse_timestamptz(${expression}) IS NOT NULL
         AND to_char(gc_try_parse_timestamptz(${expression}) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${expression}
         AND gc_try_parse_timestamptz(${expression}) > clock_timestamp()`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') IS NOT NULL
         AND strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') = ${expression}
         AND ${expression} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  private acquirePostgresAdmissionLocks(registryWorkspaceId: string, workerId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @workerId, 502)) AS locked",
      )
      .get({ registryWorkspaceId, workerId });
  }
}

function mapGeneration(row: GenerationRow): RemoteWorkerGenerationRecord {
  try {
    const record: RemoteWorkerGenerationRecord = {
      registryWorkspaceId: row.registry_workspace_id,
      workerId: row.worker_id,
      nodeId: row.node_id,
      workerGeneration: asPositiveInteger(row.worker_generation),
      bootstrapId: row.bootstrap_id,
      publicKeySpkiSha256: row.public_key_spki_sha256,
      clientCertificateSha256: row.client_certificate_sha256,
      transportIdentitySource: row.transport_identity_source as RemoteWorkerGenerationRecord["transportIdentitySource"],
      transportTrustAnchorSha256: row.transport_trust_anchor_sha256,
      transportVerificationReceiptSha256: row.transport_verification_receipt_sha256,
      proofOfPossessionReceiptSha256: row.proof_of_possession_receipt_sha256,
      downloadVerificationReceiptSha256: row.download_verification_receipt_sha256,
      installedTreeAttestationSha256: row.installed_tree_attestation_sha256,
      installedTreeVerificationReceiptSha256: row.installed_tree_verification_receipt_sha256,
      runtimeManifestSha256: row.runtime_manifest_sha256,
      workspaceCeilingSha256: row.workspace_ceiling_sha256,
      capabilityCeilingSha256: row.capability_ceiling_sha256,
      exchangeIdempotencyKey: row.exchange_idempotency_key,
      exchangeRequestSha256: row.exchange_request_sha256,
      admittedAt: row.admitted_at,
    };
    assertRemoteWorkerGenerationRecord(record);
    return record;
  } catch {
    throw invalidState();
  }
}

function mapRegistryRow(row: RegistryRow): RemoteWorkerRegistryRecord {
  try {
    const workerGeneration = asPositiveInteger(row.worker_generation);
    if (
      row.bootstrap_worker_id !== row.worker_id ||
      row.bootstrap_node_id !== row.node_id ||
      asPositiveInteger(row.bootstrap_target_worker_generation) !== workerGeneration ||
      row.bootstrap_runtime_manifest_sha256 !== row.runtime_manifest_sha256 ||
      row.bootstrap_workspace_ceiling_sha256 !== row.workspace_ceiling_sha256 ||
      row.bootstrap_capability_ceiling_sha256 !== row.capability_ceiling_sha256
    ) {
      throw new Error();
    }
    const admission: RemoteWorkerRegistryAdmission = {
      registryWorkspaceId: row.registry_workspace_id,
      workerId: row.worker_id,
      nodeId: row.node_id,
      workerGeneration,
      workerLabel: row.bootstrap_worker_label,
      platform: row.bootstrap_platform as RemoteWorkerRegistryAdmission["platform"],
      architecture: row.bootstrap_architecture as RemoteWorkerRegistryAdmission["architecture"],
      allowedWorkspaceCount: asPositiveInteger(row.bootstrap_allowed_workspace_count),
      workspaceCeilingSha256: row.workspace_ceiling_sha256,
      capabilityClassCount: asPositiveInteger(row.bootstrap_capability_class_count),
      capabilityCeilingSha256: row.capability_ceiling_sha256,
      publicKeySpkiSha256: row.public_key_spki_sha256,
      clientCertificateSha256: row.client_certificate_sha256,
      runtimeManifestSha256: row.runtime_manifest_sha256,
      transportIdentitySource:
        row.transport_identity_source as RemoteWorkerRegistryAdmission["transportIdentitySource"],
      transportTrustAnchorSha256: row.transport_trust_anchor_sha256,
      transportVerificationReceiptSha256: row.transport_verification_receipt_sha256,
      proofOfPossessionReceiptSha256: row.proof_of_possession_receipt_sha256,
      downloadVerificationReceiptSha256: row.download_verification_receipt_sha256,
      installedTreeAttestationSha256: row.installed_tree_attestation_sha256,
      installedTreeVerificationReceiptSha256: row.installed_tree_verification_receipt_sha256,
      admittedAt: row.admitted_at,
    };
    assertRemoteWorkerRegistryAdmission(admission);

    const controlValues = [
      row.control_worker_generation,
      row.control_revision,
      row.control_action,
      row.control_created_at,
    ];
    const hasControl = controlValues.some((value) => value !== null && value !== undefined);
    if (hasControl !== controlValues.every((value) => value !== null && value !== undefined)) throw new Error();
    let control: RemoteWorkerRegistryControl | undefined;
    if (hasControl) {
      control = {
        workerGeneration: asPositiveInteger(row.control_worker_generation!),
        controlRevision: asPositiveInteger(row.control_revision!),
        action: row.control_action as RemoteWorkerRegistryControl["action"],
        createdAt: row.control_created_at!,
      };
      assertRemoteWorkerRegistryControl(control);
      if (control.workerGeneration !== workerGeneration) throw new Error();
      Object.freeze(control);
    }
    return Object.freeze({
      admission: Object.freeze(admission),
      ...(control ? { control } : {}),
    });
  } catch {
    throw invalidState();
  }
}

function mapCredential(row: CredentialRow): RemoteWorkerRuntimeCredentialRecord {
  try {
    digest(row.token_sha256, "tokenSha256");
    digest(row.transport_verification_receipt_sha256, "transportVerificationReceiptSha256");
    digest(row.proof_of_possession_receipt_sha256, "proofOfPossessionReceiptSha256");
    const claims = safeJsonParse<unknown>(row.claims_json, undefined);
    if (
      !claims ||
      canonicalJsonString(claims) !== row.claims_json ||
      sha256Bytes(row.claims_json) !== row.claims_sha256
    ) {
      throw new Error();
    }
    const record: RemoteWorkerRuntimeCredentialRecord = {
      registryWorkspaceId: row.registry_workspace_id,
      workerId: row.worker_id,
      workerGeneration: asPositiveInteger(row.worker_generation),
      credentialGeneration: asPositiveInteger(row.credential_generation),
      credentialId: row.credential_id,
      purpose: row.purpose as typeof REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
      claims: claims as RemoteWorkerRuntimeCredentialClaims,
      claimsSha256: row.claims_sha256,
      issuanceProofSha256: row.issuance_proof_sha256,
      idempotencyKey: row.idempotency_key,
      requestSha256: row.request_sha256,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
    assertRemoteWorkerRuntimeCredentialRecord(record);
    return record;
  } catch {
    throw invalidState();
  }
}

function mapControl(row: ControlRow): RemoteWorkerGenerationControlRecord {
  try {
    const record: RemoteWorkerGenerationControlRecord = {
      registryWorkspaceId: row.registry_workspace_id,
      workerId: row.worker_id,
      workerGeneration: asPositiveInteger(row.worker_generation),
      controlRevision: asPositiveInteger(row.control_revision),
      action: row.action as RemoteWorkerGenerationControlRecord["action"],
      reasonCode: row.reason_code,
      reasonSha256: row.reason_sha256,
      actorId: row.actor_id,
      idempotencyKey: row.idempotency_key,
      requestSha256: row.request_sha256,
      createdAt: row.created_at,
    };
    assertRemoteWorkerGenerationControlRecord(record);
    return record;
  } catch {
    throw invalidState();
  }
}

function deriveServerId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts).slice(0, 48)}`;
}

function sha256(value: unknown): string {
  return sha256Bytes(canonicalJsonString(value));
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertExactReplay(storedSha256: string, requestSha256: string, label: string): void {
  if (storedSha256 !== requestSha256) throw invariantConflict(label);
}

function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `Remote worker ${field} is invalid.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({ field, message: `Remote worker ${field} must be a lower-case SHA-256 digest.` });
  }
  return value;
}

function boundedInteger(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError({ field, message: `Remote worker ${field} must be between 1 and ${max}.` });
  }
  return value;
}

function asPositiveInteger(value: number | bigint | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidState();
  return parsed;
}

function unavailable(entity: string): NotFoundError {
  return new NotFoundError({ entity, id: "unavailable" });
}

function invariantConflict(label: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message: `${label} conflicts with durable admission authority.`,
    details: { reason: "remote_worker_admission_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError)
    return error;
  return invariantConflict(label);
}

function invalidState(): Error {
  return new Error("Remote worker admission state is invalid.");
}
