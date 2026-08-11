import { createHash, createPublicKey } from "node:crypto";
import type { RemoteWorkerRuntimeManifest } from "@goatcitadel/contracts";
import {
  verifyRemoteWorkerRuntimeManifestSignature,
  type RemoteWorkerManifestVerificationReceipt,
} from "./remote-worker-attestation-service.js";
import { readRemoteWorkerNoFollowFile } from "./remote-worker-installed-tree-scanner.js";
import { parseRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

const MANIFEST_SIGNER_PUBLIC_KEY_MAX_BYTES = 16 * 1024;

export interface RemoteWorkerManifestVerifierPort {
  verify(manifest: RemoteWorkerRuntimeManifest): Promise<RemoteWorkerManifestVerificationReceipt>;
}

export class RemoteWorkerManifestVerifierUnavailableError extends Error {
  readonly code = "REMOTE_WORKER_MANIFEST_VERIFIER_UNAVAILABLE";

  public constructor() {
    super("Remote worker manifest verification is unavailable.");
    this.name = "RemoteWorkerManifestVerifierUnavailableError";
  }
}

export class RemoteWorkerManifestRejectedError extends Error {
  readonly code = "REMOTE_WORKER_MANIFEST_REJECTED";

  public constructor() {
    super("Remote worker runtime manifest verification failed.");
    this.name = "RemoteWorkerManifestRejectedError";
  }
}

/**
 * Creates the operator-control verification port without loading or retaining
 * the remote-worker TLS server key. The pinned signer public key is opened
 * through the same no-follow reader as installed-tree evidence and is released
 * after each verification attempt so runtime trust changes fail closed.
 */
export function createConfiguredRemoteWorkerManifestVerifier(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RemoteWorkerManifestVerifierPort {
  return Object.freeze({
    verify: async (manifest: RemoteWorkerRuntimeManifest): Promise<RemoteWorkerManifestVerificationReceipt> => {
      let config;
      try {
        config = parseRemoteWorkerRuntimeConfig(env);
      } catch {
        throw new RemoteWorkerManifestVerifierUnavailableError();
      }
      if (!config.enabled) {
        throw new RemoteWorkerManifestVerifierUnavailableError();
      }

      let signerFileBytes: Buffer | undefined;
      let signerSpkiDer: Buffer | undefined;
      try {
        signerFileBytes = await readRemoteWorkerNoFollowFile(
          config.manifestSigner.publicKeyFile,
          MANIFEST_SIGNER_PUBLIC_KEY_MAX_BYTES,
        );
        signerSpkiDer = parsePinnedEd25519SignerSpki(signerFileBytes, config.manifestSigner.spkiSha256);
      } catch (error) {
        if (error instanceof RemoteWorkerManifestVerifierUnavailableError) throw error;
        throw new RemoteWorkerManifestVerifierUnavailableError();
      } finally {
        signerFileBytes?.fill(0);
      }

      try {
        return verifyRemoteWorkerRuntimeManifestSignature({
          manifest,
          expectedSignerKeyId: config.manifestSigner.keyId,
          expectedSignerSpkiSha256: config.manifestSigner.spkiSha256,
          signerPublicKeySpkiDer: signerSpkiDer,
        });
      } catch {
        throw new RemoteWorkerManifestRejectedError();
      } finally {
        signerSpkiDer.fill(0);
      }
    },
  });
}

function parsePinnedEd25519SignerSpki(value: Buffer, expectedSpkiSha256: string): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength < 1 || value.includes(0)) {
    throw new RemoteWorkerManifestVerifierUnavailableError();
  }
  const text = value.toString("ascii");
  if (Buffer.byteLength(text, "ascii") !== value.byteLength) {
    throw new RemoteWorkerManifestVerifierUnavailableError();
  }
  const match = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END PUBLIC KEY-----\r?\n?$/u.exec(text);
  if (!match || match[0].length !== text.length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(match[1]!.replace(/[\r\n]/gu, ""))) {
    throw new RemoteWorkerManifestVerifierUnavailableError();
  }
  const encoded = match[1]!.replace(/[\r\n]/gu, "");
  const der = Buffer.from(encoded, "base64");
  try {
    if (der.byteLength < 1 || der.toString("base64") !== encoded) {
      throw new RemoteWorkerManifestVerifierUnavailableError();
    }
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new RemoteWorkerManifestVerifierUnavailableError();
    }
    const canonicalSpki = key.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(canonicalSpki) || sha256(canonicalSpki) !== expectedSpkiSha256) {
      if (Buffer.isBuffer(canonicalSpki)) canonicalSpki.fill(0);
      throw new RemoteWorkerManifestVerifierUnavailableError();
    }
    return canonicalSpki;
  } catch (error) {
    if (error instanceof RemoteWorkerManifestVerifierUnavailableError) throw error;
    throw new RemoteWorkerManifestVerifierUnavailableError();
  } finally {
    der.fill(0);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
