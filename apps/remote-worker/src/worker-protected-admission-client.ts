import { createHash, createPublicKey, verify } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN,
  assertRemoteWorkerGenerationRecord,
  assertRemoteWorkerRuntimeCredentialRecord,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
} from "@goatcitadel/contracts";
import {
  buildWorkerAdmissionEnvelope,
  WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
  WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
  WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
  WorkerAdmissionError,
  type WorkerAdmissionTicket,
} from "./worker-admission-client.js";
import {
  requireWorkerProtectedKeyOwner,
  signWorkerProtectedPop,
  workerProtectedKeySpkiSha256,
  workerProtectedPublicSpki,
  type WorkerProtectedKeyOwner,
} from "./worker-protected-key-owner.js";
import type { RetainedProtectedRuntimeCredential } from "./worker-credential-vault.js";
import type { WorkerWireClient } from "./worker-wire-client.js";

export interface WorkerProtectedAdmissionTicket extends Omit<WorkerAdmissionTicket, "protectedSignerPrivateKeyPem"> {
  readonly protectedSignerPrivateKeyPem?: never;
  readonly protectedSignerPublicKeySpkiBase64Url: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function verifyEvidence(
  raw: RemoteWorkerProtectedAdmissionEvidenceWire,
  envelope: Buffer,
  owner: WorkerProtectedKeyOwner,
): RemoteWorkerProtectedAdmissionEvidenceWire {
  const evidence = normalizeRemoteWorkerProtectedAdmissionEvidenceWire(raw);
  const result = evidence.signerResult;
  const publicKey = workerProtectedPublicSpki(owner.admissionSignerSpkiBase64Url);
  const request = Buffer.alloc(384);
  envelope.copy(request, 96);
  envelope.copy(request, 0, 16, 32);
  Buffer.from(owner.reference.protectedStateSha256, "hex").copy(request, 16);
  request.writeUInt16LE(1, 48);
  request[50] = 2;
  request.writeBigUInt64LE(BigInt(owner.reference.keysetGeneration), 52);
  Buffer.from(owner.reference.keysetReceiptSha256, "hex").copy(request, 60);
  request.writeUInt32LE(envelope.length, 92);
  if (
    evidence.envelopeBase64Url !== envelope.toString("base64url") ||
    result.operationIdBase64Url !== envelope.subarray(16, 32).toString("base64url") ||
    result.workerGeneration !== owner.reference.keysetGeneration ||
    result.envelopeSha256 !== sha256(envelope) ||
    result.keysetReceiptSha256 !== owner.reference.keysetReceiptSha256 ||
    result.protectedStateSha256 !== owner.reference.protectedStateSha256 ||
    result.requestSha256 !== sha256(request) ||
    result.signerSpkiBase64Url !== owner.admissionSignerSpkiBase64Url ||
    result.signerSpkiSha256 !== sha256(publicKey) ||
    !verify(
      null,
      Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelope]),
      createPublicKey({ key: publicKey, format: "der", type: "spki" }),
      Buffer.from(result.signatureBase64Url, "base64url"),
    )
  )
    throw new WorkerAdmissionError("Native admission evidence does not bind the original request and signer.");
  return evidence;
}

export async function admitProtectedWorker(input: {
  readonly client: WorkerWireClient;
  readonly ticket: WorkerProtectedAdmissionTicket;
  readonly protectedKeys: WorkerProtectedKeyOwner;
  readonly idempotencyKey: string;
}): Promise<RetainedProtectedRuntimeCredential> {
  const ticket = Object.freeze({ ...input.ticket });
  if (Object.prototype.hasOwnProperty.call(ticket, "protectedSignerPrivateKeyPem"))
    throw new WorkerAdmissionError("Protected admission cannot accept a PEM signing key.");
  const owner = requireWorkerProtectedKeyOwner(input.protectedKeys.reference, input.protectedKeys);
  const client = input.client;
  const idempotencyKey = input.idempotencyKey;
  const identity = Object.freeze({ ...client.identity() });
  if (
    owner.reference.keysetGeneration !== ticket.targetWorkerGeneration ||
    owner.reference.keysetReceiptSha256 !== ticket.keysetReceiptSha256 ||
    owner.reference.workerPublicKeySpkiBase64Url !== identity.publicKeySpkiBase64Url ||
    workerProtectedKeySpkiSha256(owner.reference) !== identity.publicKeySpkiSha256 ||
    owner.admissionSignerSpkiBase64Url !== ticket.protectedSignerPublicKeySpkiBase64Url
  )
    throw new WorkerAdmissionError("Protected admission ticket, TLS identity and native key authority differ.");
  const response = await client.post({
    rawPath: WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
    operation: WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    authorization: `GoatWorkerBootstrap ${ticket.bootstrapSecret}`,
    idempotencyKey,
    buildBody: async (channel) => {
      const envelope = buildWorkerAdmissionEnvelope({
        ticket,
        identity,
        tlsExporterSha256: channel.tlsExporterSha256,
        evidenceNonce: channel.nonce,
      });
      channel.signal.throwIfAborted();
      const evidence = await owner.signAdmissionEnvelope({
        reference: owner.reference,
        envelope: Buffer.from(envelope),
        signal: channel.signal,
      });
      channel.signal.throwIfAborted();
      return Object.freeze({
        schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
        operation: WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
        authorityId: ticket.bootstrapId,
        authorityGeneration: ticket.targetWorkerGeneration,
        workerGeneration: ticket.targetWorkerGeneration,
        idempotencyKey,
        payload: Object.freeze({
          schemaVersion: WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
          publicKeySpkiBase64Url: identity.publicKeySpkiBase64Url,
          protectedAdmissionEvidence: verifyEvidence(evidence, envelope, owner),
        }),
      });
    },
    sign: (material) => {
      if (
        material.rawPath !== WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH ||
        material.operation !== WORKER_BOOTSTRAP_EXCHANGE_OPERATION
      )
        throw new WorkerAdmissionError("Protected admission proof requires the bootstrap route.");
      return signWorkerProtectedPop({
        reference: owner.reference,
        owner,
        signal: material.signal,
        material: {
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          method: "POST",
          rawPath: WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
          operation: WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
          bodySha256: material.bodySha256,
          nonce: material.nonce,
          timestamp: material.timestamp,
          idempotencyKey: material.idempotencyKey,
          authorityKind: "bootstrap",
          authorityId: ticket.bootstrapId,
          authorityGeneration: ticket.targetWorkerGeneration,
          workerGeneration: ticket.targetWorkerGeneration,
          tlsExporterSha256: material.tlsExporterSha256,
          clientCertificateSha256: identity.clientCertificateSha256,
          workerPublicKeySpkiSha256: identity.publicKeySpkiSha256,
        },
      });
    },
  });
  if (response.status !== 201 || response.body.disposition !== "admitted")
    throw new WorkerAdmissionError(
      "Protected bootstrap exchange did not return a fresh credential; reconcile its outcome.",
    );
  const generation = response.body.generation;
  const credential = response.body.credential;
  assertRemoteWorkerGenerationRecord(generation);
  assertRemoteWorkerRuntimeCredentialRecord(credential);
  const secret = response.body.credentialSecret;
  if (
    generation.workerId !== ticket.workerId ||
    generation.nodeId !== ticket.nodeId ||
    generation.bootstrapId !== ticket.bootstrapId ||
    generation.registryWorkspaceId !== ticket.registryWorkspaceId ||
    generation.workerGeneration !== ticket.targetWorkerGeneration ||
    generation.publicKeySpkiSha256 !== identity.publicKeySpkiSha256 ||
    generation.clientCertificateSha256 !== identity.clientCertificateSha256 ||
    generation.runtimeManifestSha256 !== ticket.runtimeManifestSha256 ||
    generation.workspaceCeilingSha256 !== ticket.workspaceCeilingSha256 ||
    generation.capabilityCeilingSha256 !== ticket.capabilityCeilingSha256 ||
    generation.downloadVerificationReceiptSha256 !== ticket.downloadVerificationReceiptSha256 ||
    generation.installedTreeAttestationSha256 !== ticket.installedTreeAttestationSha256 ||
    generation.installedTreeVerificationReceiptSha256 !== ticket.installedTreeVerificationReceiptSha256 ||
    generation.exchangeIdempotencyKey !== idempotencyKey ||
    generation.transportIdentitySource !== "native_mtls" ||
    generation.transportTrustAnchorSha256 !== identity.trustAnchorSha256 ||
    credential.workerId !== ticket.workerId ||
    credential.registryWorkspaceId !== ticket.registryWorkspaceId ||
    credential.workerGeneration !== ticket.targetWorkerGeneration ||
    credential.claims.workspaceCeilingSha256 !== ticket.workspaceCeilingSha256 ||
    credential.claims.capabilityCeilingSha256 !== ticket.capabilityCeilingSha256 ||
    response.body.authorizationScheme !== "Bearer" ||
    response.body.secretDisposition !== "returned_once" ||
    typeof secret !== "string" ||
    Buffer.from(secret, "base64url").length !== 32 ||
    Buffer.from(secret, "base64url").toString("base64url") !== secret
  )
    throw new WorkerAdmissionError("Protected bootstrap response differs from admitted authority.");
  return Object.freeze({
    credentialId: credential.credentialId,
    credentialGeneration: credential.credentialGeneration,
    workerGeneration: generation.workerGeneration,
    registryWorkspaceId: generation.registryWorkspaceId,
    authorizationCredential: secret,
    clientCertificateSha256: identity.clientCertificateSha256,
    workerPublicKeySpkiSha256: identity.publicKeySpkiSha256,
    protectedKey: owner.reference,
  });
}
