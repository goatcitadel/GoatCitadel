import { createHash, timingSafeEqual } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_RESPONSE_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER,
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  canonicalJsonString,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeRemoteWorkerMeshNodeAdmissionBindingRecord,
  normalizeRemoteWorkerMeshNodeAdmissionPayload,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerMeshNodeAdmissionBindingRecord,
  type RemoteWorkerMeshNodeAdmissionResponse,
  type RemoteWorkerRuntimeCredentialClaims,
} from "@goatcitadel/contracts";
import {
  normalizeRemoteWorkerProtocolBody,
  prepareRemoteWorkerProofOfPossession,
  snapshotRemoteWorkerDurableNonceConsumption,
  type RemoteWorkerDurableNonceConsumption,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";
import type {
  CurrentRemoteWorkerRuntimeCredentialAuthority,
  RemoteWorkerCurrentRuntimeCredentialAuthorityPort,
} from "./remote-worker-current-authority-service.js";

export const REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD = "POST" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH = "/api/v1/remote-workers/mesh-node-admissions" as const;
export const REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION = "mesh.node.admit" as const;
const REMOTE_WORKER_MESH_NODE_TRANSPORT_RECEIPT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-mesh-node-transport-receipt.v1" as const;

type Awaitable<T> = T | Promise<T>;

export interface RemoteWorkerMeshNodeAdmissionCommand {
  readonly workspaceId: string;
  /** Raw secret crosses only this fixed storage operation and is never returned. */
  readonly rawMeshNodeCredential: string;
  readonly clientCertificateSha256: string;
  readonly method: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD;
  readonly rawPath: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH;
  readonly operation: typeof REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION;
  readonly protocolBodySha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly tlsExporterSha256: string;
  readonly idempotencyKey: string;
}

export interface RemoteWorkerMeshNodeAdmissionStoreInput {
  /** Consumed in the same transaction as token, node, HX-408 admission, and binding. */
  readonly nonce: RemoteWorkerDurableNonceConsumption;
  readonly command: RemoteWorkerMeshNodeAdmissionCommand;
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

export interface RemoteWorkerMeshNodeAdmissionStoreOutcome {
  readonly disposition: "admitted" | "replayed";
  readonly admission: RemoteWorkerMeshNodeAdmissionRecord;
  readonly binding: RemoteWorkerMeshNodeAdmissionBindingRecord;
  readonly stableEffectSha256: string;
}

export interface RemoteWorkerMeshNodeAdmissionStorePort {
  assertAvailable(): Awaitable<void>;
  admitWithNonce(input: RemoteWorkerMeshNodeAdmissionStoreInput): Awaitable<RemoteWorkerMeshNodeAdmissionStoreOutcome>;
}

export interface RemoteWorkerMeshNodeAdmissionRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerMeshNodeAdmissionServiceDependencies {
  readonly currentAuthority: RemoteWorkerCurrentRuntimeCredentialAuthorityPort;
  readonly admissions: RemoteWorkerMeshNodeAdmissionStorePort;
  readonly clock: () => Date;
}

export class RemoteWorkerMeshNodeAdmissionError extends Error {
  readonly code = "REMOTE_WORKER_MESH_NODE_ADMISSION_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerMeshNodeAdmissionError";
  }
}

interface SnapshotRequest {
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: RemoteWorkerProtocolBody;
  readonly payload: ReturnType<typeof normalizeRemoteWorkerMeshNodeAdmissionPayload>;
  readonly credentialTokenSha256: string;
  readonly rawMeshNodeCredential: string;
  readonly joinCredentialSha256: string;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

/**
 * Native-mTLS-only remote-worker -> HX-408 admission owner. The signed payload
 * carries a digest binding, but possession is proved only by the separate raw
 * secret-once header, which is hashed by the server and consumed atomically.
 */
export class RemoteWorkerMeshNodeAdmissionService {
  public constructor(private readonly dependencies: RemoteWorkerMeshNodeAdmissionServiceDependencies) {
    if (typeof dependencies.clock !== "function") throw rejected("Remote worker mesh-node clock is unavailable.");
  }

  public async assertAvailable(): Promise<void> {
    if (
      this.dependencies.currentAuthority === null ||
      typeof this.dependencies.currentAuthority !== "object" ||
      typeof this.dependencies.currentAuthority.resolveByCredentialTokenSha256 !== "function" ||
      this.dependencies.admissions === null ||
      (typeof this.dependencies.admissions !== "object" && typeof this.dependencies.admissions !== "function") ||
      typeof this.dependencies.admissions.assertAvailable !== "function" ||
      typeof this.dependencies.admissions.admitWithNonce !== "function"
    ) {
      throw rejected("Remote worker mesh-node admission owner is unavailable.");
    }
    await this.dependencies.admissions.assertAvailable();
  }

  public async admit(input: RemoteWorkerMeshNodeAdmissionRequest): Promise<RemoteWorkerMeshNodeAdmissionResponse> {
    let request: SnapshotRequest | undefined;
    try {
      request = snapshotRequest(input);
      const now = snapshotClock(this.dependencies.clock());
      const resolved = await this.dependencies.currentAuthority.resolveByCredentialTokenSha256(
        request.credentialTokenSha256,
      );
      if (resolved === undefined) throw rejected("Current remote worker authority is unavailable.");
      const authority = snapshotCurrentAuthority(resolved, request.credentialTokenSha256);
      assertTransportBinding(authority, request.transportIdentity);
      const policy = evaluateRemoteWorkerRuntimeCredentialRoutePolicy(authority.claims, {
        routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
        workspaceId: request.payload.workspaceId,
        requiredCapabilityClasses: ["durable_compute"],
      });
      if (!policy.allowed) throw rejected("Remote worker workspace ceiling denies mesh-node admission.");
      if (!safeDigestEqual(request.joinCredentialSha256, request.payload.joinCredentialSha256)) {
        throw rejected("Remote worker mesh-node credential binding is invalid.");
      }

      const protocolAuthority: RemoteWorkerResolvedAuthority = Object.freeze({
        kind: "credential",
        authorityId: authority.credentialId,
        authorityGeneration: authority.credentialGeneration,
        workerGeneration: authority.workerGeneration,
        authorizationCredentialSha256: authority.authorizationCredentialSha256,
        publicKeySpkiDer: authority.publicKeySpkiDer,
        publicKeySpkiSha256: authority.publicKeySpkiSha256,
      });
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        headers: request.headers,
        body: request.body,
        expectedOperation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
        authority: protocolAuthority,
        proofRequirement: "protected_v2_required",
        transportIdentity: request.transportIdentity,
        now,
      });
      const nonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: Object.freeze({
          kind: "credential",
          registryWorkspaceId: authority.registryWorkspaceId,
          workerId: authority.workerId,
          workerGeneration: authority.workerGeneration,
          credentialGeneration: authority.credentialGeneration,
          credentialId: authority.credentialId,
        }),
        nonce: prepared.nonce.nonce,
        timestamp: prepared.nonce.timestamp,
        authorityId: prepared.nonce.authorityId,
        authorityGeneration: prepared.nonce.authorityGeneration,
      });
      const command: RemoteWorkerMeshNodeAdmissionCommand = Object.freeze({
        workspaceId: request.payload.workspaceId,
        rawMeshNodeCredential: request.rawMeshNodeCredential,
        clientCertificateSha256: authority.clientCertificateSha256,
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        operation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
        protocolBodySha256: prepared.receipt.bodySha256,
        transportReceiptSha256: transportReceiptSha256(authority, prepared.receipt),
        proofOfPossessionReceiptSha256: prepared.receipt.proofOfPossessionReceiptSha256,
        tlsExporterSha256: prepared.receipt.tlsExporterSha256,
        idempotencyKey: prepared.body.idempotencyKey,
      });
      const outcome = snapshotOutcome(
        await this.dependencies.admissions.admitWithNonce({
          nonce,
          command,
        }),
        command,
        authority,
        request.joinCredentialSha256,
      );
      return Object.freeze({
        schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_RESPONSE_SCHEMA_VERSION,
        disposition: outcome.disposition,
        workspaceId: outcome.admission.workspaceId,
        nodeId: outcome.admission.nodeId,
        admissionGeneration: outcome.admission.admissionGeneration,
        mtlsRequired: true,
        tlsFingerprint: outcome.admission.tlsFingerprint!,
      });
    } catch (error) {
      if (error instanceof RemoteWorkerMeshNodeAdmissionError) throw error;
      throw rejected("Remote worker mesh-node admission could not be completed.");
    } finally {
      request?.transportIdentity.tlsExporter.fill(0);
    }
  }
}

function snapshotRequest(input: RemoteWorkerMeshNodeAdmissionRequest): SnapshotRequest {
  if (
    input.method !== REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD ||
    input.rawPath !== REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH
  ) {
    throw rejected("Remote worker mesh-node admission target is invalid.");
  }
  const headers = snapshotHeaders(input.headers);
  const body = normalizeRemoteWorkerProtocolBody(input.body);
  const payload = normalizeRemoteWorkerMeshNodeAdmissionPayload(body.payload);
  const credentialTokenSha256 = bearerCredentialSha256(headers.authorization);
  const rawMeshNodeCredential = readRawMeshNodeCredential(headers[REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER]);
  const joinCredentialSha256 = sha256Utf8(rawMeshNodeCredential);
  return Object.freeze({
    headers,
    body: Object.freeze({ ...body, payload: payload as unknown as RemoteWorkerProtocolBody["payload"] }),
    payload,
    credentialTokenSha256,
    rawMeshNodeCredential,
    joinCredentialSha256,
    transportIdentity: snapshotTransportIdentity(input.transportIdentity),
  });
}

function snapshotCurrentAuthority(
  value: CurrentRemoteWorkerRuntimeCredentialAuthority,
  expectedTokenSha256: string,
): CurrentRemoteWorkerRuntimeCredentialAuthority {
  if (!Buffer.isBuffer(value.publicKeySpkiDer) || nodeUtilTypes.isProxy(value.publicKeySpkiDer)) throw rejected();
  const publicKeySpkiDer = Buffer.from(value.publicKeySpkiDer);
  const claims = JSON.parse(canonicalJsonString(value.claims)) as RemoteWorkerRuntimeCredentialClaims;
  const snapshot = Object.freeze({ ...value, publicKeySpkiDer, claims });
  if (
    !safeDigestEqual(snapshot.authorizationCredentialSha256, expectedTokenSha256) ||
    !safeDigestEqual(sha256Bytes(publicKeySpkiDer), snapshot.publicKeySpkiSha256) ||
    !safeDigestEqual(remoteWorkerRuntimeCredentialClaimsSha256(claims), snapshot.claimsSha256) ||
    !isDigest(snapshot.protectedAdmissionEnvelopeSha256) ||
    !isDigest(snapshot.protectedAdmissionContextSha256) ||
    claims.registryWorkspaceId !== snapshot.registryWorkspaceId ||
    claims.workerId !== snapshot.workerId ||
    claims.workerGeneration !== snapshot.workerGeneration ||
    claims.workspaceCeilingSha256 !== snapshot.workspaceCeilingSha256 ||
    claims.capabilityCeilingSha256 !== snapshot.capabilityCeilingSha256
  ) {
    publicKeySpkiDer.fill(0);
    throw rejected("Current remote worker authority is inconsistent.");
  }
  return snapshot;
}

function assertTransportBinding(
  authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  transport: RemoteWorkerTransportIdentity,
): void {
  if (
    transport.source !== "native_mtls" ||
    !safeDigestEqual(transport.publicKeySpkiSha256, authority.publicKeySpkiSha256) ||
    !safeDigestEqual(transport.certificateDerSha256, authority.clientCertificateSha256) ||
    !safeDigestEqual(transport.trustAnchorDerSha256, authority.transportTrustAnchorSha256)
  ) {
    throw rejected("Remote worker mesh-node mutual TLS authority is invalid.");
  }
}

function snapshotOutcome(
  value: RemoteWorkerMeshNodeAdmissionStoreOutcome,
  command: RemoteWorkerMeshNodeAdmissionCommand,
  authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  joinCredentialSha256: string,
): RemoteWorkerMeshNodeAdmissionStoreOutcome {
  const admission = Object.freeze({ ...value.admission });
  const binding = normalizeRemoteWorkerMeshNodeAdmissionBindingRecord(value.binding);
  if (
    (value.disposition !== "admitted" && value.disposition !== "replayed") ||
    admission.workspaceId !== command.workspaceId ||
    admission.nodeId !== authority.nodeId ||
    !Number.isSafeInteger(admission.admissionGeneration) ||
    admission.admissionGeneration < 1 ||
    admission.joinCredentialSha256 !== joinCredentialSha256 ||
    admission.mtlsRequired !== true ||
    admission.tlsFingerprint !== command.clientCertificateSha256 ||
    admission.provenance !== "remote_worker" ||
    admission.admittedByActorId !== `remote-worker:${authority.workerId}:${authority.workerGeneration}` ||
    admission.idempotencyKey !== command.idempotencyKey ||
    binding.workspaceId !== admission.workspaceId ||
    binding.nodeId !== admission.nodeId ||
    binding.admissionGeneration !== admission.admissionGeneration ||
    binding.registryWorkspaceId !== authority.registryWorkspaceId ||
    binding.bootstrapId !== authority.bootstrapId ||
    binding.workerId !== authority.workerId ||
    binding.workerGeneration !== authority.workerGeneration ||
    binding.credentialId !== authority.credentialId ||
    binding.credentialGeneration !== authority.credentialGeneration ||
    binding.joinCredentialSha256 !== joinCredentialSha256 ||
    binding.protectedAdmissionEnvelopeSha256 !== authority.protectedAdmissionEnvelopeSha256 ||
    binding.protectedAdmissionContextSha256 !== authority.protectedAdmissionContextSha256 ||
    binding.idempotencyKey !== command.idempotencyKey ||
    binding.stableEffectSha256 !== value.stableEffectSha256 ||
    !isDigest(admission.requestSha256) ||
    !isDigest(value.stableEffectSha256)
  ) {
    throw rejected("Remote worker mesh-node admission storage outcome is invalid.");
  }
  return Object.freeze({
    disposition: value.disposition,
    admission,
    binding,
    stableEffectSha256: value.stableEffectSha256,
  });
}

function transportReceiptSha256(
  authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  receipt: {
    readonly bodySha256: string;
    readonly certificateDerSha256: string;
    readonly publicKeySpkiSha256: string;
    readonly tlsExporterSha256: string;
    readonly proofOfPossessionReceiptSha256: string;
  },
): string {
  return sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_MESH_NODE_TRANSPORT_RECEIPT_SCHEMA_VERSION,
      registryWorkspaceId: authority.registryWorkspaceId,
      workerId: authority.workerId,
      workerGeneration: authority.workerGeneration,
      credentialId: authority.credentialId,
      credentialGeneration: authority.credentialGeneration,
      nodeId: authority.nodeId,
      bodySha256: receipt.bodySha256,
      certificateDerSha256: receipt.certificateDerSha256,
      publicKeySpkiSha256: receipt.publicKeySpkiSha256,
      transportTrustAnchorSha256: authority.transportTrustAnchorSha256,
      tlsExporterSha256: receipt.tlsExporterSha256,
      proofOfPossessionReceiptSha256: receipt.proofOfPossessionReceiptSha256,
    }),
  );
}

function snapshotHeaders(value: RemoteWorkerRequestHeaders): RemoteWorkerRequestHeaders {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw rejected("Remote worker mesh-node headers are invalid.");
  }
  const snapshot: Record<string, string | readonly string[] | undefined> = Object.create(null) as Record<
    string,
    string | readonly string[] | undefined
  >;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) throw rejected();
    const member = descriptor.value;
    if (member === undefined || typeof member === "string") snapshot[name.toLowerCase()] = member;
    else if (
      Array.isArray(member) &&
      !nodeUtilTypes.isProxy(member) &&
      member.every((item) => typeof item === "string")
    ) {
      snapshot[name.toLowerCase()] = Object.freeze([...member]);
    } else throw rejected();
  }
  return Object.freeze(snapshot);
}

function snapshotTransportIdentity(value: RemoteWorkerTransportIdentity): RemoteWorkerTransportIdentity {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    value.source !== "native_mtls" ||
    !Buffer.isBuffer(value.tlsExporter) ||
    nodeUtilTypes.isProxy(value.tlsExporter) ||
    value.tlsExporter.byteLength !== 32
  ) {
    throw rejected("Remote worker mesh-node transport identity is invalid.");
  }
  const tlsExporter = Buffer.from(value.tlsExporter);
  const snapshot: RemoteWorkerTransportIdentity = Object.freeze({
    source: "native_mtls",
    certificateDerSha256: digest(value.certificateDerSha256),
    publicKeySpkiSha256: digest(value.publicKeySpkiSha256),
    trustAnchorDerSha256: digest(value.trustAnchorDerSha256),
    tlsExporterSha256: digest(value.tlsExporterSha256),
    tlsExporter,
  });
  if (!safeDigestEqual(sha256Bytes(tlsExporter), snapshot.tlsExporterSha256)) {
    tlsExporter.fill(0);
    throw rejected("Remote worker mesh-node TLS exporter binding is invalid.");
  }
  return snapshot;
}

function bearerCredentialSha256(value: string | readonly string[] | undefined): string {
  if (typeof value !== "string") throw rejected("Remote worker mesh-node authorization is invalid.");
  const match = /^Bearer ([A-Za-z0-9._~-]{16,4096})$/u.exec(value);
  if (!match?.[1]) throw rejected("Remote worker mesh-node authorization is invalid.");
  return sha256Utf8(match[1]);
}

function readRawMeshNodeCredential(value: string | readonly string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw rejected("Remote worker mesh-node join credential is invalid.");
  }
  return value;
}

function snapshotClock(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw rejected();
  return new Date(value.getTime());
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !isDigest(value)) throw rejected();
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!isDigest(left) || !isDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejected(message = "Remote worker mesh-node admission rejected."): RemoteWorkerMeshNodeAdmissionError {
  return new RemoteWorkerMeshNodeAdmissionError(message);
}
