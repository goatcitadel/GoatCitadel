import { createHash, X509Certificate } from "node:crypto";

export const REMOTE_WORKER_TLS_EXPORTER_LABEL = "EXPORTER-GoatCitadel-Remote-Worker-v1";
export const REMOTE_WORKER_TLS_EXPORTER_BYTES = 32;

const ALLOWED_HEADER_NAMES = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "idempotency-key",
  "user-agent",
  "x-goatcitadel-worker-nonce",
  "x-goatcitadel-worker-operation",
  "x-goatcitadel-worker-proof",
  "x-goatcitadel-worker-timestamp",
]);

export type RemoteWorkerRequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface RemoteWorkerTransportRequestMetadata {
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly rawHeaders: readonly string[];
}

export interface RemoteWorkerTlsSocketPort {
  readonly encrypted: boolean;
  readonly authorized: boolean;
  readonly authorizationError?: string;
  peerCertificateChainDer(): readonly Buffer[];
  exportKeyingMaterial(length: number, label: string, context: Buffer): Buffer;
}

export interface RemoteWorkerTransportIdentity {
  readonly source: "native_mtls";
  readonly certificateDerSha256: string;
  readonly publicKeySpkiSha256: string;
  readonly trustAnchorDerSha256: string;
  readonly tlsExporterSha256: string;
  /** Channel-binding bytes for the PoP verifier. Never include in diagnostics or logs. */
  readonly tlsExporter: Buffer;
}

export interface RemoteWorkerTransportIdentityDiagnostics {
  readonly source: "native_mtls";
  readonly certificateDerSha256: string;
  readonly publicKeySpkiSha256: string;
  readonly trustAnchorDerSha256: string;
  readonly tlsExporterSha256: string;
}

export class RemoteWorkerTransportIdentityError extends Error {
  readonly code = "REMOTE_WORKER_TRANSPORT_IDENTITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerTransportIdentityError";
  }
}

/**
 * Pure evidence validator for deterministic tests and a future dedicated native-listener issuer.
 * It is not transport authority: production integration remains blocked until the listener can
 * mint a module-private authority from its own `secureConnection` lifecycle.
 */
export function deriveRemoteWorkerTransportIdentityFromPort(input: {
  readonly socket: RemoteWorkerTlsSocketPort;
  readonly request: RemoteWorkerTransportRequestMetadata;
  readonly expectedClientCaSha256: string;
}): RemoteWorkerTransportIdentity {
  inspectRemoteWorkerTransportRequest(input.request);
  if (!/^[0-9a-f]{64}$/u.test(input.expectedClientCaSha256)) {
    throw invalid("Remote worker client CA pin is invalid.");
  }
  if (!input.socket.encrypted || !input.socket.authorized || input.socket.authorizationError !== undefined) {
    throw invalid("Remote worker mutual TLS authorization failed.");
  }
  const chain = input.socket.peerCertificateChainDer();
  if (chain.length < 2 || chain.length > 16) {
    throw invalid("Remote worker certificate chain is incomplete or invalid.");
  }
  const seen = new Set<string>();
  for (const der of chain) {
    if (!Buffer.isBuffer(der) || der.byteLength < 1 || der.byteLength > 64 * 1024) {
      throw invalid("Remote worker certificate chain is invalid.");
    }
    const fingerprint = sha256(der);
    if (seen.has(fingerprint)) {
      throw invalid("Remote worker certificate chain contains a cycle.");
    }
    seen.add(fingerprint);
  }
  const leafDer = chain[0];
  const trustAnchorDer = chain.at(-1);
  if (leafDer === undefined || trustAnchorDer === undefined) {
    throw invalid("Remote worker certificate chain is unavailable.");
  }
  const trustAnchorDerSha256 = sha256(trustAnchorDer);
  if (trustAnchorDerSha256 !== input.expectedClientCaSha256) {
    throw invalid("Remote worker client CA pin did not match.");
  }

  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(leafDer);
  } catch {
    throw invalid("Remote worker peer certificate is invalid.");
  }
  const spkiDer = leaf.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(spkiDer)) {
    throw invalid("Remote worker peer public key is invalid.");
  }
  let tlsExporter: Buffer;
  try {
    tlsExporter = input.socket.exportKeyingMaterial(
      REMOTE_WORKER_TLS_EXPORTER_BYTES,
      REMOTE_WORKER_TLS_EXPORTER_LABEL,
      Buffer.alloc(0),
    );
  } catch {
    throw invalid("Remote worker TLS channel binding is unavailable.");
  }
  if (!Buffer.isBuffer(tlsExporter) || tlsExporter.byteLength !== REMOTE_WORKER_TLS_EXPORTER_BYTES) {
    throw invalid("Remote worker TLS channel binding is invalid.");
  }

  return Object.freeze({
    source: "native_mtls",
    certificateDerSha256: sha256(leafDer),
    publicKeySpkiSha256: sha256(spkiDer),
    trustAnchorDerSha256,
    tlsExporterSha256: sha256(tlsExporter),
    tlsExporter: Buffer.from(tlsExporter),
  });
}

export function remoteWorkerTransportIdentityDiagnostics(
  identity: RemoteWorkerTransportIdentity,
): RemoteWorkerTransportIdentityDiagnostics {
  return Object.freeze({
    source: identity.source,
    certificateDerSha256: identity.certificateDerSha256,
    publicKeySpkiSha256: identity.publicKeySpkiSha256,
    trustAnchorDerSha256: identity.trustAnchorDerSha256,
    tlsExporterSha256: identity.tlsExporterSha256,
  });
}

export function inspectRemoteWorkerTransportRequest(request: RemoteWorkerTransportRequestMetadata): void {
  if (
    request.rawPath.length < 1 ||
    request.rawPath.length > 2_048 ||
    !request.rawPath.startsWith("/") ||
    request.rawPath.includes("?") ||
    request.rawPath.includes("#") ||
    /\p{Cc}/u.test(request.rawPath)
  ) {
    throw invalid("Remote worker request path is invalid.");
  }
  if (request.rawHeaders.length % 2 !== 0) {
    throw invalid("Remote worker request headers are malformed.");
  }
  const rawCounts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index];
    const rawValue = request.rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined) {
      throw invalid("Remote worker request headers are malformed.");
    }
    const name = rawName.toLowerCase();
    if (!ALLOWED_HEADER_NAMES.has(name) || /[\r\n]/u.test(rawValue)) {
      throw invalid("Remote worker request includes a forbidden transport header.");
    }
    rawCounts.set(name, (rawCounts.get(name) ?? 0) + 1);
  }
  for (const count of rawCounts.values()) {
    if (count !== 1) {
      throw invalid("Remote worker request includes a duplicate transport header.");
    }
  }

  const normalizedObjectNames = new Set<string>();
  for (const [rawName, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (!ALLOWED_HEADER_NAMES.has(name) || normalizedObjectNames.has(name)) {
      throw invalid("Remote worker request includes a forbidden transport header.");
    }
    normalizedObjectNames.add(name);
    if (Array.isArray(value) || typeof value !== "string" || /[\r\n]/u.test(value)) {
      throw invalid("Remote worker request includes a duplicate or invalid transport header.");
    }
    if ((rawCounts.get(name) ?? 0) !== 1) {
      throw invalid("Remote worker request header projection is inconsistent.");
    }
  }
  for (const name of rawCounts.keys()) {
    if (!normalizedObjectNames.has(name)) {
      throw invalid("Remote worker request header projection is inconsistent.");
    }
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(message: string): RemoteWorkerTransportIdentityError {
  return new RemoteWorkerTransportIdentityError(message);
}
