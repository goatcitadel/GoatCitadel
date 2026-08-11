import { createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  buildRemoteWorkerPopV2Preimage,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  resolveRemoteWorkerPopV2Route,
  type RemoteWorkerPopV2Input,
} from "@goatcitadel/contracts";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";

/**
 * The signing pin plus the exact credential/transport identity the worker binds
 * into every protected PoP-v2 proof. Derived directly from the retained
 * credential so a reconnect signs with the same key and authority — never a
 * one-time bootstrap secret.
 */
export interface WorkerPopSigningContext {
  readonly signingPrivateKeyPem: string;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly workerGeneration: number;
  readonly clientCertificateSha256: string;
  readonly workerPublicKeySpkiSha256: string;
}

export interface WorkerSignedPop {
  readonly nonce: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly rawPath: string;
  readonly proofBase64Url: string;
}

export class WorkerPopSignerError extends Error {
  readonly code = "REMOTE_WORKER_POP_SIGNER_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerPopSignerError";
  }
}

export function workerPopSigningContext(credential: RetainedRuntimeCredential): WorkerPopSigningContext {
  return Object.freeze({
    signingPrivateKeyPem: credential.signingPrivateKeyPem,
    credentialId: credential.credentialId,
    credentialGeneration: credential.credentialGeneration,
    workerGeneration: credential.workerGeneration,
    clientCertificateSha256: credential.clientCertificateSha256,
    workerPublicKeySpkiSha256: credential.workerPublicKeySpkiSha256,
  });
}

/**
 * Produce an Ed25519 proof over the exact protected PoP-v2 preimage for one of
 * the credential-authority routes (2-12). The nonce is a fresh 32-byte value
 * per call, so each request consumes a distinct durable nonce Gateway-side and
 * a replay of a captured request is rejected.
 */
export function signWorkerCredentialPop(input: {
  readonly context: WorkerPopSigningContext;
  readonly rawPath: string;
  readonly operation: string;
  readonly bodySha256: string;
  readonly tlsExporterSha256: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
  readonly nonce?: string;
}): WorkerSignedPop {
  const route = resolveRemoteWorkerPopV2Route(input.rawPath, input.operation);
  if (route.authorityKind !== "credential") {
    throw new WorkerPopSignerError("The worker runtime only signs credential-authority routes.");
  }
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  const timestamp = (input.now ?? new Date()).toISOString();
  const preimageInput: RemoteWorkerPopV2Input = {
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    method: "POST",
    rawPath: route.rawPath,
    operation: route.operation,
    bodySha256: assertSha256(input.bodySha256, "request body"),
    nonce,
    timestamp,
    idempotencyKey: input.idempotencyKey,
    authorityKind: "credential",
    authorityId: input.context.credentialId,
    authorityGeneration: input.context.credentialGeneration,
    workerGeneration: input.context.workerGeneration,
    tlsExporterSha256: assertSha256(input.tlsExporterSha256, "TLS exporter"),
    clientCertificateSha256: input.context.clientCertificateSha256,
    workerPublicKeySpkiSha256: input.context.workerPublicKeySpkiSha256,
  };
  const preimage = buildRemoteWorkerPopV2Preimage(preimageInput);
  const privateKey = createPrivateKey(input.context.signingPrivateKeyPem);
  const proof = sign(null, Buffer.from(preimage), privateKey);
  return Object.freeze({
    nonce,
    timestamp,
    idempotencyKey: input.idempotencyKey,
    operation: route.operation,
    rawPath: route.rawPath,
    proofBase64Url: proof.toString("base64url"),
  });
}

function assertSha256(value: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkerPopSignerError(`Worker PoP ${label} digest is invalid.`);
  }
  return value;
}
