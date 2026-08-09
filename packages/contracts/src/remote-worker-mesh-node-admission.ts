import { z } from "zod";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

export const REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-join-authority.v1" as const;
export const REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-join-authority-revocation.v1" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-admission-payload.v1" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_RESPONSE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-admission-response.v1" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-admission-binding.v1" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_ATTEMPT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-admission-attempt.v1" as const;
export const REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-authority-fence.v1" as const;
export const REMOTE_WORKER_MESH_NODE_STABLE_EFFECT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-stable-effect.v1" as const;
export const REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_MAX_TTL_SECONDS = 600;
export const REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER = "x-goatcitadel-mesh-node-join-credential" as const;
export const REMOTE_WORKER_MESH_NODE_PROVENANCE = "remote_worker" as const;

const identifier = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value));
const positiveInteger = z.number().int().safe().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const utcTimestamp = z
  .string()
  .datetime({ offset: false, precision: 3 })
  .refine((value) => new Date(Date.parse(value)).toISOString() === value);

const joinAuthoritySchema = z
  .object({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION),
    registryWorkspaceId: identifier(),
    bootstrapId: identifier(),
    workerId: identifier(),
    workerGeneration: positiveInteger,
    credentialId: identifier(),
    credentialGeneration: positiveInteger,
    nodeId: identifier(),
    workspaceId: identifier(),
    joinAuthorityGeneration: positiveInteger,
    targetAdmissionGeneration: positiveInteger,
    joinCredentialSha256: sha256,
    clientCertificateSha256: sha256,
    protectedAdmissionEnvelopeSha256: sha256,
    protectedAdmissionContextSha256: sha256,
    issuedByActorId: identifier(),
    idempotencyKey: identifier(512),
    requestSha256: sha256,
    issuedAt: utcTimestamp,
    expiresAt: utcTimestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const ttl = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (ttl < 1_000 || ttl > REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_MAX_TTL_SECONDS * 1_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "join authority TTL is invalid" });
    }
  });

const revocationSchema = z
  .object({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION),
    registryWorkspaceId: identifier(),
    workerId: identifier(),
    workerGeneration: positiveInteger,
    workspaceId: identifier(),
    joinAuthorityGeneration: positiveInteger,
    reasonCode: identifier(128),
    reasonSha256: sha256,
    revokedByActorId: identifier(),
    idempotencyKey: identifier(512),
    requestSha256: sha256,
    revokedAt: utcTimestamp,
  })
  .strict();

const admissionPayloadSchema = z
  .object({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION),
    workspaceId: identifier(),
    /** Signed binding only. The raw credential must also be presented and hashed by the server. */
    joinCredentialSha256: sha256,
  })
  .strict();

const authorityFenceSchema = z
  .object({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION),
    registryWorkspaceId: identifier(),
    bootstrapId: identifier(),
    workerId: identifier(),
    workerGeneration: positiveInteger,
    credentialId: identifier(),
    credentialGeneration: positiveInteger,
    workspaceId: identifier(),
    nodeId: identifier(),
    admissionGeneration: positiveInteger,
    joinAuthorityGeneration: positiveInteger,
    joinCredentialSha256: sha256,
    protectedAdmissionEnvelopeSha256: sha256,
    protectedAdmissionContextSha256: sha256,
  })
  .strict();

const bindingSchema = authorityFenceSchema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION),
    provenance: z.literal(REMOTE_WORKER_MESH_NODE_PROVENANCE),
    stableEffectSha256: sha256,
    admittedByActorId: identifier(),
    idempotencyKey: identifier(512),
    admittedAt: utcTimestamp,
  })
  .strict();

const attemptSchema = z
  .object({
    schemaVersion: z.literal(REMOTE_WORKER_MESH_NODE_ADMISSION_ATTEMPT_SCHEMA_VERSION),
    workspaceId: identifier(),
    nodeId: identifier(),
    admissionGeneration: positiveInteger,
    nonceSha256: sha256,
    protocolBodySha256: sha256,
    transportReceiptSha256: sha256,
    proofOfPossessionReceiptSha256: sha256,
    attemptedAt: utcTimestamp,
  })
  .strict();

export interface RemoteWorkerMeshNodeJoinAuthorityRecord {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly joinAuthorityGeneration: number;
  /** Exact next HX-408 admission generation authorized at issuance. */
  readonly targetAdmissionGeneration: number;
  /** SHA-256 of the separately delivered, secret-once credential. */
  readonly joinCredentialSha256: string;
  readonly clientCertificateSha256: string;
  readonly protectedAdmissionEnvelopeSha256: string;
  readonly protectedAdmissionContextSha256: string;
  readonly issuedByActorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RemoteWorkerMeshNodeJoinAuthorityRevocationRecord {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly joinAuthorityGeneration: number;
  readonly reasonCode: string;
  readonly reasonSha256: string;
  readonly revokedByActorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly revokedAt: string;
}

export interface RemoteWorkerMeshNodeAdmissionPayload {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION;
  readonly workspaceId: string;
  /** Signed digest binding; never sufficient without the raw header credential. */
  readonly joinCredentialSha256: string;
}

export interface RemoteWorkerMeshNodeAdmissionResponse {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_RESPONSE_SCHEMA_VERSION;
  readonly disposition: "admitted" | "replayed";
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly mtlsRequired: true;
  readonly tlsFingerprint: string;
}

export interface IssueRemoteWorkerMeshNodeJoinAuthorityRequest {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly expiresInSeconds: number;
  readonly idempotencyKey: string;
}

export interface RevokeRemoteWorkerMeshNodeJoinAuthorityRequest {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly joinAuthorityGeneration: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerMeshNodeJoinCredentialIssuance {
  readonly disposition: "created" | "replayed_without_secret";
  readonly authority: RemoteWorkerMeshNodeJoinAuthorityRecord;
  readonly meshNodeCredential?: string;
  readonly secretDisposition: "returned_once" | "not_recoverable";
}

export interface RemoteWorkerMeshNodeAuthorityFence {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly joinAuthorityGeneration: number;
  readonly joinCredentialSha256: string;
  readonly protectedAdmissionEnvelopeSha256: string;
  readonly protectedAdmissionContextSha256: string;
}

export interface RemoteWorkerMeshNodeAdmissionBindingRecord extends Omit<
  RemoteWorkerMeshNodeAuthorityFence,
  "schemaVersion"
> {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION;
  readonly provenance: typeof REMOTE_WORKER_MESH_NODE_PROVENANCE;
  readonly stableEffectSha256: string;
  readonly admittedByActorId: string;
  readonly idempotencyKey: string;
  readonly admittedAt: string;
}

export interface RemoteWorkerMeshNodeAdmissionAttemptRecord {
  readonly schemaVersion: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_ATTEMPT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly admissionGeneration: number;
  readonly nonceSha256: string;
  readonly protocolBodySha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly attemptedAt: string;
}

export interface RemoteWorkerMeshNodeStableEffectInput {
  readonly method: "POST";
  readonly rawPath: string;
  readonly operation: string;
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly joinAuthorityGeneration: number;
  readonly targetAdmissionGeneration: number;
  readonly joinCredentialSha256: string;
  readonly clientCertificateSha256: string;
  readonly protocolBodySha256: string;
  readonly idempotencyKey: string;
}

export function normalizeRemoteWorkerMeshNodeJoinAuthorityRecord(
  value: unknown,
): RemoteWorkerMeshNodeJoinAuthorityRecord {
  return Object.freeze(joinAuthoritySchema.parse(value));
}

export function normalizeRemoteWorkerMeshNodeJoinAuthorityRevocationRecord(
  value: unknown,
): RemoteWorkerMeshNodeJoinAuthorityRevocationRecord {
  return Object.freeze(revocationSchema.parse(value));
}

export function normalizeRemoteWorkerMeshNodeAdmissionPayload(value: unknown): RemoteWorkerMeshNodeAdmissionPayload {
  return Object.freeze(admissionPayloadSchema.parse(value));
}

export function normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest(
  value: unknown,
): IssueRemoteWorkerMeshNodeJoinAuthorityRequest {
  return Object.freeze(
    z
      .object({
        registryWorkspaceId: identifier(),
        workerId: identifier(),
        workerGeneration: positiveInteger,
        workspaceId: identifier(),
        expiresInSeconds: positiveInteger.max(REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_MAX_TTL_SECONDS),
        idempotencyKey: identifier(512),
      })
      .strict()
      .parse(value),
  );
}

export function normalizeRevokeRemoteWorkerMeshNodeJoinAuthorityRequest(
  value: unknown,
): RevokeRemoteWorkerMeshNodeJoinAuthorityRequest {
  return Object.freeze(
    z
      .object({
        registryWorkspaceId: identifier(),
        workerId: identifier(),
        workerGeneration: positiveInteger,
        workspaceId: identifier(),
        joinAuthorityGeneration: positiveInteger,
        reasonCode: identifier(128).refine((reason) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(reason)),
        reason: identifier(1_024),
        idempotencyKey: identifier(512),
      })
      .strict()
      .parse(value),
  );
}

export function normalizeRemoteWorkerMeshNodeAuthorityFence(value: unknown): RemoteWorkerMeshNodeAuthorityFence {
  return Object.freeze(authorityFenceSchema.parse(value));
}

export function normalizeRemoteWorkerMeshNodeAdmissionBindingRecord(
  value: unknown,
): RemoteWorkerMeshNodeAdmissionBindingRecord {
  return Object.freeze(bindingSchema.parse(value));
}

export function normalizeRemoteWorkerMeshNodeAdmissionAttemptRecord(
  value: unknown,
): RemoteWorkerMeshNodeAdmissionAttemptRecord {
  return Object.freeze(attemptSchema.parse(value));
}

export function remoteWorkerMeshNodeStableEffectMaterial(input: RemoteWorkerMeshNodeStableEffectInput): object {
  const parsed = z
    .object({
      method: z.literal("POST"),
      rawPath: z
        .string()
        .regex(/^\/api\/v1\/[A-Za-z0-9/_-]+$/u)
        .max(512),
      operation: identifier(128),
      registryWorkspaceId: identifier(),
      bootstrapId: identifier(),
      workerId: identifier(),
      workerGeneration: positiveInteger,
      credentialId: identifier(),
      credentialGeneration: positiveInteger,
      workspaceId: identifier(),
      nodeId: identifier(),
      joinAuthorityGeneration: positiveInteger,
      targetAdmissionGeneration: positiveInteger,
      joinCredentialSha256: sha256,
      clientCertificateSha256: sha256,
      protocolBodySha256: sha256,
      idempotencyKey: identifier(512),
    })
    .strict()
    .parse(input);
  return Object.freeze({ schemaVersion: REMOTE_WORKER_MESH_NODE_STABLE_EFFECT_SCHEMA_VERSION, ...parsed });
}

export function remoteWorkerMeshNodeStableEffectSha256(input: RemoteWorkerMeshNodeStableEffectInput): string {
  return sha256Hex(canonicalJsonString(remoteWorkerMeshNodeStableEffectMaterial(input)));
}
