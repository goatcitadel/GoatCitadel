import { createHash, createPublicKey, verify } from "node:crypto";
import {
  REMOTE_WORKER_MAX_RUNTIME_MANIFEST_FILES,
  assertRemoteWorkerRuntimeManifest,
  canonicalJsonString,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";

export const REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-installed-tree-attestation.v1" as const;
export const REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION = "goatcitadel.remote-worker-installed-tree.v1" as const;
export const REMOTE_WORKER_VENDOR_TREE_SCHEMA_VERSION = "goatcitadel.remote-worker-vendor-tree.v1" as const;
export const REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const REMOTE_WORKER_ATTESTATION_MAX_AGE_MS = 5 * 60_000;
export const REMOTE_WORKER_ATTESTATION_MAX_FUTURE_MS = 60_000;

export const REMOTE_WORKER_INSTALLED_TREE_ROLES = [
  "bundle",
  "dependency_lock",
  "vendor",
  "launcher",
  "runtime",
] as const;

export type RemoteWorkerInstalledTreeRole = (typeof REMOTE_WORKER_INSTALLED_TREE_ROLES)[number];

export interface RemoteWorkerInstalledTreeFile {
  readonly path: string;
  readonly role: RemoteWorkerInstalledTreeRole;
  readonly kind: "regular_file";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly identity: string;
  readonly beforeStatSha256: string;
  readonly afterStatSha256: string;
  readonly immutable: true;
}

export interface RemoteWorkerInstalledTreeAttestation {
  readonly schemaVersion: typeof REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION;
  readonly runtimeManifestPayloadSha256: string;
  readonly scannedAt: string;
  readonly rootIdentity: string;
  readonly files: readonly RemoteWorkerInstalledTreeFile[];
  readonly totalBytes: number;
  readonly treeSha256: string;
  readonly attestationSha256: string;
}

export interface RemoteWorkerInstalledTreeScannerPort {
  /**
   * This trusted port must eventually be backed by no-follow POSIX/Windows scanning.
   * Caller-supplied role, identity, or immutable claims are not hostile-worker proof.
   */
  scan(input: {
    readonly root: string;
    readonly maxFileCount: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  }): unknown | Promise<unknown>;
}

export interface RemoteWorkerManifestVerificationReceipt {
  readonly signerKeyId: string;
  readonly signerSpkiSha256: string;
  readonly payloadSha256: string;
  readonly manifestVerificationReceiptSha256: string;
}

export interface RemoteWorkerInstalledTreeVerificationReceipt {
  readonly manifest: RemoteWorkerManifestVerificationReceipt;
  readonly rootIdentitySha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly scannedAt: string;
}

export class RemoteWorkerAttestationError extends Error {
  readonly code = "REMOTE_WORKER_ATTESTATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAttestationError";
  }
}

export function verifyRemoteWorkerRuntimeManifestSignature(input: {
  readonly manifest: RemoteWorkerRuntimeManifest;
  readonly expectedSignerKeyId: string;
  readonly expectedSignerSpkiSha256: string;
  readonly signerPublicKeySpkiDer: Buffer;
}): RemoteWorkerManifestVerificationReceipt {
  const manifest = snapshotRemoteWorkerRuntimeManifest(input.manifest);
  const expectedSignerKeyId = canonicalIdentity(input.expectedSignerKeyId, "manifest signer key ID", 128);
  if (manifest.signerKeyId !== expectedSignerKeyId) {
    throw invalid("Remote worker runtime manifest signer is not authorized.");
  }
  const expectedSignerSpkiSha256 = sha256Value(input.expectedSignerSpkiSha256, "manifest signer pin");
  if (!Buffer.isBuffer(input.signerPublicKeySpkiDer) || input.signerPublicKeySpkiDer.byteLength > 4_096) {
    throw invalid("Remote worker manifest signer public key is invalid.");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: input.signerPublicKeySpkiDer, format: "der", type: "spki" });
  } catch {
    throw invalid("Remote worker manifest signer public key is invalid.");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw invalid("Remote worker manifest signer key algorithm is invalid.");
  }
  const canonicalSpki = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalSpki) || sha256(canonicalSpki) !== expectedSignerSpkiSha256) {
    throw invalid("Remote worker manifest signer key pin did not match.");
  }
  const signature = decodeSignature(manifest.signatureBase64Url);
  const payloadBytes = Buffer.from(canonicalJsonString(manifest.payload), "utf8");
  if (!verify(null, payloadBytes, publicKey, signature)) {
    throw invalid("Remote worker runtime manifest signature is invalid.");
  }
  const receiptMaterial = canonicalJsonString({
    schemaVersion: "goatcitadel.remote-worker-manifest-verification.v1",
    signerKeyId: expectedSignerKeyId,
    signerSpkiSha256: expectedSignerSpkiSha256,
    payloadSha256: manifest.payloadSha256,
  });
  return Object.freeze({
    signerKeyId: expectedSignerKeyId,
    signerSpkiSha256: expectedSignerSpkiSha256,
    payloadSha256: manifest.payloadSha256,
    manifestVerificationReceiptSha256: sha256Utf8(receiptMaterial),
  });
}

export async function verifyRemoteWorkerInstalledTreeAttestation(input: {
  readonly manifest: RemoteWorkerRuntimeManifest;
  readonly expectedSignerKeyId: string;
  readonly expectedSignerSpkiSha256: string;
  readonly signerPublicKeySpkiDer: Buffer;
  readonly root: string;
  readonly scanner: RemoteWorkerInstalledTreeScannerPort;
  readonly now?: Date;
}): Promise<RemoteWorkerInstalledTreeVerificationReceipt> {
  const manifest = snapshotRemoteWorkerRuntimeManifest(input.manifest);
  const manifestReceipt = verifyRemoteWorkerRuntimeManifestSignature({ ...input, manifest });
  const root = boundedOpaqueRoot(input.root);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw invalid("Remote worker attestation clock is invalid.");
  let rawScan: unknown;
  try {
    rawScan = await input.scanner.scan({
      root,
      maxFileCount: REMOTE_WORKER_MAX_RUNTIME_MANIFEST_FILES,
      maxFileBytes: REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES,
      maxTotalBytes: REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES,
    });
  } catch {
    throw invalid("Remote worker installed-tree scanner failed.");
  }
  const attestation = normalizeInstalledTreeAttestation(rawScan, new Date(nowMs));
  if (attestation.runtimeManifestPayloadSha256 !== manifest.payloadSha256) {
    throw invalid("Remote worker installed-tree attestation is bound to a different manifest.");
  }
  if (attestation.files.length !== manifest.payload.installedTreeFileCount) {
    throw invalid("Remote worker installed-tree file count does not match the signed manifest.");
  }
  const byRole = groupFilesByRole(attestation.files);
  assertExactSingletonDigest(byRole.bundle, manifest.payload.bundleSha256, "bundle");
  assertExactSingletonDigest(byRole.dependency_lock, manifest.payload.dependencyLockSha256, "dependency lock");
  assertExactSingletonDigest(byRole.launcher, manifest.payload.launcherSha256, "launcher");
  if (byRole.vendor.length < 1) throw invalid("Remote worker installed tree has no vendor files.");
  const vendorTreeSha256 = sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_VENDOR_TREE_SCHEMA_VERSION,
      files: byRole.vendor,
    }),
  );
  if (vendorTreeSha256 !== manifest.payload.vendorTreeSha256) {
    throw invalid("Remote worker vendor tree digest does not match the signed manifest.");
  }
  if (attestation.treeSha256 !== manifest.payload.installedTreeManifestSha256) {
    throw invalid("Remote worker installed-tree digest does not match the signed manifest.");
  }

  return Object.freeze({
    manifest: manifestReceipt,
    rootIdentitySha256: sha256Utf8(attestation.rootIdentity),
    installedTreeAttestationSha256: attestation.attestationSha256,
    treeSha256: attestation.treeSha256,
    fileCount: attestation.files.length,
    totalBytes: attestation.totalBytes,
    scannedAt: attestation.scannedAt,
  });
}

export function normalizeInstalledTreeAttestation(value: unknown, now: Date): RemoteWorkerInstalledTreeAttestation {
  assertPlainRecord(value, "installed-tree attestation");
  assertExactKeys(value, [
    "schemaVersion",
    "runtimeManifestPayloadSha256",
    "scannedAt",
    "rootIdentity",
    "files",
    "totalBytes",
    "treeSha256",
    "attestationSha256",
  ]);
  if (value.schemaVersion !== REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION) {
    throw invalid("Remote worker installed-tree attestation schema is invalid.");
  }
  const runtimeManifestPayloadSha256 = sha256Value(value.runtimeManifestPayloadSha256, "manifest payload digest");
  const scannedAt = canonicalTimestamp(value.scannedAt);
  const scannedAtMs = Date.parse(scannedAt);
  if (
    scannedAtMs < now.getTime() - REMOTE_WORKER_ATTESTATION_MAX_AGE_MS ||
    scannedAtMs > now.getTime() + REMOTE_WORKER_ATTESTATION_MAX_FUTURE_MS
  ) {
    throw invalid("Remote worker installed-tree attestation is stale or future-dated.");
  }
  const rootIdentity = canonicalIdentity(value.rootIdentity, "root identity", 256);
  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > REMOTE_WORKER_MAX_RUNTIME_MANIFEST_FILES
  ) {
    throw invalid("Remote worker installed-tree file list is invalid.");
  }
  const files = value.files.map((file) => normalizeInstalledTreeFile(file));
  assertSortedUniquePaths(files);
  const totalBytes = boundedInteger(value.totalBytes, "total bytes", REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES);
  const summedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(summedBytes) || summedBytes !== totalBytes) {
    throw invalid("Remote worker installed-tree total byte count is invalid.");
  }
  const treeSha256 = sha256Value(value.treeSha256, "tree digest");
  const attestationSha256 = sha256Value(value.attestationSha256, "attestation digest");
  const normalized = Object.freeze({
    schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
    runtimeManifestPayloadSha256,
    scannedAt,
    rootIdentity,
    files: Object.freeze(files),
    totalBytes,
    treeSha256,
    attestationSha256,
  });
  const expectedTreeSha256 = sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION,
      rootIdentity,
      files: normalized.files,
      totalBytes,
    }),
  );
  if (treeSha256 !== expectedTreeSha256) {
    throw invalid("Remote worker installed-tree attestation digest is invalid.");
  }
  const expectedAttestationSha256 = sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
      runtimeManifestPayloadSha256,
      scannedAt,
      rootIdentity,
      totalBytes,
      treeSha256,
    }),
  );
  if (attestationSha256 !== expectedAttestationSha256) {
    throw invalid("Remote worker installed-tree evidence binding is invalid.");
  }
  return normalized;
}

function normalizeInstalledTreeFile(value: unknown): RemoteWorkerInstalledTreeFile {
  assertPlainRecord(value, "installed-tree file");
  assertExactKeys(value, [
    "path",
    "role",
    "kind",
    "sizeBytes",
    "sha256",
    "identity",
    "beforeStatSha256",
    "afterStatSha256",
    "immutable",
  ]);
  const path = normalizedRelativePath(value.path);
  if (
    typeof value.role !== "string" ||
    !REMOTE_WORKER_INSTALLED_TREE_ROLES.includes(value.role as RemoteWorkerInstalledTreeRole)
  ) {
    throw invalid("Remote worker installed-tree file role is invalid.");
  }
  if (value.kind !== "regular_file") {
    throw invalid("Remote worker installed tree contains a symlink, reparse point, or non-regular file.");
  }
  const sizeBytes = boundedInteger(value.sizeBytes, "file size", REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES);
  const fileSha256 = sha256Value(value.sha256, "file digest");
  const identity = canonicalIdentity(value.identity, "file identity", 256);
  const beforeStatSha256 = sha256Value(value.beforeStatSha256, "before-stat digest");
  const afterStatSha256 = sha256Value(value.afterStatSha256, "after-stat digest");
  if (beforeStatSha256 !== afterStatSha256) {
    throw invalid("Remote worker installed-tree file changed during scanning.");
  }
  if (value.immutable !== true) {
    throw invalid("Remote worker installed tree contains mutable files.");
  }
  return Object.freeze({
    path,
    role: value.role as RemoteWorkerInstalledTreeRole,
    kind: "regular_file",
    sizeBytes,
    sha256: fileSha256,
    identity,
    beforeStatSha256,
    afterStatSha256,
    immutable: true,
  });
}

function assertSortedUniquePaths(files: readonly RemoteWorkerInstalledTreeFile[]): void {
  const casefolded = new Set<string>();
  const identities = new Set<string>();
  let previous: Buffer | undefined;
  for (const file of files) {
    const encoded = Buffer.from(file.path, "utf8");
    if (previous !== undefined && Buffer.compare(previous, encoded) >= 0) {
      throw invalid("Remote worker installed-tree paths are not in canonical byte order.");
    }
    previous = encoded;
    const folded = casefoldPath(file.path);
    if (casefolded.has(folded)) {
      throw invalid("Remote worker installed-tree paths contain a case-fold collision.");
    }
    casefolded.add(folded);
    if (identities.has(file.identity)) {
      throw invalid("Remote worker installed-tree files contain an identity alias.");
    }
    identities.add(file.identity);
  }
}

function groupFilesByRole(
  files: readonly RemoteWorkerInstalledTreeFile[],
): Record<RemoteWorkerInstalledTreeRole, RemoteWorkerInstalledTreeFile[]> {
  const groups: Record<RemoteWorkerInstalledTreeRole, RemoteWorkerInstalledTreeFile[]> = {
    bundle: [],
    dependency_lock: [],
    vendor: [],
    launcher: [],
    runtime: [],
  };
  for (const file of files) groups[file.role].push(file);
  return groups;
}

function assertExactSingletonDigest(
  files: readonly RemoteWorkerInstalledTreeFile[],
  expectedSha256: string,
  label: string,
): void {
  if (files.length !== 1 || files[0]?.sha256 !== expectedSha256) {
    throw invalid(`Remote worker ${label} digest does not match the signed manifest.`);
  }
}

function normalizedRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:/u.test(value) ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid("Remote worker installed-tree file path is invalid.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/u.test(segment) ||
        /[ .]$/u.test(segment) ||
        isWindowsReservedPathSegment(segment),
    )
  ) {
    throw invalid("Remote worker installed-tree file path is invalid.");
  }
  return value;
}

function isWindowsReservedPathSegment(value: string): boolean {
  const baseName = value.split(".", 1)[0]?.normalize("NFKC").toLocaleUpperCase("en-US");
  return baseName !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(baseName);
}

function boundedOpaqueRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid("Remote worker installed-tree root is invalid.");
  }
  return value;
}

function canonicalIdentity(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.normalize("NFKC") !== value ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid("Remote worker installed-tree timestamp is invalid.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalid("Remote worker installed-tree timestamp is invalid.");
  }
  return value;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw invalid(`Remote worker installed-tree ${label} is invalid.`);
  }
  return value as number;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid("Remote worker manifest signature encoding is invalid.");
  const signature = Buffer.from(value, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
    throw invalid("Remote worker manifest signature encoding is invalid.");
  }
  return signature;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`Remote worker ${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`Remote worker ${label} must be a plain record.`);
  }
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw invalid(`Remote worker ${label} must contain only plain data fields.`);
  }
}

function casefoldPath(value: string): string {
  return value.normalize("NFKC").toLocaleUpperCase("en-US").toLocaleLowerCase("en-US").normalize("NFC");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid("Remote worker installed-tree evidence has missing or unknown fields.");
  }
}

function snapshotRemoteWorkerRuntimeManifest(value: unknown): RemoteWorkerRuntimeManifest {
  try {
    assertPlainRecord(value, "runtime manifest");
    assertExactKeys(value, ["payload", "payloadSha256", "signatureAlgorithm", "signerKeyId", "signatureBase64Url"]);
    const payload = value.payload;
    assertPlainRecord(payload, "runtime manifest payload");
    assertExactKeys(payload, [
      "schemaVersion",
      "protocolVersion",
      "bundleSha256",
      "dependencyLockSha256",
      "vendorTreeSha256",
      "launcherSha256",
      "installedTreeManifestSha256",
      "installedTreeFileCount",
      "platform",
      "architecture",
    ]);
    const snapshot = Object.freeze({
      payload: Object.freeze({
        schemaVersion: payload.schemaVersion,
        protocolVersion: payload.protocolVersion,
        bundleSha256: payload.bundleSha256,
        dependencyLockSha256: payload.dependencyLockSha256,
        vendorTreeSha256: payload.vendorTreeSha256,
        launcherSha256: payload.launcherSha256,
        installedTreeManifestSha256: payload.installedTreeManifestSha256,
        installedTreeFileCount: payload.installedTreeFileCount,
        platform: payload.platform,
        architecture: payload.architecture,
      }),
      payloadSha256: value.payloadSha256,
      signatureAlgorithm: value.signatureAlgorithm,
      signerKeyId: value.signerKeyId,
      signatureBase64Url: value.signatureBase64Url,
    });
    assertRemoteWorkerRuntimeManifest(snapshot);
    return snapshot;
  } catch {
    throw invalid("Remote worker runtime manifest contract is invalid.");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): RemoteWorkerAttestationError {
  return new RemoteWorkerAttestationError(message);
}
