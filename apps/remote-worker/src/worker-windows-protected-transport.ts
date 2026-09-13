import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { basename, isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import type { WorkerContextTransportMaterial } from "./worker-wire-client.js";
import { createWindowsProtectedWorkerKeyOwner } from "./worker-windows-protected-key-owner.js";
import type { WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";

/** Trusted composition port. Never reconstruct this interface from runtime JSON. */
export interface WindowsWorkerImageGuard {
  pin(identifier: string): { readonly adapterPath: string; readonly lease: object };
}

type PublicTransport = Omit<WorkerContextTransportMaterial, "clientTlsContext" | "clientPrivateKeyPem">;
const imageLeases = new WeakMap<object, object>();
const requireNative = createRequire(import.meta.url);

function installedImageGuard(): WindowsWorkerImageGuard {
  try {
    // Fixed package-relative trust root. Configuration cannot choose a native addon.
    const guard: unknown = requireNative(
      fileURLToPath(new URL("../native/GoatCitadelRemoteWorkerImageGuard.node", import.meta.url)),
    );
    if (!guard || typeof guard !== "object" || !("pin" in guard) || typeof guard.pin !== "function")
      throw new Error("The installed image guard has an unsupported API.");
    return guard as WindowsWorkerImageGuard;
  } catch (error) {
    throw new Error("The installed native image guard is unavailable.", { cause: error });
  }
}

/** Pin native images before loading TLS, and retain those pins with both runtime owners. */
export function createWindowsProtectedWorkerTransport(
  input: {
    readonly transport: PublicTransport;
    readonly tlsKeyIdentifier: string;
    readonly admissionSignerSpkiBase64Url: string;
  },
  imageGuard?: WindowsWorkerImageGuard,
): {
  readonly transport: WorkerContextTransportMaterial;
  readonly protectedKeys: WorkerProtectedKeyOwner;
} {
  if (process.platform !== "win32") throw new Error("Protected Windows transport requires Windows.");
  const material = Object.freeze({ ...input.transport });
  if (Object.hasOwn(material, "clientPrivateKeyPem") || Object.hasOwn(material, "clientTlsContext"))
    throw new Error("Protected transport cannot accept a private key or an existing TLS context.");
  const identifier = input.tlsKeyIdentifier;
  const protectedKeys = createWindowsProtectedWorkerKeyOwner({
    tlsKeyIdentifier: identifier,
    admissionSignerSpkiBase64Url: input.admissionSignerSpkiBase64Url,
  });
  const publicSpki = new X509Certificate(material.clientCertificatePem).publicKey.export({
    type: "spki",
    format: "der",
  });
  if (publicSpki.toString("base64url") !== protectedKeys.reference.workerPublicKeySpkiBase64Url)
    throw new Error("The protected key reference differs from the worker TLS certificate.");
  const pinned = (imageGuard ?? installedImageGuard()).pin(identifier);
  if (
    !pinned ||
    typeof pinned.adapterPath !== "string" ||
    !isAbsolute(pinned.adapterPath) ||
    basename(pinned.adapterPath) !== "GoatCitadelRemoteWorkerTlsKey.dll" ||
    !pinned.lease ||
    typeof pinned.lease !== "object"
  )
    throw new Error("The native image guard returned an invalid lease.");
  const clientTlsContext = createSecureContext({
    ca: material.trustAnchorPem,
    cert: material.clientCertificatePem,
    privateKeyEngine: pinned.adapterPath,
    privateKeyIdentifier: identifier,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });
  // Keep directory and image handles alive even if only one owner remains reachable.
  // The addon finalizer closes them once neither owner retains the native lease.
  imageLeases.set(clientTlsContext, pinned.lease);
  imageLeases.set(protectedKeys, pinned.lease);
  return Object.freeze({ transport: Object.freeze({ ...material, clientTlsContext }), protectedKeys });
}
