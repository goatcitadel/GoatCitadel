import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import { readRemoteWorkerNoFollowFile } from "./remote-worker-installed-tree-scanner.js";

export const REMOTE_WORKER_TRUST_MATERIAL_LIMITS = Object.freeze({
  serverCertificateChainBytes: 1024 * 1024,
  serverPrivateKeyBytes: 64 * 1024,
  clientCaCertificateBytes: 256 * 1024,
  manifestSignerPublicKeyBytes: 16 * 1024,
});

export interface RemoteWorkerTrustMaterialDiagnostics {
  readonly serverCertificateChainLength: number;
  readonly serverLeafCertificateDerSha256: string;
  readonly clientCaCertificateDerSha256: string;
  readonly manifestSignerSpkiSha256: string;
  readonly serverKeyAlgorithm: "rsa" | "rsa-pss" | "ec" | "ed25519";
}

export interface RemoteWorkerTrustMaterial {
  tlsServerOptions(): Readonly<{
    readonly cert: Buffer;
    readonly key: Buffer;
    readonly ca: Buffer;
    dispose(): void;
  }>;
  manifestSignerPublicKeySpkiDer(): Buffer;
  diagnostics(): RemoteWorkerTrustMaterialDiagnostics;
  dispose(): void;
}

interface PemBlock {
  readonly label: string;
  readonly der: Buffer;
}

export class RemoteWorkerTrustMaterialError extends Error {
  readonly code = "REMOTE_WORKER_TRUST_MATERIAL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerTrustMaterialError";
  }
}

export async function loadRemoteWorkerTrustMaterial(
  config: EnabledRemoteWorkerRuntimeConfig,
  now: Date = new Date(),
): Promise<RemoteWorkerTrustMaterial> {
  const clockMs = now.getTime();
  if (!Number.isFinite(clockMs)) throw invalid("Remote worker trust-material clock is invalid.");
  let serverCertificateBytes: Buffer | undefined;
  let serverKeyBytes: Buffer | undefined;
  let clientCaBytes: Buffer | undefined;
  let signerBytes: Buffer | undefined;
  try {
    serverCertificateBytes = await readRemoteWorkerNoFollowFile(
      config.tls.serverCertificateFile,
      REMOTE_WORKER_TRUST_MATERIAL_LIMITS.serverCertificateChainBytes,
    );
    serverKeyBytes = await readRemoteWorkerNoFollowFile(
      config.tls.serverKeyFile,
      REMOTE_WORKER_TRUST_MATERIAL_LIMITS.serverPrivateKeyBytes,
    );
    clientCaBytes = await readRemoteWorkerNoFollowFile(
      config.tls.clientCaFile,
      REMOTE_WORKER_TRUST_MATERIAL_LIMITS.clientCaCertificateBytes,
    );
    signerBytes = await readRemoteWorkerNoFollowFile(
      config.manifestSigner.publicKeyFile,
      REMOTE_WORKER_TRUST_MATERIAL_LIMITS.manifestSignerPublicKeyBytes,
    );

    const serverCertificates = parseCertificateChain(serverCertificateBytes, 16);
    const serverLeaf = serverCertificates[0] as X509Certificate;
    assertServerCertificateChain(serverCertificates, clockMs);
    const privateKey = readUnencryptedPrivateKey(serverKeyBytes);
    const keyAlgorithm = serverKeyAlgorithm(privateKey);
    assertServerLeafMatchesKey(serverLeaf, privateKey, keyAlgorithm);

    const clientCaBlocks = parsePemBlocks(clientCaBytes, new Set(["CERTIFICATE"]), 1);
    if (clientCaBlocks.length !== 1) throw invalid("Remote worker client CA bundle is ambiguous.");
    const clientCa = readCertificate(clientCaBlocks[0] as PemBlock);
    assertClientCa(clientCa, clockMs);
    const clientCaDerSha256 = sha256(clientCa.raw);
    if (!safeDigestEqual(clientCaDerSha256, config.tls.clientCaSha256)) {
      throw invalid("Remote worker client CA certificate pin did not match.");
    }

    const signerBlocks = parsePemBlocks(signerBytes, new Set(["PUBLIC KEY"]), 1);
    if (signerBlocks.length !== 1) throw invalid("Remote worker manifest signer key is ambiguous.");
    const signerKey = readEd25519PublicKey(signerBlocks[0] as PemBlock);
    const signerSpkiDer = signerKey.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(signerSpkiDer)) throw invalid("Remote worker manifest signer key is invalid.");
    const signerSpkiSha256 = sha256(signerSpkiDer);
    if (!safeDigestEqual(signerSpkiSha256, config.manifestSigner.spkiSha256)) {
      signerSpkiDer.fill(0);
      throw invalid("Remote worker manifest signer key pin did not match.");
    }

    const serverCertificatePem = Buffer.concat(
      serverCertificates.map((certificate) => pemFromDer("CERTIFICATE", certificate.raw)),
    );
    const clientCaPem = pemFromDer("CERTIFICATE", clientCa.raw);
    return createTrustMaterial({
      serverCertificatePem,
      privateKey,
      clientCaPem,
      signerSpkiDer,
      diagnostics: Object.freeze({
        serverCertificateChainLength: serverCertificates.length,
        serverLeafCertificateDerSha256: sha256(serverLeaf.raw),
        clientCaCertificateDerSha256: clientCaDerSha256,
        manifestSignerSpkiSha256: signerSpkiSha256,
        serverKeyAlgorithm: keyAlgorithm,
      }),
    });
  } catch (error) {
    if (error instanceof RemoteWorkerTrustMaterialError) throw error;
    throw invalid("Remote worker trust material could not be loaded.");
  } finally {
    serverKeyBytes?.fill(0);
    serverCertificateBytes?.fill(0);
    clientCaBytes?.fill(0);
    signerBytes?.fill(0);
  }
}

function createTrustMaterial(input: {
  readonly serverCertificatePem: Buffer;
  readonly privateKey: KeyObject;
  readonly clientCaPem: Buffer;
  readonly signerSpkiDer: Buffer;
  readonly diagnostics: RemoteWorkerTrustMaterialDiagnostics;
}): RemoteWorkerTrustMaterial {
  let disposed = false;
  const requireActive = (): void => {
    if (disposed) throw invalid("Remote worker trust material is no longer active.");
  };
  const material = Object.assign(Object.create(null) as Record<string, unknown>, {
    tlsServerOptions: (): ReturnType<RemoteWorkerTrustMaterial["tlsServerOptions"]> => {
      requireActive();
      const cert = Buffer.from(input.serverCertificatePem);
      const exportedKey = input.privateKey.export({ format: "pem", type: "pkcs8" });
      const key = Buffer.isBuffer(exportedKey) ? Buffer.from(exportedKey) : Buffer.from(exportedKey, "ascii");
      const ca = Buffer.from(input.clientCaPem);
      let released = false;
      return Object.freeze({
        cert,
        key,
        ca,
        dispose: (): void => {
          if (released) return;
          released = true;
          cert.fill(0);
          key.fill(0);
          ca.fill(0);
        },
      });
    },
    manifestSignerPublicKeySpkiDer: (): Buffer => {
      requireActive();
      return Buffer.from(input.signerSpkiDer);
    },
    diagnostics: (): RemoteWorkerTrustMaterialDiagnostics => input.diagnostics,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      input.serverCertificatePem.fill(0);
      input.clientCaPem.fill(0);
      input.signerSpkiDer.fill(0);
    },
  });
  return Object.freeze(material) as unknown as RemoteWorkerTrustMaterial;
}

function parseCertificateChain(value: Buffer, maximumCertificates: number): X509Certificate[] {
  const blocks = parsePemBlocks(value, new Set(["CERTIFICATE"]), maximumCertificates);
  if (blocks.length < 1) throw invalid("Remote worker server certificate chain is empty.");
  return blocks.map(readCertificate);
}

function parsePemBlocks(value: Buffer, allowedLabels: ReadonlySet<string>, maximumBlocks: number): PemBlock[] {
  if (!Buffer.isBuffer(value) || value.byteLength < 1 || value.includes(0)) {
    throw invalid("Remote worker PEM material is invalid.");
  }
  const text = value.toString("ascii");
  if (Buffer.byteLength(text, "ascii") !== value.byteLength || !isAllowedPemAscii(value)) {
    throw invalid("Remote worker PEM material is invalid.");
  }
  const pattern = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END \1-----\r?\n?/gu;
  const blocks: PemBlock[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== cursor || !allowedLabels.has(match[1] as string) || blocks.length >= maximumBlocks) {
      throw invalid("Remote worker PEM material is ambiguous or unsupported.");
    }
    const encoded = (match[2] as string).replace(/[\r\n]/gu, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw invalid("Remote worker PEM material is invalid.");
    const der = Buffer.from(encoded, "base64");
    if (der.byteLength < 1 || der.toString("base64") !== encoded)
      throw invalid("Remote worker PEM material is invalid.");
    blocks.push(Object.freeze({ label: match[1] as string, der }));
    cursor = (match.index as number) + match[0].length;
  }
  if (blocks.length < 1 || cursor !== text.length) {
    for (const block of blocks) block.der.fill(0);
    throw invalid("Remote worker PEM material is invalid or contains extra data.");
  }
  return blocks;
}

function readCertificate(block: PemBlock): X509Certificate {
  try {
    return new X509Certificate(block.der);
  } catch {
    throw invalid("Remote worker certificate is invalid.");
  }
}

function readUnencryptedPrivateKey(value: Buffer): KeyObject {
  if (containsAscii(value, "ENCRYPTED PRIVATE KEY") || containsAscii(value, "Proc-Type: 4,ENCRYPTED")) {
    throw invalid("Remote worker encrypted server keys require an unsupported secret owner.");
  }
  const text = value.toString("ascii");
  if (Buffer.byteLength(text, "ascii") !== value.byteLength || !isAllowedPemAscii(value)) {
    throw invalid("Remote worker server private key PEM is invalid.");
  }
  const match =
    /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END \1-----\r?\n?$/u.exec(
      text,
    );
  if (
    match === null ||
    match[0].length !== text.length ||
    countAscii(value, "-----BEGIN ") !== 1 ||
    countAscii(value, "-----END ") !== 1
  ) {
    throw invalid("Remote worker server private key PEM is ambiguous or contains extra data.");
  }
  const encoded = (match[2] as string).replace(/[\r\n]/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw invalid("Remote worker server private key PEM is invalid.");
  const der = Buffer.from(encoded, "base64");
  if (der.byteLength < 1 || der.toString("base64") !== encoded) {
    der.fill(0);
    throw invalid("Remote worker server private key PEM is invalid.");
  }
  try {
    const type = match[1] === "PRIVATE KEY" ? "pkcs8" : match[1] === "RSA PRIVATE KEY" ? "pkcs1" : "sec1";
    return createPrivateKey({ key: der, format: "der", type });
  } catch {
    throw invalid("Remote worker server private key is invalid.");
  } finally {
    der.fill(0);
  }
}

function readEd25519PublicKey(block: PemBlock): KeyObject {
  try {
    const key = createPublicKey({ key: block.der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong algorithm");
    return key;
  } catch {
    throw invalid("Remote worker manifest signer key algorithm is invalid.");
  }
}

function assertServerCertificateChain(certificates: readonly X509Certificate[], nowMs: number): void {
  const leaf = certificates[0] as X509Certificate;
  if (leaf.ca) throw invalid("Remote worker server leaf certificate must not be a CA.");
  assertCertificateValidity(leaf, nowMs, "server leaf");
  const keyUsage = leaf.keyUsage;
  if (keyUsage !== undefined && !keyUsage.includes("1.3.6.1.5.5.7.3.1")) {
    throw invalid("Remote worker server leaf certificate is not valid for TLS server use.");
  }
  for (let index = 1; index < certificates.length; index += 1) {
    const certificate = certificates[index] as X509Certificate;
    const issuer = certificates[index + 1];
    if (!certificate.ca) throw invalid("Remote worker server certificate chain contains a non-CA issuer.");
    assertCertificateValidity(certificate, nowMs, "server issuer");
    assertCertificatePublicKeyStrength(certificate, "server issuer");
    if (issuer !== undefined && (!certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey))) {
      throw invalid("Remote worker server certificate chain signature is invalid.");
    }
  }
  const directIssuer = certificates[1];
  if (directIssuer !== undefined && (!leaf.checkIssued(directIssuer) || !leaf.verify(directIssuer.publicKey))) {
    throw invalid("Remote worker server leaf certificate chain signature is invalid.");
  }
}

function assertClientCa(certificate: X509Certificate, nowMs: number): void {
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
    throw invalid("Remote worker client CA must be one unambiguous self-signed CA certificate.");
  }
  assertCertificateValidity(certificate, nowMs, "client CA");
  assertCertificatePublicKeyStrength(certificate, "client CA");
}

function assertCertificatePublicKeyStrength(certificate: X509Certificate, label: string): void {
  const key = certificate.publicKey;
  if (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") {
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) {
      throw invalid(`Remote worker ${label} RSA key is below the minimum strength.`);
    }
    return;
  }
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve !== "prime256v1" && curve !== "secp384r1" && curve !== "secp521r1") {
      throw invalid(`Remote worker ${label} EC key curve is unsupported.`);
    }
    return;
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw invalid(`Remote worker ${label} key algorithm is unsupported.`);
  }
}

function assertCertificateValidity(certificate: X509Certificate, nowMs: number, label: string): void {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || nowMs < validFrom || nowMs > validTo) {
    throw invalid(`Remote worker ${label} certificate is outside its validity period.`);
  }
}

function serverKeyAlgorithm(key: KeyObject): RemoteWorkerTrustMaterialDiagnostics["serverKeyAlgorithm"] {
  if (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") {
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) {
      throw invalid("Remote worker server RSA key is below the minimum strength.");
    }
    return key.asymmetricKeyType;
  }
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve !== "prime256v1" && curve !== "secp384r1" && curve !== "secp521r1") {
      throw invalid("Remote worker server EC key curve is unsupported.");
    }
    return key.asymmetricKeyType;
  }
  if (key.asymmetricKeyType === "ed25519") {
    return key.asymmetricKeyType;
  }
  throw invalid("Remote worker server key algorithm is unsupported.");
}

function assertServerLeafMatchesKey(
  leaf: X509Certificate,
  privateKey: KeyObject,
  keyAlgorithm: RemoteWorkerTrustMaterialDiagnostics["serverKeyAlgorithm"],
): void {
  try {
    const publicFromKey = createPublicKey(privateKey);
    if (publicFromKey.asymmetricKeyType !== keyAlgorithm || !leaf.checkPrivateKey(privateKey)) {
      throw new Error("mismatch");
    }
    const leafSpki = leaf.publicKey.export({ format: "der", type: "spki" });
    const keySpki = publicFromKey.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(leafSpki) || !Buffer.isBuffer(keySpki) || !timingSafeEqual(leafSpki, keySpki)) {
      throw new Error("mismatch");
    }
  } catch {
    throw invalid("Remote worker server certificate and private key do not match.");
  }
}

function pemFromDer(label: string, der: Buffer): Buffer {
  const encoded = der.toString("base64").replace(/.{64}/gu, "$&\n");
  const body = encoded.endsWith("\n") ? encoded : `${encoded}\n`;
  return Buffer.from(`-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`, "ascii");
}

function containsAscii(value: Buffer, needle: string): boolean {
  return value.indexOf(Buffer.from(needle, "ascii")) >= 0;
}

function isAllowedPemAscii(value: Buffer): boolean {
  return value.every((byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e));
}

function countAscii(value: Buffer, needle: string): number {
  const bytes = Buffer.from(needle, "ascii");
  let count = 0;
  let offset = 0;
  while (offset <= value.byteLength - bytes.byteLength) {
    const index = value.indexOf(bytes, offset);
    if (index < 0) break;
    count += 1;
    offset = index + bytes.byteLength;
  }
  return count;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function invalid(message: string): RemoteWorkerTrustMaterialError {
  return new RemoteWorkerTrustMaterialError(message);
}
