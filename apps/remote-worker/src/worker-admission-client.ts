import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import {
  REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerProtectedAdmissionContextSha256,
} from "@goatcitadel/contracts";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";
import {
  WorkerWireClient,
  type WorkerRequestSigningMaterial,
  type WorkerTransportIdentityDigests,
} from "./worker-wire-client.js";

/**
 * The worker's one-time bootstrap admission (route 1, proof protocol v1).
 *
 * This module is the ONLY place the one-time bootstrap secret is used, and its
 * only product is a `RetainedRuntimeCredential`. It never writes the secret
 * anywhere durable; the caller hands the returned credential to the vault,
 * which structurally refuses bootstrap-secret-shaped fields.
 */

export const WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH = "/api/v1/remote-workers/bootstrap-exchanges";
export const WORKER_BOOTSTRAP_EXCHANGE_OPERATION = "bootstrap.exchange";
export const WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-bootstrap-exchange.v1";
export const WORKER_POP_V1_SCHEMA_VERSION = "goatcitadel.remote-worker-pop.v1";

/**
 * The non-secret install-package facts plus the two secrets an operator
 * provisions exactly once: the bootstrap secret and custody of the protected
 * admission signing key. In production the latter lives in the platform's
 * protected key store and never leaves it; a single-host harness provisions it
 * as a PEM so the identical envelope can be produced without a TPM.
 */
export interface WorkerAdmissionTicket {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly nodeId: string;
  readonly targetWorkerGeneration: number;
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeManifestSha256: string;
  readonly runtimeManifestPayloadSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly keysetReceiptSha256: string;
  readonly protectedSignerPrivateKeyPem: string;
  readonly bootstrapSecret: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
}

export class WorkerAdmissionError extends Error {
  readonly code = "REMOTE_WORKER_ADMISSION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "WorkerAdmissionError";
  }
}

/**
 * Run the bootstrap exchange over one fresh mTLS channel and return the
 * reusable runtime credential. The credential's signing pin is the worker's own
 * TLS private key: the Gateway pins the admitted authority to the exact SPKI
 * presented on the channel, so PoP-v2 on every later route is signed by the
 * same key that terminated the handshake.
 */
export async function admitWorker(input: {
  readonly client: WorkerWireClient;
  readonly ticket: WorkerAdmissionTicket;
  readonly clientPrivateKeyPem: string;
  readonly idempotencyKey: string;
}): Promise<RetainedRuntimeCredential> {
  const identity = input.client.identity();
  const privateKey = createPrivateKey(input.clientPrivateKeyPem);
  const evidenceNonce = randomBytes(32).toString("base64url");
  const response = await input.client.post({
    rawPath: WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
    operation: WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    authorization: `GoatWorkerBootstrap ${input.ticket.bootstrapSecret}`,
    idempotencyKey: input.idempotencyKey,
    buildBody: (channel) =>
      Object.freeze({
        schemaVersion: WORKER_POP_V1_SCHEMA_VERSION,
        operation: WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
        authorityId: input.ticket.bootstrapId,
        authorityGeneration: input.ticket.targetWorkerGeneration,
        idempotencyKey: input.idempotencyKey,
        payload: Object.freeze({
          schemaVersion: WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
          publicKeySpkiBase64Url: identity.publicKeySpkiBase64Url,
          protectedAdmissionEvidence: buildProtectedAdmissionEvidence({
            ticket: input.ticket,
            identity,
            tlsExporterSha256: channel.tlsExporterSha256,
            evidenceNonce,
          }),
        }),
      }),
    sign: (material) => signBootstrapPop(material, input.ticket, identity, privateKey),
  });
  if (response.status !== 201) {
    throw new WorkerAdmissionError(`Bootstrap exchange was refused (status ${String(response.status)}).`);
  }
  return retainedCredential(response.body, identity, input.clientPrivateKeyPem);
}

function signBootstrapPop(
  material: WorkerRequestSigningMaterial,
  ticket: WorkerAdmissionTicket,
  identity: WorkerTransportIdentityDigests,
  privateKey: KeyObject,
): string {
  const popMaterial = {
    schemaVersion: WORKER_POP_V1_SCHEMA_VERSION,
    method: "POST",
    rawPath: material.rawPath,
    bodySha256: material.bodySha256,
    operation: material.operation,
    nonce: material.nonce,
    timestamp: material.timestamp,
    idempotencyKey: material.idempotencyKey,
    authorityId: ticket.bootstrapId,
    authorityGeneration: ticket.targetWorkerGeneration,
    tlsExporterSha256: material.tlsExporterSha256,
    certificateDerSha256: identity.clientCertificateSha256,
    publicKeySpkiSha256: identity.publicKeySpkiSha256,
  };
  return sign(null, Buffer.from(canonicalJsonString(popMaterial), "utf8"), privateKey).toString("base64url");
}

/**
 * Produce the fixed 288-byte protected admission envelope and its signer
 * result. The byte layout mirrors the Gateway verifier exactly: magic, version,
 * kind, length, operation id, evidence-nonce digest, worker generation, then
 * the six pinned digests.
 */
export function buildProtectedAdmissionEvidence(input: {
  readonly ticket: WorkerAdmissionTicket;
  readonly identity: WorkerTransportIdentityDigests;
  readonly tlsExporterSha256: string;
  readonly evidenceNonce: string;
}): Readonly<Record<string, unknown>> {
  const { ticket, identity } = input;
  const evidenceNonceSha256 = sha256Utf8(input.evidenceNonce);
  const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: ticket.registryWorkspaceId,
    bootstrapId: ticket.bootstrapId,
    workerId: ticket.workerId,
    nodeId: ticket.nodeId,
    targetWorkerGeneration: ticket.targetWorkerGeneration,
    platform: ticket.platform,
    architecture: ticket.architecture,
    runtimeManifestSha256: ticket.runtimeManifestSha256,
    runtimeManifestPayloadSha256: ticket.runtimeManifestPayloadSha256,
    workspaceCeilingSha256: ticket.workspaceCeilingSha256,
    capabilityCeilingSha256: ticket.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: identity.publicKeySpkiSha256,
    clientCertificateSha256: identity.clientCertificateSha256,
    transportTrustAnchorSha256: identity.trustAnchorSha256,
    tlsExporterSha256: input.tlsExporterSha256,
    evidenceNonceSha256,
    downloadVerificationReceiptSha256: ticket.downloadVerificationReceiptSha256,
    installedTreeAttestationSha256: ticket.installedTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: ticket.installedTreeVerificationReceiptSha256,
  });
  const operationId = Buffer.from(sha256Utf8(`worker-admission:${input.evidenceNonce}`), "hex").subarray(0, 16);
  const envelope = Buffer.alloc(REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES, 8);
  operationId.copy(envelope, 16);
  Buffer.from(evidenceNonceSha256, "hex").copy(envelope, 32);
  envelope.writeBigUInt64LE(BigInt(ticket.targetWorkerGeneration), 64);
  Buffer.from(contextSha256, "hex").copy(envelope, 96);
  Buffer.from(ticket.runtimeManifestSha256, "hex").copy(envelope, 128);
  Buffer.from(identity.publicKeySpkiSha256, "hex").copy(envelope, 160);
  Buffer.from(ticket.downloadVerificationReceiptSha256, "hex").copy(envelope, 192);
  Buffer.from(ticket.installedTreeAttestationSha256, "hex").copy(envelope, 224);
  Buffer.from(ticket.installedTreeVerificationReceiptSha256, "hex").copy(envelope, 256);
  const signerKey = createPrivateKey(ticket.protectedSignerPrivateKeyPem);
  const signerSpkiDer = protectedSignerSpkiDer(ticket.protectedSignerPrivateKeyPem);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelope]),
    signerKey,
  );
  const protectedStateSha256 = sha256Utf8(`worker-protected-state:${ticket.bootstrapId}`);
  const requestBody = Buffer.alloc(384);
  operationId.copy(requestBody, 0);
  Buffer.from(protectedStateSha256, "hex").copy(requestBody, 16);
  requestBody.writeUInt16LE(1, 48);
  requestBody.writeUInt8(2, 50);
  requestBody.writeBigUInt64LE(BigInt(ticket.targetWorkerGeneration), 52);
  Buffer.from(ticket.keysetReceiptSha256, "hex").copy(requestBody, 60);
  requestBody.writeUInt32LE(REMOTE_WORKER_PROTECTED_ADMISSION_ENVELOPE_BYTES, 92);
  envelope.copy(requestBody, 96);
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
    envelopeBase64Url: envelope.toString("base64url"),
    signerResult: Object.freeze({
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
      disposition: "signed",
      operationIdBase64Url: operationId.toString("base64url"),
      workerGeneration: ticket.targetWorkerGeneration,
      envelopeSha256: sha256Bytes(envelope),
      keysetReceiptSha256: ticket.keysetReceiptSha256,
      signerSpkiSha256: sha256Bytes(signerSpkiDer),
      signerSpkiBase64Url: signerSpkiDer.toString("base64url"),
      signatureBase64Url: signature.toString("base64url"),
      protectedStateSha256,
      requestSha256: sha256Bytes(requestBody),
    }),
  });
}

export function protectedSignerSpkiDer(privateKeyPem: string): Buffer {
  const exported = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(exported)) throw new WorkerAdmissionError("Protected signer key is not exportable as DER.");
  return exported;
}

function retainedCredential(
  body: Readonly<Record<string, unknown>>,
  identity: WorkerTransportIdentityDigests,
  clientPrivateKeyPem: string,
): RetainedRuntimeCredential {
  const credential = body["credential"];
  const generation = body["generation"];
  const credentialSecret = body["credentialSecret"];
  if (
    credential === null ||
    typeof credential !== "object" ||
    generation === null ||
    typeof generation !== "object" ||
    typeof credentialSecret !== "string"
  ) {
    throw new WorkerAdmissionError("Bootstrap exchange response did not carry a usable credential.");
  }
  const credentialRecord = credential as Record<string, unknown>;
  const generationRecord = generation as Record<string, unknown>;
  return Object.freeze({
    credentialId: String(credentialRecord["credentialId"]),
    credentialGeneration: Number(credentialRecord["credentialGeneration"]),
    workerGeneration: Number(generationRecord["workerGeneration"]),
    registryWorkspaceId: String(generationRecord["registryWorkspaceId"]),
    authorizationCredential: credentialSecret,
    clientCertificateSha256: identity.clientCertificateSha256,
    workerPublicKeySpkiSha256: identity.publicKeySpkiSha256,
    signingPrivateKeyPem: clientPrivateKeyPem,
  });
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
