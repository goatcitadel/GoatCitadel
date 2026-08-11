import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  buildRemoteWorkerPopV2Preimage,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  type RemoteWorkerPopV2Input,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  signWorkerCredentialPop,
  WorkerPopSignerError,
  workerPopSigningContext,
  type WorkerPopSigningContext,
} from "./worker-pop-signer.js";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";

function keyed(): { context: WorkerPopSigningContext; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const credential: RetainedRuntimeCredential = {
    credentialId: "cred-1",
    credentialGeneration: 3,
    workerGeneration: 2,
    registryWorkspaceId: "workspace-1",
    authorizationCredential: "A".repeat(43),
    clientCertificateSha256: "a".repeat(64),
    workerPublicKeySpkiSha256: "b".repeat(64),
    signingPrivateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  return {
    context: workerPopSigningContext(credential),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

describe("worker PoP v2 signer", () => {
  it("produces an Ed25519 proof that verifies over the exact contract preimage", () => {
    const { context, publicKeyPem } = keyed();
    const signed = signWorkerCredentialPop({
      context,
      rawPath: "/api/v1/remote-workers/assignment-claims",
      operation: "assignment.claim",
      bodySha256: "1".repeat(64),
      tlsExporterSha256: "2".repeat(64),
      idempotencyKey: "idem-key-1",
    });
    const input: RemoteWorkerPopV2Input = {
      schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
      method: "POST",
      rawPath: "/api/v1/remote-workers/assignment-claims",
      operation: "assignment.claim",
      bodySha256: "1".repeat(64),
      nonce: signed.nonce,
      timestamp: signed.timestamp,
      idempotencyKey: "idem-key-1",
      authorityKind: "credential",
      authorityId: "cred-1",
      authorityGeneration: 3,
      workerGeneration: 2,
      tlsExporterSha256: "2".repeat(64),
      clientCertificateSha256: "a".repeat(64),
      workerPublicKeySpkiSha256: "b".repeat(64),
    };
    const preimage = Buffer.from(buildRemoteWorkerPopV2Preimage(input));
    const ok = verify(null, preimage, createPublicKey(publicKeyPem), Buffer.from(signed.proofBase64Url, "base64url"));
    expect(ok).toBe(true);
  });

  it("uses a fresh nonce per call", () => {
    const { context } = keyed();
    const base = {
      context,
      rawPath: "/api/v1/remote-workers/assignment-offer-polls",
      operation: "assignment.offers.poll",
      bodySha256: "1".repeat(64),
      tlsExporterSha256: "2".repeat(64),
      idempotencyKey: "idem-key-1",
    } as const;
    const a = signWorkerCredentialPop(base);
    const b = signWorkerCredentialPop(base);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.proofBase64Url).not.toBe(b.proofBase64Url);
  });

  it("refuses the bootstrap route and malformed digests", () => {
    const { context } = keyed();
    expect(() =>
      signWorkerCredentialPop({
        context,
        rawPath: "/api/v1/remote-workers/bootstrap-exchanges",
        operation: "bootstrap.exchange",
        bodySha256: "1".repeat(64),
        tlsExporterSha256: "2".repeat(64),
        idempotencyKey: "idem-key-1",
      }),
    ).toThrow(WorkerPopSignerError);
    expect(() =>
      signWorkerCredentialPop({
        context,
        rawPath: "/api/v1/remote-workers/assignment-claims",
        operation: "assignment.claim",
        bodySha256: "not-a-digest",
        tlsExporterSha256: "2".repeat(64),
        idempotencyKey: "idem-key-1",
      }),
    ).toThrow(WorkerPopSignerError);
  });
});
