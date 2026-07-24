import fs from "node:fs";
import path from "node:path";
import type { RuntimeBuildIdentity } from "@goatcitadel/contracts";

const MAX_EVIDENCE_RECORDS = 256;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_EVIDENCE_AGGREGATE_BYTES = 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ReleaseEvidenceLocation {
  certificatePath: string;
  /**
   * Reserved fixed-name publisher attestation for the exact certificate bytes.
   * Presence alone is not verification; the runtime must cryptographically
   * validate the bundle before it can remove the fail-closed reason.
   */
  certificateAttestationPath: string;
  releaseAssetsRoot: string;
  proofBundleRoot: string;
  /** Server-selected anchor that every evidence path must remain beneath. */
  trustedRoot: string;
  boundaryInvalid?: boolean;
}

export type EvidenceVerification = { invalidPath: boolean; missing: boolean; mismatch: boolean };

export function resolveReleaseEvidence(
  rootDir: string,
  packagedAppDir: string | undefined,
): ReleaseEvidenceLocation | undefined {
  if (packagedAppDir) {
    // Public Windows distributions ship this directory beside the installer and
    // the installer copies it under app/. The final certificate is deliberately
    // not embedded in the installer: it is created only after the signed
    // installer hash is known, avoiding a circular build identity.
    const evidenceRoot = path.join(packagedAppDir, "release-evidence");
    const certificatePath = path.join(evidenceRoot, "release-certificate.json");
    if (isRegularFile(certificatePath)) {
      const evidence: ReleaseEvidenceLocation = {
        certificatePath,
        certificateAttestationPath: path.join(evidenceRoot, "release-certificate.sigstore.json"),
        releaseAssetsRoot: path.join(evidenceRoot, "release-assets"),
        proofBundleRoot: path.join(evidenceRoot, "proof-bundle"),
        trustedRoot: packagedAppDir,
      };
      evidence.boundaryInvalid = hasInvalidReleaseEvidenceBoundary(evidence);
      return evidence;
    }
    return undefined;
  }
  const releaseDir = path.join(rootDir, "artifacts", "release");
  const certificatePath = path.join(releaseDir, "release-certificate.json");
  if (isRegularFile(certificatePath)) {
    const evidence: ReleaseEvidenceLocation = {
      certificatePath,
      certificateAttestationPath: path.join(releaseDir, "release-certificate.sigstore.json"),
      releaseAssetsRoot: path.join(rootDir, "release-artifacts"),
      proofBundleRoot: path.join(releaseDir, "package"),
      trustedRoot: rootDir,
    };
    evidence.boundaryInvalid = hasInvalidReleaseEvidenceBoundary(evidence);
    return evidence;
  }
  return undefined;
}

export function hasInvalidReleaseEvidenceBoundary(evidence: ReleaseEvidenceLocation): boolean {
  return (
    inspectAnchoredPath(evidence.trustedRoot, evidence.certificatePath, "file") === "invalid" ||
    inspectAnchoredPath(evidence.trustedRoot, evidence.certificateAttestationPath, "file") === "invalid" ||
    inspectAnchoredPath(evidence.trustedRoot, evidence.releaseAssetsRoot, "directory") === "invalid" ||
    inspectAnchoredPath(evidence.trustedRoot, evidence.proofBundleRoot, "directory") === "invalid"
  );
}

/**
 * Legacy/source-mode inventory only. Packaged-runtime publisher attestation
 * and immutable-payload trust are owned by RuntimeReleaseTrustService; this
 * helper must never promote filesystem evidence into verified runtime truth.
 */
export function classifyReleaseCertificateAttestation(evidence: ReleaseEvidenceLocation): "missing" | "invalid" {
  return inspectAnchoredPath(evidence.trustedRoot, evidence.certificateAttestationPath, "file") === "missing"
    ? "missing"
    : "invalid";
}

export function buildReleaseIdentityCacheKey(
  identity: Omit<RuntimeBuildIdentity, "release">,
  evidence: ReleaseEvidenceLocation | undefined,
): string | undefined {
  const identityKey = [identity.kind, identity.version, identity.buildSha ?? "", identity.integrity].join(":");
  if (!evidence) {
    return `${identityKey}:certificate-absent`;
  }
  const releaseAssets = fingerprintEvidenceTree(evidence.releaseAssetsRoot);
  if (!releaseAssets.complete) return undefined;
  const proofBundle = fingerprintEvidenceTree(evidence.proofBundleRoot);
  // A bounded fingerprint must never become a trust shortcut for a file that
  // fell outside the bound. Disable caching and re-inventory certificate
  // records on every request when an evidence tree is unexpectedly large.
  if (!proofBundle.complete) return undefined;
  return [
    identityKey,
    hasInvalidReleaseEvidenceBoundary(evidence) ? "boundary-invalid" : "boundary-safe",
    fingerprintEvidencePath(evidence.certificatePath),
    fingerprintEvidencePath(evidence.certificateAttestationPath),
    releaseAssets.fingerprint,
    proofBundle.fingerprint,
  ].join("|");
}

export function verifyEvidenceRecords(
  records: unknown[],
  rootDir: string,
  trustedRoot: string = rootDir,
): EvidenceVerification {
  const result: EvidenceVerification = { invalidPath: false, missing: false, mismatch: false };
  const rootState = inspectEvidenceRoot(rootDir, trustedRoot);
  if (rootState !== "safe") {
    result[rootState === "missing" ? "missing" : "invalidPath"] = true;
    return result;
  }
  const canonicalRoot = fs.realpathSync.native(rootDir);
  const seenPaths = new Set<string>();
  let aggregateBytes = 0;
  if (records.length > MAX_EVIDENCE_RECORDS) result.invalidPath = true;
  for (const value of records.slice(0, MAX_EVIDENCE_RECORDS)) {
    const record = isRecord(value) ? value : {};
    const relativePath = readString(record.relativePath) ?? readString(record.name) ?? readString(record.fileName);
    const expectedSha = (
      readString(record.sha256) ??
      readString(record.digestSha256) ??
      readString(record.hash) ??
      ""
    ).toLowerCase();
    const expectedSize = readNumber(record.sizeBytes) ?? readNumber(record.size);
    const filePath = relativePath ? resolveSafeEvidenceFile(rootDir, canonicalRoot, relativePath) : undefined;
    if (!filePath) {
      result.invalidPath = true;
      continue;
    }
    const pathKey = normalizeEvidencePathKey(filePath);
    if (seenPaths.has(pathKey)) {
      result.invalidPath = true;
      continue;
    }
    seenPaths.add(pathKey);
    if (
      !Number.isSafeInteger(expectedSize) ||
      !expectedSize ||
      expectedSize <= 0 ||
      expectedSize > MAX_EVIDENCE_FILE_BYTES ||
      !SHA256.test(expectedSha)
    ) {
      result.mismatch = true;
      continue;
    }
    if (aggregateBytes > MAX_EVIDENCE_AGGREGATE_BYTES - expectedSize) {
      result.mismatch = true;
      break;
    }
    aggregateBytes += expectedSize;
    const verification = inspectStableEvidenceFile(filePath, canonicalRoot, expectedSize);
    if (verification === "invalid") result.invalidPath = true;
    if (verification === "missing") result.missing = true;
    if (verification === "mismatch") result.mismatch = true;
  }
  return result;
}

function fingerprintEvidenceTree(rootDir: string): { complete: boolean; fingerprint: string } {
  const entries: string[] = [];
  const queue = [rootDir];
  const maxEntries = MAX_EVIDENCE_RECORDS * 2;
  let observedEntries = 0;
  let complete = true;
  scan: while (queue.length > 0) {
    const current = queue.pop()!;
    let directory: ReturnType<typeof fs.opendirSync>;
    try {
      directory = fs.opendirSync(current);
    } catch {
      entries.push(`${path.relative(rootDir, current)}:missing`);
      continue;
    }
    try {
      while (true) {
        const child = directory.readSync();
        if (!child) break;
        observedEntries += 1;
        if (observedEntries > maxEntries) {
          complete = false;
          break scan;
        }
        const childPath = path.join(current, child.name);
        entries.push(`${path.relative(rootDir, childPath)}:${fingerprintEvidencePath(childPath)}`);
        if (child.isDirectory() && !child.isSymbolicLink()) {
          queue.push(childPath);
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  if (!complete) entries.push("too-many-entries");
  return { complete, fingerprint: entries.sort().join(";") };
}

function fingerprintEvidencePath(filePath: string): string {
  try {
    const stats = fs.lstatSync(filePath);
    return [
      stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "other",
      stats.size,
      stats.dev,
      stats.ino,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(":");
  } catch {
    return "missing";
  }
}

function inspectEvidenceRoot(rootDir: string, trustedRoot: string): "safe" | "missing" | "invalid" {
  return inspectAnchoredPath(trustedRoot, rootDir, "directory");
}

function inspectAnchoredPath(
  trustedRoot: string,
  candidate: string,
  expectedKind: "file" | "directory",
): "safe" | "missing" | "invalid" {
  const root = path.resolve(trustedRoot);
  const resolvedCandidate = path.resolve(candidate);
  if (!isWithinRoot(root, resolvedCandidate)) {
    return "invalid";
  }
  try {
    const canonicalRoot = fs.realpathSync.native(root);
    const relative = path.relative(root, resolvedCandidate);
    let cursor = root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, segment);
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink()) {
        return "invalid";
      }
      if (cursor !== resolvedCandidate && !stats.isDirectory()) {
        return "invalid";
      }
    }
    const stats = fs.lstatSync(resolvedCandidate);
    if (stats.isSymbolicLink()) return "invalid";
    if (expectedKind === "file" ? !stats.isFile() : !stats.isDirectory()) return "invalid";
    return isWithinRoot(canonicalRoot, fs.realpathSync.native(resolvedCandidate)) ? "safe" : "invalid";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "invalid";
  }
}

function resolveSafeEvidenceFile(rootDir: string, canonicalRoot: string, rawRelativePath: string): string | undefined {
  if (
    rawRelativePath.length > 240 ||
    rawRelativePath.includes("\0") ||
    path.isAbsolute(rawRelativePath) ||
    path.win32.isAbsolute(rawRelativePath)
  ) {
    return undefined;
  }
  const segments = rawRelativePath.replaceAll("\\", "/").split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  const candidate = path.resolve(rootDir, ...segments);
  if (!isWithinRoot(rootDir, candidate)) {
    return undefined;
  }
  let cursor = rootDir;
  try {
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink()) {
        return undefined;
      }
    }
    const canonicalFile = fs.realpathSync.native(candidate);
    return isWithinRoot(canonicalRoot, canonicalFile) ? candidate : undefined;
  } catch (error) {
    return isMissingFileError(error) ? candidate : undefined;
  }
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function inspectStableEvidenceFile(
  filePath: string,
  canonicalRoot: string,
  expectedSize: number,
): "present" | "invalid" | "missing" | "mismatch" {
  let beforePathStats: fs.Stats;
  try {
    beforePathStats = fs.lstatSync(filePath);
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "mismatch";
  }
  if (!beforePathStats.isFile() || beforePathStats.isSymbolicLink()) return "invalid";
  if (
    !Number.isSafeInteger(expectedSize) ||
    !expectedSize ||
    beforePathStats.size !== expectedSize ||
    beforePathStats.size <= 0 ||
    beforePathStats.size > MAX_EVIDENCE_FILE_BYTES
  ) {
    return "mismatch";
  }

  let handle: number;
  try {
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | readNoFollowFlag());
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    return isLinkOpenError(error) ? "invalid" : "mismatch";
  }
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(filePath);
    if (
      !openedStats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      !sameFileIdentity(beforePathStats, openedStats) ||
      !sameFileIdentity(openedStats, currentPathStats) ||
      !isWithinRoot(canonicalRoot, fs.realpathSync.native(filePath))
    ) {
      return "invalid";
    }
    // Legacy/source-mode evidence is inventory only and can never establish
    // publisher or installed-payload trust. Descriptor metadata checks retain
    // path/race protection without synchronously hashing attacker-sized files
    // on the runtime-identity request path.
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(filePath);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      !sameFileIdentity(openedStats, finalOpenedStats) ||
      !sameFileIdentity(finalOpenedStats, finalPathStats) ||
      !isWithinRoot(canonicalRoot, fs.realpathSync.native(filePath))
    ) {
      return "invalid";
    }
    return "present";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : isLinkOpenError(error) ? "invalid" : "mismatch";
  } finally {
    fs.closeSync(handle);
  }
}

function normalizeEvidencePathKey(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readNoFollowFlag(): number {
  return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function isLinkOpenError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
