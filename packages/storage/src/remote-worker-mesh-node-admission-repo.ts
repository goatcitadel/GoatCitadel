/* eslint-disable max-lines -- M3 keeps cross-dialect authority, replay, nonce, and HX-408 admission in one audited transaction owner. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_ATTEMPT_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_PROVENANCE,
  ValidationError,
  canonicalJsonString,
  normalizeRemoteWorkerMeshNodeAdmissionAttemptRecord,
  normalizeRemoteWorkerMeshNodeAdmissionBindingRecord,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  normalizeRemoteWorkerMeshNodeJoinAuthorityRecord,
  normalizeRemoteWorkerMeshNodeJoinAuthorityRevocationRecord,
  remoteWorkerMeshNodeStableEffectSha256,
  type RemoteWorkerMeshNodeAdmissionAttemptRecord,
  type RemoteWorkerMeshNodeAdmissionBindingRecord,
  type RemoteWorkerMeshNodeAuthorityFence,
  type RemoteWorkerMeshNodeJoinAuthorityRecord,
  type RemoteWorkerMeshNodeJoinAuthorityRevocationRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerNonceRepository, type RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";

export interface RemoteWorkerMeshNodeVerifiedM2FenceInput {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly clientCertificateSha256: string;
  readonly protectedAdmissionEnvelopeSha256: string;
  readonly protectedAdmissionContextSha256: string;
}

export interface IssueRemoteWorkerMeshNodeJoinAuthorityInput extends RemoteWorkerMeshNodeVerifiedM2FenceInput {
  readonly workspaceId: string;
  readonly expiresInSeconds: number;
  readonly issuedByActorId: string;
  readonly idempotencyKey: string;
  /** Secret-once credential. Storage hashes it and never persists the plaintext. */
  readonly rawMeshNodeCredential: string;
}

export interface IssueRemoteWorkerMeshNodeJoinAuthorityOutcome {
  readonly disposition: "created" | "replayed_without_secret";
  readonly authority: RemoteWorkerMeshNodeJoinAuthorityRecord;
  readonly meshNodeCredential?: string;
  readonly secretDisposition: "returned_once" | "not_recoverable";
}

export interface RevokeRemoteWorkerMeshNodeJoinAuthorityInput {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly joinAuthorityGeneration: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly revokedByActorId: string;
  readonly idempotencyKey: string;
}

export interface AdmitRemoteWorkerMeshNodeCommand {
  readonly workspaceId: string;
  readonly rawMeshNodeCredential: string;
  readonly clientCertificateSha256: string;
  readonly method: "POST";
  readonly rawPath: string;
  readonly operation: string;
  readonly protocolBodySha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly tlsExporterSha256: string;
  readonly idempotencyKey: string;
}

export interface AdmitRemoteWorkerMeshNodeWithNonceInput {
  readonly nonce: RemoteWorkerNonceConsumeInput;
  readonly command: AdmitRemoteWorkerMeshNodeCommand;
}

export interface RemoteWorkerMeshNodeAdmissionRecord {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly joinCredentialSha256: string;
  readonly mtlsRequired: true;
  readonly tlsFingerprint: string;
  readonly provenance: "remote_worker";
  readonly admittedByActorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly admittedAt: string;
}

export interface AdmitRemoteWorkerMeshNodeOutcome {
  readonly disposition: "admitted" | "replayed";
  readonly admission: RemoteWorkerMeshNodeAdmissionRecord;
  readonly binding: RemoteWorkerMeshNodeAdmissionBindingRecord;
  readonly attempt: RemoteWorkerMeshNodeAdmissionAttemptRecord;
  readonly stableEffectSha256: string;
}

export interface ResolveRemoteWorkerMeshNodeAdmissionInput {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
}

export type RemoteWorkerMeshNodeAdmissionUnavailableReason =
  | "missing_remote_binding"
  | "authority_revoked"
  | "authority_superseded"
  | "authority_expired"
  | "credential_expired_or_rotated"
  | "worker_generation_controlled"
  | "protected_evidence_unavailable"
  | "admission_revoked_or_superseded";

export type RemoteWorkerMeshNodeAdmissionResolution =
  | {
      readonly disposition: "legacy";
      readonly provenance: "legacy";
      readonly admission: RemoteWorkerMeshNodeAdmissionRecordBase;
    }
  | {
      readonly disposition: "current";
      readonly provenance: "remote_worker";
      readonly admission: RemoteWorkerMeshNodeAdmissionRecord;
      readonly binding: RemoteWorkerMeshNodeAdmissionBindingRecord;
      readonly fence: RemoteWorkerMeshNodeAuthorityFence;
    }
  | {
      readonly disposition: "unavailable";
      readonly provenance: "remote_worker";
      readonly reason: RemoteWorkerMeshNodeAdmissionUnavailableReason;
      readonly admission: RemoteWorkerMeshNodeAdmissionRecordBase;
      readonly binding?: RemoteWorkerMeshNodeAdmissionBindingRecord;
    };

export interface CompareRemoteWorkerMeshNodeAuthorityFenceInput extends ResolveRemoteWorkerMeshNodeAdmissionInput {
  readonly expected?: RemoteWorkerMeshNodeAuthorityFence;
}

interface RemoteWorkerMeshNodeAdmissionRecordBase {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly joinCredentialSha256: string;
  readonly mtlsRequired: boolean;
  readonly tlsFingerprint?: string;
  readonly provenance: "legacy" | "remote_worker";
  readonly admittedByActorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly admittedAt: string;
}

interface AuthorityRow {
  registry_workspace_id: string;
  bootstrap_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  credential_id: string;
  credential_generation: number | bigint | string;
  runtime_credential_token_sha256: string;
  protected_evidence_envelope_sha256: string;
  protected_evidence_context_sha256: string;
  node_id: string;
  workspace_id: string;
  join_authority_generation: number | bigint | string;
  target_admission_generation: number | bigint | string;
  join_credential_sha256: string;
  client_certificate_sha256: string;
  issued_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  issued_at: string;
  expires_at: string;
}

interface RevocationRow {
  registry_workspace_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  workspace_id: string;
  join_authority_generation: number | bigint | string;
  reason_code: string;
  reason_sha256: string;
  revoked_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  revoked_at: string;
}

interface AdmissionRow {
  workspace_id: string;
  node_id: string;
  admission_generation: number | bigint | string;
  join_token_sha256: string;
  mtls_required: number | bigint | string | boolean;
  tls_fingerprint: string | null;
  provenance_kind: string;
  admitted_by_actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  admitted_at: string;
}

interface BindingRow {
  workspace_id: string;
  node_id: string;
  admission_generation: number | bigint | string;
  provenance_kind: string;
  registry_workspace_id: string;
  bootstrap_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  credential_id: string;
  credential_generation: number | bigint | string;
  runtime_credential_token_sha256: string;
  protected_evidence_envelope_sha256: string;
  protected_evidence_context_sha256: string;
  join_authority_generation: number | bigint | string;
  join_credential_sha256: string;
  client_certificate_sha256: string;
  stable_effect_sha256: string;
  admitted_by_actor_id: string;
  idempotency_key: string;
  bound_at: string;
}

interface AttemptRow {
  nonce_sha256: string;
  protocol_body_sha256: string;
  transport_receipt_sha256: string;
  proof_of_possession_receipt_sha256: string;
  attempted_at: string;
}

interface CurrentAuthorityState {
  current: boolean;
  reason?: RemoteWorkerMeshNodeAdmissionUnavailableReason;
}

interface SelectedRuntimeCredentialRow {
  credential_id: string;
  credential_generation: number | bigint | string;
  token_sha256: string;
}

export class RemoteWorkerMeshNodeAdmissionRepository {
  private nonces: RemoteWorkerNonceRepository | undefined;

  public constructor(private readonly db: DatabaseClient) {}

  /** Read-only composition preflight for the additive M3 storage authority. */
  public assertAvailable(): void {
    try {
      this.db.prepare("SELECT provenance_kind FROM mesh_capability_node_admissions WHERE 1 = 0").get();
      this.db
        .prepare(
          `SELECT registry_workspace_id, runtime_credential_token_sha256, join_credential_sha256
           FROM remote_worker_mesh_join_authorities WHERE 1 = 0`,
        )
        .get();
      this.db.prepare("SELECT workspace_id FROM remote_worker_mesh_join_authority_revocations WHERE 1 = 0").get();
      this.db
        .prepare(
          `SELECT provenance_kind, stable_effect_sha256, admitted_by_actor_id
           FROM remote_worker_mesh_node_bindings WHERE 1 = 0`,
        )
        .get();
      this.db
        .prepare(
          `SELECT attempt_sha256, stable_effect_sha256, operation
           FROM remote_worker_mesh_node_admission_attempts WHERE 1 = 0`,
        )
        .get();
    } catch (error) {
      throw new Error("Remote worker mesh-node admission storage migration 194/137 is unavailable.", { cause: error });
    }
  }

  public issueJoinAuthority(
    input: IssueRemoteWorkerMeshNodeJoinAuthorityInput,
  ): IssueRemoteWorkerMeshNodeJoinAuthorityOutcome {
    const normalized = normalizeIssueInput(input);
    const requestSha256 = sha256({
      ...normalized.fence,
      workspaceId: normalized.workspaceId,
      expiresInSeconds: normalized.expiresInSeconds,
      issuedByActorId: normalized.issuedByActorId,
      idempotencyKey: normalized.idempotencyKey,
    });
    return this.db.transaction("immediate", () => {
      this.acquirePostgresLocks(
        normalized.workspaceId,
        normalized.fence.nodeId,
        normalized.fence.registryWorkspaceId,
        normalized.fence.workerId,
      );
      const replay = this.findAuthorityByIdempotency(normalized.fence.registryWorkspaceId, normalized.idempotencyKey);
      if (replay) {
        if (replay.request_sha256 !== requestSha256) throw replayConflict("remote worker mesh join authority");
        const replayBinding = this.findBindingRow(
          replay.workspace_id,
          replay.node_id,
          asPositiveInteger(replay.target_admission_generation, "targetAdmissionGeneration"),
        );
        const replayState = this.currentAuthorityState(replay, replayBinding !== undefined);
        if (!replayState.current) {
          throw unavailable(`remote worker mesh join authority replay: ${replayState.reason ?? "unknown"}`);
        }
        return {
          disposition: "replayed_without_secret",
          authority: mapAuthority(replay),
          secretDisposition: "not_recoverable",
        };
      }

      const issuedAt = this.databaseNow();
      const expiresAt = new Date(Date.parse(issuedAt) + normalized.expiresInSeconds * 1_000).toISOString();
      const currentCredential = this.selectVerifiedM2Credential(normalized.fence, expiresAt, normalized.workspaceId);
      if (!currentCredential) throw unavailable("remote worker M2 authority fence");
      const joinCredentialSha256 = hashSecret(normalized.rawMeshNodeCredential);
      const joinAuthorityGeneration = this.nextJoinAuthorityGeneration(
        normalized.fence.registryWorkspaceId,
        normalized.fence.workerId,
        normalized.fence.workerGeneration,
      );
      const targetAdmissionGeneration = this.nextAdmissionGeneration(normalized.workspaceId, normalized.fence.nodeId);
      try {
        this.db
          .prepare(
            `INSERT INTO mesh_join_tokens (token_hash, created_at, expires_at, used_at, used_by_node_id)
             VALUES (@joinCredentialSha256, @issuedAt, @expiresAt, NULL, NULL)`,
          )
          .run({ joinCredentialSha256, issuedAt, expiresAt });
        this.db
          .prepare(
            `INSERT INTO remote_worker_mesh_join_authorities (
               registry_workspace_id, bootstrap_id, worker_id, worker_generation,
               credential_id, credential_generation, runtime_credential_token_sha256,
               protected_evidence_envelope_sha256, protected_evidence_context_sha256,
               node_id, workspace_id, join_authority_generation, target_admission_generation,
               join_credential_sha256, client_certificate_sha256, issued_by_actor_id,
               idempotency_key, request_sha256, issued_at, expires_at
             ) VALUES (
               @registryWorkspaceId, @bootstrapId, @workerId, @workerGeneration,
               @credentialId, @credentialGeneration, @runtimeCredentialTokenSha256,
               @protectedAdmissionEnvelopeSha256, @protectedAdmissionContextSha256,
               @nodeId, @workspaceId, @joinAuthorityGeneration, @targetAdmissionGeneration,
               @joinCredentialSha256, @clientCertificateSha256, @issuedByActorId,
               @idempotencyKey, @requestSha256, @issuedAt, @expiresAt
             )`,
          )
          .run({
            ...normalized.fence,
            credentialId: currentCredential.credential_id,
            credentialGeneration: currentCredential.credential_generation,
            runtimeCredentialTokenSha256: currentCredential.token_sha256,
            workspaceId: normalized.workspaceId,
            joinAuthorityGeneration,
            targetAdmissionGeneration,
            joinCredentialSha256,
            issuedByActorId: normalized.issuedByActorId,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            issuedAt,
            expiresAt,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker mesh join authority");
      }
      const row = this.getAuthorityRow({
        registryWorkspaceId: normalized.fence.registryWorkspaceId,
        workerId: normalized.fence.workerId,
        workerGeneration: normalized.fence.workerGeneration,
        joinAuthorityGeneration,
      });
      return {
        disposition: "created",
        authority: mapAuthority(row),
        meshNodeCredential: normalized.rawMeshNodeCredential,
        secretDisposition: "returned_once",
      };
    });
  }

  public revokeJoinAuthority(
    input: RevokeRemoteWorkerMeshNodeJoinAuthorityInput,
  ): RemoteWorkerMeshNodeJoinAuthorityRevocationRecord {
    const normalized = normalizeRevocationInput(input);
    const requestSha256 = sha256(normalized);
    const authorityHint = this.findAuthorityByIdentity(normalized);
    if (!authorityHint) throw unavailable("remote worker mesh join authority");
    return this.db.transaction("immediate", () => {
      this.acquirePostgresLocks(
        normalized.workspaceId,
        authorityHint.node_id,
        normalized.registryWorkspaceId,
        normalized.workerId,
      );
      const replay = this.findRevocationByIdempotency(normalized.registryWorkspaceId, normalized.idempotencyKey);
      if (replay) {
        if (replay.request_sha256 !== requestSha256)
          throw replayConflict("remote worker mesh join authority revocation");
        return mapRevocation(replay);
      }
      const authority = this.findAuthorityByIdentity(normalized);
      if (!authority || authority.workspace_id !== normalized.workspaceId)
        throw unavailable("remote worker mesh join authority");
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_mesh_join_authority_revocations (
               registry_workspace_id, worker_id, worker_generation, workspace_id, join_authority_generation,
               reason_code, reason_sha256, revoked_by_actor_id, idempotency_key, request_sha256, revoked_at
             ) VALUES (
               @registryWorkspaceId, @workerId, @workerGeneration, @workspaceId, @joinAuthorityGeneration,
               @reasonCode, @reasonSha256, @revokedByActorId, @idempotencyKey, @requestSha256, @revokedAt
             )`,
          )
          .run({
            registryWorkspaceId: normalized.registryWorkspaceId,
            workerId: normalized.workerId,
            workerGeneration: normalized.workerGeneration,
            workspaceId: normalized.workspaceId,
            joinAuthorityGeneration: normalized.joinAuthorityGeneration,
            reasonCode: normalized.reasonCode,
            reasonSha256: sha256Text(normalized.reason),
            revokedByActorId: normalized.revokedByActorId,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            revokedAt: this.databaseNow(),
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker mesh join authority revocation");
      }
      const row = this.findRevocationByIdempotency(normalized.registryWorkspaceId, normalized.idempotencyKey);
      if (!row) throw unavailable("remote worker mesh join authority revocation");
      return mapRevocation(row);
    });
  }

  public admitWithNonce(input: AdmitRemoteWorkerMeshNodeWithNonceInput): AdmitRemoteWorkerMeshNodeOutcome {
    const command = normalizeAdmissionCommand(input.command);
    const joinCredentialSha256 = hashSecret(command.rawMeshNodeCredential);
    const authorityHint = this.findAuthorityByJoinCredential(joinCredentialSha256);
    if (!authorityHint || authorityHint.workspace_id !== command.workspaceId) {
      throw unavailable("remote worker mesh join authority");
    }
    const nonce = normalizeNonceInput(input.nonce, authorityHint);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresLocks(
        authorityHint.workspace_id,
        authorityHint.node_id,
        authorityHint.registry_workspace_id,
        authorityHint.worker_id,
      );
      const authority = this.findAuthorityByJoinCredential(joinCredentialSha256);
      if (!authority || authority.workspace_id !== command.workspaceId)
        throw unavailable("remote worker mesh join authority");
      const stableEffectSha256 = remoteWorkerMeshNodeStableEffectSha256({
        method: command.method,
        rawPath: command.rawPath,
        operation: command.operation,
        registryWorkspaceId: authority.registry_workspace_id,
        bootstrapId: authority.bootstrap_id,
        workerId: authority.worker_id,
        workerGeneration: asPositiveInteger(authority.worker_generation, "workerGeneration"),
        credentialId: authority.credential_id,
        credentialGeneration: asPositiveInteger(authority.credential_generation, "credentialGeneration"),
        workspaceId: authority.workspace_id,
        nodeId: authority.node_id,
        joinAuthorityGeneration: asPositiveInteger(authority.join_authority_generation, "joinAuthorityGeneration"),
        targetAdmissionGeneration: asPositiveInteger(
          authority.target_admission_generation,
          "targetAdmissionGeneration",
        ),
        joinCredentialSha256,
        clientCertificateSha256: authority.client_certificate_sha256,
        protocolBodySha256: command.protocolBodySha256,
        idempotencyKey: command.idempotencyKey,
      });
      const replay = this.findBindingByIdempotency(command.workspaceId, command.idempotencyKey);
      if (replay && replay.stable_effect_sha256 !== stableEffectSha256) {
        throw replayConflict("remote worker mesh-node admission");
      }
      const authorityState = this.currentAuthorityState(authority, replay !== undefined);
      if (!authorityState.current)
        throw unavailable(`remote worker mesh-node authority: ${authorityState.reason ?? "unknown"}`);
      if (command.clientCertificateSha256 !== authority.client_certificate_sha256) {
        throw unavailable("remote worker mesh-node client certificate binding");
      }
      if (replay) {
        if (!this.nonceRepository().consume(nonce)) throw replayConflict("remote worker mesh-node admission nonce");
        const admission = this.getAdmissionRow(
          replay.workspace_id,
          replay.node_id,
          asPositiveInteger(replay.admission_generation, "admissionGeneration"),
        );
        const attempt = this.persistAttempt("replayed", authority, replay, command, nonce, stableEffectSha256);
        return {
          disposition: "replayed",
          admission: mapRemoteAdmission(admission),
          binding: mapBinding(replay),
          attempt,
          stableEffectSha256,
        };
      }

      if (!this.nonceRepository().consume(nonce)) throw replayConflict("remote worker mesh-node admission nonce");
      const admittedAt = this.databaseNow();
      const consumed = this.db
        .prepare(
          `UPDATE mesh_join_tokens SET used_at = @admittedAt, used_by_node_id = @nodeId
           WHERE token_hash = @joinCredentialSha256 AND used_at IS NULL AND expires_at > @admittedAt`,
        )
        .run({ admittedAt, nodeId: authority.node_id, joinCredentialSha256 }).changes;
      if (consumed !== 1) throw unavailable("remote worker mesh-node join credential");
      const admittedByActorId = remoteWorkerActorId(authority.worker_id);
      const admissionRequestSha256 = sha256({
        workspaceId: authority.workspace_id,
        nodeId: authority.node_id,
        admissionGeneration: asPositiveInteger(authority.target_admission_generation, "targetAdmissionGeneration"),
        joinCredentialSha256,
        mtlsRequired: true,
        tlsFingerprint: authority.client_certificate_sha256,
        provenance: REMOTE_WORKER_MESH_NODE_PROVENANCE,
        admittedByActorId,
        idempotencyKey: command.idempotencyKey,
        stableEffectSha256,
      });
      try {
        this.db
          .prepare(
            `INSERT INTO mesh_nodes (
               node_id, label, advertise_address, transport, status, capabilities_json,
               tls_fingerprint, joined_at, last_seen_at
             ) VALUES (
               @nodeId, 'Remote worker', NULL, 'native_tls', 'online', '[]',
               @tlsFingerprint, @admittedAt, @admittedAt
             )
             ON CONFLICT(node_id) DO UPDATE SET
               label = 'Remote worker', advertise_address = NULL, transport = 'native_tls',
               status = 'online', capabilities_json = '[]',
               tls_fingerprint = excluded.tls_fingerprint, last_seen_at = excluded.last_seen_at`,
          )
          .run({
            nodeId: authority.node_id,
            tlsFingerprint: authority.client_certificate_sha256,
            admittedAt,
          });
        this.db
          .prepare(
            `INSERT INTO mesh_capability_node_admissions (
               workspace_id, node_id, admission_generation, join_token_sha256, mtls_required,
               tls_fingerprint, admitted_by_actor_id, idempotency_key, request_sha256, admitted_at, provenance_kind
             ) VALUES (
               @workspaceId, @nodeId, @admissionGeneration, @joinCredentialSha256, 1,
               @tlsFingerprint, @admittedByActorId, @idempotencyKey, @requestSha256, @admittedAt, 'remote_worker'
             )`,
          )
          .run({
            workspaceId: authority.workspace_id,
            nodeId: authority.node_id,
            admissionGeneration: authority.target_admission_generation,
            joinCredentialSha256,
            tlsFingerprint: authority.client_certificate_sha256,
            admittedByActorId,
            idempotencyKey: command.idempotencyKey,
            requestSha256: admissionRequestSha256,
            admittedAt,
          });
        this.db
          .prepare(
            `INSERT INTO remote_worker_mesh_node_bindings (
               workspace_id, node_id, admission_generation, provenance_kind,
               registry_workspace_id, bootstrap_id, worker_id, worker_generation,
               credential_id, credential_generation, runtime_credential_token_sha256,
               protected_evidence_envelope_sha256, protected_evidence_context_sha256,
               join_authority_generation, join_credential_sha256, client_certificate_sha256,
               stable_effect_sha256, admitted_by_actor_id, idempotency_key, bound_at
             ) VALUES (
               @workspaceId, @nodeId, @admissionGeneration, 'remote_worker',
               @registryWorkspaceId, @bootstrapId, @workerId, @workerGeneration,
               @credentialId, @credentialGeneration, @runtimeCredentialTokenSha256,
               @protectedAdmissionEnvelopeSha256, @protectedAdmissionContextSha256,
               @joinAuthorityGeneration, @joinCredentialSha256, @clientCertificateSha256,
               @stableEffectSha256, @admittedByActorId, @idempotencyKey, @boundAt
             )`,
          )
          .run({
            workspaceId: authority.workspace_id,
            nodeId: authority.node_id,
            admissionGeneration: authority.target_admission_generation,
            registryWorkspaceId: authority.registry_workspace_id,
            bootstrapId: authority.bootstrap_id,
            workerId: authority.worker_id,
            workerGeneration: authority.worker_generation,
            credentialId: authority.credential_id,
            credentialGeneration: authority.credential_generation,
            runtimeCredentialTokenSha256: authority.runtime_credential_token_sha256,
            protectedAdmissionEnvelopeSha256: authority.protected_evidence_envelope_sha256,
            protectedAdmissionContextSha256: authority.protected_evidence_context_sha256,
            joinAuthorityGeneration: authority.join_authority_generation,
            joinCredentialSha256,
            clientCertificateSha256: authority.client_certificate_sha256,
            stableEffectSha256,
            admittedByActorId,
            idempotencyKey: command.idempotencyKey,
            boundAt: admittedAt,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker mesh-node admission");
      }
      const binding = this.getBindingRow(
        authority.workspace_id,
        authority.node_id,
        asPositiveInteger(authority.target_admission_generation, "targetAdmissionGeneration"),
      );
      const admission = this.getAdmissionRow(
        authority.workspace_id,
        authority.node_id,
        asPositiveInteger(authority.target_admission_generation, "targetAdmissionGeneration"),
      );
      const attempt = this.persistAttempt(
        "admitted",
        authority,
        binding,
        command,
        nonce,
        stableEffectSha256,
        admittedAt,
      );
      return {
        disposition: "admitted",
        admission: mapRemoteAdmission(admission),
        binding: mapBinding(binding),
        attempt,
        stableEffectSha256,
      };
    });
  }

  public resolveByRawMeshNodeCredential(
    rawMeshNodeCredential: string,
  ): RemoteWorkerMeshNodeAdmissionResolution | undefined {
    const lookupCredential = meshCredentialLookup(rawMeshNodeCredential);
    if (lookupCredential === undefined) return undefined;
    const joinCredentialSha256 = hashSecret(lookupCredential);
    const admission = this.db
      .prepare("SELECT * FROM mesh_capability_node_admissions WHERE join_token_sha256 = @joinCredentialSha256")
      .get({ joinCredentialSha256 }) as AdmissionRow | undefined;
    if (!admission) return undefined;
    return this.resolveExactAdmission({
      workspaceId: admission.workspace_id,
      nodeId: admission.node_id,
      admissionGeneration: asPositiveInteger(admission.admission_generation, "admissionGeneration"),
    });
  }

  public resolveExactAdmission(
    input: ResolveRemoteWorkerMeshNodeAdmissionInput,
  ): RemoteWorkerMeshNodeAdmissionResolution {
    const normalized = normalizeResolutionInput(input);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresMeshLocks(normalized.workspaceId, normalized.nodeId);
      const admission = this.getAdmissionRow(normalized.workspaceId, normalized.nodeId, normalized.admissionGeneration);
      const mappedAdmission = mapAdmission(admission);
      if (mappedAdmission.provenance === "legacy") {
        return { disposition: "legacy", provenance: "legacy", admission: mappedAdmission };
      }
      const binding = this.findBindingRow(normalized.workspaceId, normalized.nodeId, normalized.admissionGeneration);
      if (!binding) {
        return {
          disposition: "unavailable",
          provenance: "remote_worker",
          reason: "missing_remote_binding",
          admission: mappedAdmission,
        };
      }
      this.acquirePostgresRemoteLocks(
        binding.registry_workspace_id,
        binding.worker_id,
        binding.workspace_id,
        binding.node_id,
      );
      const authority = this.findAuthorityForBinding(binding);
      if (!authority) {
        return {
          disposition: "unavailable",
          provenance: "remote_worker",
          reason: "missing_remote_binding",
          admission: mappedAdmission,
          binding: mapBinding(binding),
        };
      }
      const state = this.currentAuthorityState(authority, true);
      if (!state.current) {
        return {
          disposition: "unavailable",
          provenance: "remote_worker",
          reason: state.reason ?? "protected_evidence_unavailable",
          admission: mappedAdmission,
          binding: mapBinding(binding),
        };
      }
      return {
        disposition: "current",
        provenance: "remote_worker",
        admission: mapRemoteAdmission(admission),
        binding: mapBinding(binding),
        fence: mapFence(binding),
      };
    });
  }

  /**
   * Stable read/CAS token for fixed storage operations. Publication owners must
   * pass the expected fence into a storage-owned write; a Gateway check followed
   * by an unrelated write is intentionally not an authority CAS.
   */
  public compareCurrentAuthorityFence(
    input: CompareRemoteWorkerMeshNodeAuthorityFenceInput,
  ): RemoteWorkerMeshNodeAuthorityFence {
    const resolution = this.resolveExactAdmission(input);
    if (resolution.disposition !== "current") throw unavailable("remote worker mesh-node current authority fence");
    if (input.expected && canonicalJsonString(input.expected) !== canonicalJsonString(resolution.fence)) {
      throw replayConflict("remote worker mesh-node authority fence");
    }
    return resolution.fence;
  }

  private selectVerifiedM2Credential(
    fence: RemoteWorkerMeshNodeVerifiedM2FenceInput,
    expiresAt: string,
    workspaceId: string,
  ): SelectedRuntimeCredentialRow | undefined {
    return this.db
      .prepare(
        `SELECT credential.credential_id, credential.credential_generation, credential.token_sha256
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
            AND allowed.allowed_workspace_id = @workspaceId
           WHERE credential.registry_workspace_id = @registryWorkspaceId
             AND credential.worker_id = @workerId AND credential.worker_generation = @workerGeneration
             AND credential.purpose = 'worker_runtime'
             AND ${this.freshTimestampPredicate("credential.expires_at")}
             AND credential.expires_at >= @expiresAt
             AND generation.bootstrap_id = @bootstrapId AND generation.node_id = @nodeId
             AND generation.client_certificate_sha256 = @clientCertificateSha256
             AND generation.worker_generation = (
               SELECT MAX(latest.worker_generation) FROM remote_worker_generations latest
               WHERE latest.registry_workspace_id = @registryWorkspaceId AND latest.worker_id = @workerId
             )
             AND credential.credential_generation = (
               SELECT MAX(latest.credential_generation) FROM remote_worker_runtime_credentials latest
               WHERE latest.registry_workspace_id = @registryWorkspaceId AND latest.worker_id = @workerId
                 AND latest.worker_generation = @workerGeneration
             )
             AND evidence.envelope_sha256 = @protectedAdmissionEnvelopeSha256
             AND evidence.context_sha256 = @protectedAdmissionContextSha256
             AND NOT EXISTS (
               SELECT 1 FROM remote_worker_generation_controls control
               WHERE control.registry_workspace_id = @registryWorkspaceId AND control.worker_id = @workerId
                 AND control.worker_generation = @workerGeneration
             )
             AND NOT EXISTS (
               SELECT 1 FROM remote_worker_protected_admission_revocations revoked
               WHERE revoked.registry_workspace_id = @registryWorkspaceId AND revoked.worker_id = @workerId
                 AND revoked.worker_generation = @workerGeneration
             )`,
      )
      .get({ ...fence, expiresAt, workspaceId }) as SelectedRuntimeCredentialRow | undefined;
  }

  private currentAuthorityState(authority: AuthorityRow, requireAdmissionCurrent: boolean): CurrentAuthorityState {
    if (!this.isFresh(authority.expires_at)) return { current: false, reason: "authority_expired" };
    const identity = {
      registryWorkspaceId: authority.registry_workspace_id,
      workerId: authority.worker_id,
      workerGeneration: authority.worker_generation,
    };
    const latestAuthority = this.db
      .prepare(
        `SELECT MAX(join_authority_generation) AS generation FROM remote_worker_mesh_join_authorities
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration`,
      )
      .get<{ generation: number | bigint | string }>(identity);
    if (Number(latestAuthority?.generation) !== Number(authority.join_authority_generation)) {
      return { current: false, reason: "authority_superseded" };
    }
    if (
      this.db
        .prepare(
          `SELECT 1 FROM remote_worker_mesh_join_authority_revocations
           WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
             AND worker_generation = @workerGeneration AND join_authority_generation = @joinAuthorityGeneration`,
        )
        .get({ ...identity, joinAuthorityGeneration: authority.join_authority_generation })
    ) {
      return { current: false, reason: "authority_revoked" };
    }
    if (
      this.db
        .prepare(
          `SELECT 1 FROM remote_worker_generation_controls
           WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
             AND worker_generation = @workerGeneration`,
        )
        .get(identity)
    ) {
      return { current: false, reason: "worker_generation_controlled" };
    }
    const selectedCredential = this.selectVerifiedM2Credential(
      mapM2Fence(authority),
      authority.expires_at,
      authority.workspace_id,
    );
    if (
      !selectedCredential ||
      selectedCredential.credential_id !== authority.credential_id ||
      Number(selectedCredential.credential_generation) !== Number(authority.credential_generation) ||
      selectedCredential.token_sha256 !== authority.runtime_credential_token_sha256
    ) {
      const evidence = this.db
        .prepare(
          `SELECT 1 FROM remote_worker_protected_admission_evidence
           WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
             AND worker_generation = @workerGeneration AND envelope_sha256 = @protectedAdmissionEnvelopeSha256
             AND context_sha256 = @protectedAdmissionContextSha256`,
        )
        .get({
          ...identity,
          protectedAdmissionEnvelopeSha256: authority.protected_evidence_envelope_sha256,
          protectedAdmissionContextSha256: authority.protected_evidence_context_sha256,
        });
      return { current: false, reason: evidence ? "credential_expired_or_rotated" : "protected_evidence_unavailable" };
    }
    if (!requireAdmissionCurrent) {
      const target = this.nextAdmissionGeneration(authority.workspace_id, authority.node_id);
      if (target !== Number(authority.target_admission_generation)) {
        return { current: false, reason: "admission_revoked_or_superseded" };
      }
    }
    if (requireAdmissionCurrent) {
      const current = this.db
        .prepare(
          `SELECT 1 FROM mesh_capability_node_admissions admission
           WHERE admission.workspace_id = @workspaceId AND admission.node_id = @nodeId
             AND admission.admission_generation = @admissionGeneration
             AND admission.admission_generation = (
               SELECT MAX(latest.admission_generation) FROM mesh_capability_node_admissions latest
               WHERE latest.workspace_id = admission.workspace_id AND latest.node_id = admission.node_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM mesh_capability_node_admission_revocations revoked
               WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                 AND revoked.admission_generation = admission.admission_generation
             )`,
        )
        .get({
          workspaceId: authority.workspace_id,
          nodeId: authority.node_id,
          admissionGeneration: authority.target_admission_generation,
        });
      if (!current) return { current: false, reason: "admission_revoked_or_superseded" };
    }
    return { current: true };
  }

  private persistAttempt(
    outcome: "admitted" | "replayed",
    authority: AuthorityRow,
    binding: BindingRow,
    command: ReturnType<typeof normalizeAdmissionCommand>,
    nonce: RemoteWorkerNonceConsumeInput,
    stableEffectSha256: string,
    attemptedAt = this.databaseNow(),
  ): RemoteWorkerMeshNodeAdmissionAttemptRecord {
    const attemptSha256 = sha256({
      outcome,
      stableEffectSha256,
      nonceSha256: nonce.nonceSha256,
      requestTimestamp: nonce.timestamp,
      nonceExpiresAt: nonce.expiresAt,
      transportReceiptSha256: command.transportReceiptSha256,
      proofOfPossessionReceiptSha256: command.proofOfPossessionReceiptSha256,
      tlsExporterSha256: command.tlsExporterSha256,
    });
    this.db
      .prepare(
        `INSERT INTO remote_worker_mesh_node_admission_attempts (
           attempt_sha256, stable_effect_sha256, outcome, workspace_id, node_id, admission_generation,
           registry_workspace_id, worker_id, worker_generation, credential_id, credential_generation,
           join_authority_generation, idempotency_key, nonce_sha256, request_timestamp, nonce_expires_at,
           request_method, request_path, operation, protocol_body_sha256, transport_receipt_sha256,
           proof_of_possession_receipt_sha256, tls_exporter_sha256, attempted_at
         ) VALUES (
           @attemptSha256, @stableEffectSha256, @outcome, @workspaceId, @nodeId, @admissionGeneration,
           @registryWorkspaceId, @workerId, @workerGeneration, @credentialId, @credentialGeneration,
           @joinAuthorityGeneration, @idempotencyKey, @nonceSha256, @requestTimestamp, @nonceExpiresAt,
           @requestMethod, @requestPath, @operation, @protocolBodySha256, @transportReceiptSha256,
           @proofOfPossessionReceiptSha256, @tlsExporterSha256, @attemptedAt
         ) ON CONFLICT DO NOTHING`,
      )
      .run({
        attemptSha256,
        stableEffectSha256,
        outcome,
        workspaceId: binding.workspace_id,
        nodeId: binding.node_id,
        admissionGeneration: binding.admission_generation,
        registryWorkspaceId: authority.registry_workspace_id,
        workerId: authority.worker_id,
        workerGeneration: authority.worker_generation,
        credentialId: authority.credential_id,
        credentialGeneration: authority.credential_generation,
        joinAuthorityGeneration: authority.join_authority_generation,
        idempotencyKey: command.idempotencyKey,
        nonceSha256: nonce.nonceSha256,
        requestTimestamp: nonce.timestamp,
        nonceExpiresAt: nonce.expiresAt,
        requestMethod: command.method,
        requestPath: command.rawPath,
        operation: command.operation,
        protocolBodySha256: command.protocolBodySha256,
        transportReceiptSha256: command.transportReceiptSha256,
        proofOfPossessionReceiptSha256: command.proofOfPossessionReceiptSha256,
        tlsExporterSha256: command.tlsExporterSha256,
        attemptedAt,
      });
    const row = this.db
      .prepare("SELECT * FROM remote_worker_mesh_node_admission_attempts WHERE attempt_sha256 = @attemptSha256")
      .get({ attemptSha256 }) as AttemptRow | undefined;
    if (!row) throw unavailable("remote worker mesh-node admission attempt");
    return mapAttempt(row, binding);
  }

  private nextJoinAuthorityGeneration(registryWorkspaceId: string, workerId: string, workerGeneration: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(join_authority_generation), 0) AS generation
         FROM remote_worker_mesh_join_authorities
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration`,
      )
      .get<{ generation: number | bigint | string }>({ registryWorkspaceId, workerId, workerGeneration });
    return asNonNegativeInteger(row?.generation ?? 0, "joinAuthorityGeneration") + 1;
  }

  private nextAdmissionGeneration(workspaceId: string, nodeId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(admission_generation), 0) AS generation FROM mesh_capability_node_admissions
         WHERE workspace_id = @workspaceId AND node_id = @nodeId`,
      )
      .get<{ generation: number | bigint | string }>({ workspaceId, nodeId });
    return asNonNegativeInteger(row?.generation ?? 0, "admissionGeneration") + 1;
  }

  private findAuthorityByIdempotency(registryWorkspaceId: string, idempotencyKey: string): AuthorityRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_mesh_join_authorities
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as AuthorityRow | undefined;
  }

  private findAuthorityByJoinCredential(joinCredentialSha256: string): AuthorityRow | undefined {
    return this.db
      .prepare("SELECT * FROM remote_worker_mesh_join_authorities WHERE join_credential_sha256 = @joinCredentialSha256")
      .get({ joinCredentialSha256 }) as AuthorityRow | undefined;
  }

  private findAuthorityByIdentity(input: {
    registryWorkspaceId: string;
    workerId: string;
    workerGeneration: number;
    joinAuthorityGeneration: number;
  }): AuthorityRow | undefined {
    const params = {
      registryWorkspaceId: input.registryWorkspaceId,
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      joinAuthorityGeneration: input.joinAuthorityGeneration,
    };
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_mesh_join_authorities
         WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId
           AND worker_generation = @workerGeneration AND join_authority_generation = @joinAuthorityGeneration`,
      )
      .get(params) as AuthorityRow | undefined;
  }

  private getAuthorityRow(input: {
    registryWorkspaceId: string;
    workerId: string;
    workerGeneration: number;
    joinAuthorityGeneration: number;
  }): AuthorityRow {
    const row = this.findAuthorityByIdentity(input);
    if (!row) throw unavailable("remote worker mesh join authority");
    return row;
  }

  private findAuthorityForBinding(binding: BindingRow): AuthorityRow | undefined {
    return this.findAuthorityByIdentity({
      registryWorkspaceId: binding.registry_workspace_id,
      workerId: binding.worker_id,
      workerGeneration: asPositiveInteger(binding.worker_generation, "workerGeneration"),
      joinAuthorityGeneration: asPositiveInteger(binding.join_authority_generation, "joinAuthorityGeneration"),
    });
  }

  private findRevocationByIdempotency(registryWorkspaceId: string, idempotencyKey: string): RevocationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_mesh_join_authority_revocations
         WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as RevocationRow | undefined;
  }

  private findBindingByIdempotency(workspaceId: string, idempotencyKey: string): BindingRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_mesh_node_bindings
         WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ workspaceId, idempotencyKey }) as BindingRow | undefined;
  }

  private findBindingRow(workspaceId: string, nodeId: string, admissionGeneration: number): BindingRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_mesh_node_bindings
         WHERE workspace_id = @workspaceId AND node_id = @nodeId AND admission_generation = @admissionGeneration`,
      )
      .get({ workspaceId, nodeId, admissionGeneration }) as BindingRow | undefined;
  }

  private getBindingRow(workspaceId: string, nodeId: string, admissionGeneration: number): BindingRow {
    const row = this.findBindingRow(workspaceId, nodeId, admissionGeneration);
    if (!row) throw unavailable("remote worker mesh-node binding");
    return row;
  }

  private getAdmissionRow(workspaceId: string, nodeId: string, admissionGeneration: number): AdmissionRow {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_node_admissions
         WHERE workspace_id = @workspaceId AND node_id = @nodeId AND admission_generation = @admissionGeneration`,
      )
      .get({ workspaceId, nodeId, admissionGeneration }) as AdmissionRow | undefined;
    if (!row)
      throw new NotFoundError({
        entity: "mesh capability node admission",
        id: `${workspaceId}:${nodeId}:${admissionGeneration}`,
      });
    return row;
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get<{ now?: string }>();
    if (!row?.now) throw new Error("Database clock did not return a timestamp.");
    return row.now;
  }

  private nonceRepository(): RemoteWorkerNonceRepository {
    this.nonces ??= new RemoteWorkerNonceRepository(this.db);
    return this.nonces;
  }

  private isFresh(timestamp: string): boolean {
    const row = this.db
      .prepare(`SELECT CASE WHEN ${this.freshTimestampPredicate("@timestamp")} THEN 1 ELSE 0 END AS fresh`)
      .get<{ fresh: number | bigint | string | boolean }>({ timestamp });
    return Boolean(Number(row?.fresh ?? 0));
  }

  private freshTimestampPredicate(expression: string): string {
    return this.db.dialect === "postgres"
      ? `gc_try_parse_timestamptz(${expression}) IS NOT NULL AND gc_try_parse_timestamptz(${expression}) > clock_timestamp()`
      : `strftime('%Y-%m-%dT%H:%M:%fZ', ${expression}, '+0 days') IS NOT NULL
         AND ${expression} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  private acquirePostgresLocks(
    workspaceId: string,
    nodeId: string,
    registryWorkspaceId: string,
    workerId: string,
  ): void {
    this.acquirePostgresMeshLocks(workspaceId, nodeId);
    this.acquirePostgresRemoteLocks(registryWorkspaceId, workerId, workspaceId, nodeId);
  }

  private acquirePostgresMeshLocks(workspaceId: string, nodeId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId, 411)) AS locked").get({ workspaceId });
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId || ':' || @nodeId, 412)) AS locked")
      .get({ workspaceId, nodeId });
  }

  private acquirePostgresRemoteLocks(
    registryWorkspaceId: string,
    workerId: string,
    workspaceId: string,
    nodeId: string,
  ): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @workerId, 502)) AS locked",
      )
      .get({ registryWorkspaceId, workerId });
    this.db
      .prepare(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           @registryWorkspaceId || ':' || @workerId || ':' || @workspaceId || ':' || @nodeId, 505
         )) AS locked`,
      )
      .get({ registryWorkspaceId, workerId, workspaceId, nodeId });
  }
}

function normalizeIssueInput(input: IssueRemoteWorkerMeshNodeJoinAuthorityInput) {
  return {
    fence: normalizeM2Fence(input),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    expiresInSeconds: positiveIntegerInRange(input.expiresInSeconds, "expiresInSeconds", 1, 600),
    issuedByActorId: identifier(input.issuedByActorId, "issuedByActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
    rawMeshNodeCredential: assertMeshNodeCredential(input.rawMeshNodeCredential, "rawMeshNodeCredential"),
  };
}

function normalizeM2Fence(input: RemoteWorkerMeshNodeVerifiedM2FenceInput): RemoteWorkerMeshNodeVerifiedM2FenceInput {
  return {
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    bootstrapId: identifier(input.bootstrapId, "bootstrapId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: asPositiveInteger(input.workerGeneration, "workerGeneration"),
    nodeId: identifier(input.nodeId, "nodeId"),
    clientCertificateSha256: digest(input.clientCertificateSha256, "clientCertificateSha256"),
    protectedAdmissionEnvelopeSha256: digest(
      input.protectedAdmissionEnvelopeSha256,
      "protectedAdmissionEnvelopeSha256",
    ),
    protectedAdmissionContextSha256: digest(input.protectedAdmissionContextSha256, "protectedAdmissionContextSha256"),
  };
}

function normalizeRevocationInput(input: RevokeRemoteWorkerMeshNodeJoinAuthorityInput) {
  return {
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: asPositiveInteger(input.workerGeneration, "workerGeneration"),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    joinAuthorityGeneration: asPositiveInteger(input.joinAuthorityGeneration, "joinAuthorityGeneration"),
    reasonCode: reasonCode(input.reasonCode),
    reason: text(input.reason, "reason", 1_024),
    revokedByActorId: identifier(input.revokedByActorId, "revokedByActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeAdmissionCommand(input: AdmitRemoteWorkerMeshNodeCommand) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    rawMeshNodeCredential: assertMeshNodeCredential(input.rawMeshNodeCredential, "rawMeshNodeCredential"),
    clientCertificateSha256: digest(input.clientCertificateSha256, "clientCertificateSha256"),
    method: input.method === "POST" ? ("POST" as const) : invalidLiteral("method"),
    rawPath: rawPath(input.rawPath),
    operation: identifier(input.operation, "operation", 128),
    protocolBodySha256: digest(input.protocolBodySha256, "protocolBodySha256"),
    transportReceiptSha256: digest(input.transportReceiptSha256, "transportReceiptSha256"),
    proofOfPossessionReceiptSha256: digest(input.proofOfPossessionReceiptSha256, "proofOfPossessionReceiptSha256"),
    tlsExporterSha256: digest(input.tlsExporterSha256, "tlsExporterSha256"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeNonceInput(
  input: RemoteWorkerNonceConsumeInput,
  authority: AuthorityRow,
): RemoteWorkerNonceConsumeInput {
  const expected = {
    kind: "credential" as const,
    registryWorkspaceId: authority.registry_workspace_id,
    workerId: authority.worker_id,
    workerGeneration: asPositiveInteger(authority.worker_generation, "workerGeneration"),
    credentialGeneration: asPositiveInteger(authority.credential_generation, "credentialGeneration"),
    credentialId: authority.credential_id,
  };
  if (canonicalJsonString(input.authority) !== canonicalJsonString(expected)) {
    throw unavailable("remote worker mesh-node nonce authority");
  }
  return {
    authority: expected,
    nonceSha256: digest(input.nonceSha256, "nonceSha256"),
    timestamp: canonicalTimestamp(input.timestamp, "timestamp"),
    expiresAt: canonicalTimestamp(input.expiresAt, "expiresAt"),
  };
}

function normalizeResolutionInput(
  input: ResolveRemoteWorkerMeshNodeAdmissionInput,
): ResolveRemoteWorkerMeshNodeAdmissionInput {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    nodeId: identifier(input.nodeId, "nodeId"),
    admissionGeneration: asPositiveInteger(input.admissionGeneration, "admissionGeneration"),
  };
}

function mapAuthority(row: AuthorityRow): RemoteWorkerMeshNodeJoinAuthorityRecord {
  return normalizeRemoteWorkerMeshNodeJoinAuthorityRecord({
    schemaVersion: REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION,
    registryWorkspaceId: row.registry_workspace_id,
    bootstrapId: row.bootstrap_id,
    workerId: row.worker_id,
    workerGeneration: asPositiveInteger(row.worker_generation, "workerGeneration"),
    credentialId: row.credential_id,
    credentialGeneration: asPositiveInteger(row.credential_generation, "credentialGeneration"),
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    joinAuthorityGeneration: asPositiveInteger(row.join_authority_generation, "joinAuthorityGeneration"),
    targetAdmissionGeneration: asPositiveInteger(row.target_admission_generation, "targetAdmissionGeneration"),
    joinCredentialSha256: row.join_credential_sha256,
    clientCertificateSha256: row.client_certificate_sha256,
    protectedAdmissionEnvelopeSha256: row.protected_evidence_envelope_sha256,
    protectedAdmissionContextSha256: row.protected_evidence_context_sha256,
    issuedByActorId: row.issued_by_actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  });
}

function mapRevocation(row: RevocationRow): RemoteWorkerMeshNodeJoinAuthorityRevocationRecord {
  return normalizeRemoteWorkerMeshNodeJoinAuthorityRevocationRecord({
    schemaVersion: REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION,
    registryWorkspaceId: row.registry_workspace_id,
    workerId: row.worker_id,
    workerGeneration: asPositiveInteger(row.worker_generation, "workerGeneration"),
    workspaceId: row.workspace_id,
    joinAuthorityGeneration: asPositiveInteger(row.join_authority_generation, "joinAuthorityGeneration"),
    reasonCode: row.reason_code,
    reasonSha256: row.reason_sha256,
    revokedByActorId: row.revoked_by_actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    revokedAt: row.revoked_at,
  });
}

function mapAdmission(row: AdmissionRow): RemoteWorkerMeshNodeAdmissionRecordBase {
  const provenance = row.provenance_kind === "remote_worker" ? "remote_worker" : "legacy";
  return {
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    admissionGeneration: asPositiveInteger(row.admission_generation, "admissionGeneration"),
    joinCredentialSha256: digest(row.join_token_sha256, "joinCredentialSha256"),
    mtlsRequired: Boolean(Number(row.mtls_required)),
    ...(row.tls_fingerprint ? { tlsFingerprint: row.tls_fingerprint } : {}),
    provenance,
    admittedByActorId: row.admitted_by_actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: digest(row.request_sha256, "requestSha256"),
    admittedAt: canonicalTimestamp(row.admitted_at, "admittedAt"),
  };
}

function mapRemoteAdmission(row: AdmissionRow): RemoteWorkerMeshNodeAdmissionRecord {
  const admission = mapAdmission(row);
  if (admission.provenance !== "remote_worker" || admission.mtlsRequired !== true || !admission.tlsFingerprint) {
    throw unavailable("remote worker mesh-node admission provenance");
  }
  return { ...admission, mtlsRequired: true, tlsFingerprint: admission.tlsFingerprint, provenance: "remote_worker" };
}

function mapBinding(row: BindingRow): RemoteWorkerMeshNodeAdmissionBindingRecord {
  return normalizeRemoteWorkerMeshNodeAdmissionBindingRecord({
    schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
    ...mapFenceFields(row),
    provenance: REMOTE_WORKER_MESH_NODE_PROVENANCE,
    stableEffectSha256: row.stable_effect_sha256,
    admittedByActorId: row.admitted_by_actor_id,
    idempotencyKey: row.idempotency_key,
    admittedAt: row.bound_at,
  });
}

function mapFence(row: BindingRow): RemoteWorkerMeshNodeAuthorityFence {
  return normalizeRemoteWorkerMeshNodeAuthorityFence({
    schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
    ...mapFenceFields(row),
  });
}

function mapFenceFields(row: BindingRow) {
  return {
    registryWorkspaceId: row.registry_workspace_id,
    bootstrapId: row.bootstrap_id,
    workerId: row.worker_id,
    workerGeneration: asPositiveInteger(row.worker_generation, "workerGeneration"),
    credentialId: row.credential_id,
    credentialGeneration: asPositiveInteger(row.credential_generation, "credentialGeneration"),
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    admissionGeneration: asPositiveInteger(row.admission_generation, "admissionGeneration"),
    joinAuthorityGeneration: asPositiveInteger(row.join_authority_generation, "joinAuthorityGeneration"),
    joinCredentialSha256: row.join_credential_sha256,
    protectedAdmissionEnvelopeSha256: row.protected_evidence_envelope_sha256,
    protectedAdmissionContextSha256: row.protected_evidence_context_sha256,
  };
}

function mapAttempt(row: AttemptRow, binding: BindingRow): RemoteWorkerMeshNodeAdmissionAttemptRecord {
  return normalizeRemoteWorkerMeshNodeAdmissionAttemptRecord({
    schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_ATTEMPT_SCHEMA_VERSION,
    workspaceId: binding.workspace_id,
    nodeId: binding.node_id,
    admissionGeneration: asPositiveInteger(binding.admission_generation, "admissionGeneration"),
    nonceSha256: row.nonce_sha256,
    protocolBodySha256: row.protocol_body_sha256,
    transportReceiptSha256: row.transport_receipt_sha256,
    proofOfPossessionReceiptSha256: row.proof_of_possession_receipt_sha256,
    attemptedAt: row.attempted_at,
  });
}

function mapM2Fence(authority: AuthorityRow): RemoteWorkerMeshNodeVerifiedM2FenceInput {
  return {
    registryWorkspaceId: authority.registry_workspace_id,
    bootstrapId: authority.bootstrap_id,
    workerId: authority.worker_id,
    workerGeneration: asPositiveInteger(authority.worker_generation, "workerGeneration"),
    nodeId: authority.node_id,
    clientCertificateSha256: authority.client_certificate_sha256,
    protectedAdmissionEnvelopeSha256: authority.protected_evidence_envelope_sha256,
    protectedAdmissionContextSha256: authority.protected_evidence_context_sha256,
  };
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertMeshNodeCredential(value: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new ValidationError({ field, message: `${field} must be an exact 256-bit base64url credential.` });
  }
  return value;
}

function meshCredentialLookup(value: string): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/\s/u.test(value)
    ? value
    : undefined;
}

function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `${field} is not a canonical identifier.` });
  }
  return value;
}

function text(value: string, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `${field} is invalid.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({ field, message: `${field} must be a lower-case SHA-256 digest.` });
  }
  return value;
}

function reasonCode(value: string): string {
  const normalized = identifier(value, "reasonCode", 128);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(normalized)) {
    throw new ValidationError({ field: "reasonCode", message: "reasonCode is invalid." });
  }
  return normalized;
}

function rawPath(value: string): string {
  if (typeof value !== "string" || value.length > 512 || !/^\/api\/v1\/[A-Za-z0-9/_-]+$/u.test(value)) {
    throw new ValidationError({ field: "rawPath", message: "rawPath is invalid." });
  }
  return value;
}

function canonicalTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new ValidationError({ field, message: `${field} must be a canonical UTC timestamp.` });
  }
  return value;
}

function asPositiveInteger(value: number | bigint | string, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ValidationError({ field, message: `${field} must be a positive safe integer.` });
  }
  return number;
}

function asNonNegativeInteger(value: number | bigint | string, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ValidationError({ field, message: `${field} must be a non-negative safe integer.` });
  }
  return number;
}

function positiveIntegerInRange(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError({ field, message: `${field} is outside the supported range.` });
  }
  return value;
}

function remoteWorkerActorId(workerId: string): string {
  return identifier(`remote-worker:${workerId}`, "admittedByActorId");
}

function invalidLiteral(field: string): never {
  throw new ValidationError({ field, message: `${field} is invalid.` });
}

function unavailable(entity: string): NotFoundError {
  return new NotFoundError({ entity, id: "current" });
}

function replayConflict(label: string): ConflictError {
  return new ConflictError({
    message: `${label} idempotency or authority fence is bound to different request bytes.`,
    details: { reason: "durable_authority_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError || error instanceof ConflictError || error instanceof NotFoundError)
    return error;
  return new ConflictError({
    message: `${label} violated an atomic durable authority invariant.`,
    details: { reason: "durable_authority_invariant_conflict" },
  });
}
