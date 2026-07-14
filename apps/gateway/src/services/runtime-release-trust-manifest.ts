import { createHash } from "node:crypto";
import {
  MAX_RUNTIME_PAYLOAD_BYTES,
  MAX_RUNTIME_PAYLOAD_FILE_BYTES,
  MAX_RUNTIME_PAYLOAD_FILES,
  ReleaseTrustFilesystemError,
  assertSafePayloadRelativePath,
} from "./runtime-release-trust-filesystem.js";

const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const FIXED_REPOSITORY = "goatcitadel/GoatCitadel";
const FIXED_WORKFLOW_NAME = "Release Installers and Bundles";
const FIXED_WORKFLOW_FILE = ".github/workflows/release-installers.yml";
const FIXED_INSTALL_LAYOUT = "goatcitadel-bundle-v1";
const FIXED_IMMUTABLE_ROOTS = ["app", "bin"] as const;
const FIXED_METADATA_FILES = ["app/release-manifest.json"] as const;
const FIXED_METADATA_TREES = ["app/release-evidence"] as const;
const FIXED_METADATA_FILE_CASEFOLDED = FIXED_METADATA_FILES[0].toLowerCase();
const FIXED_METADATA_TREE_CASEFOLDED = FIXED_METADATA_TREES[0].toLowerCase();

export interface RuntimePayloadManifestFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface AuthenticatedRuntimePayloadManifest {
  certificate: Readonly<Record<string, unknown>>;
  tag: string;
  identity: string;
  issuer: string;
  target: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  files: RuntimePayloadManifestFile[];
}

export interface UntrustedReleaseCertificateIdentity {
  tag: string;
  version: string;
  commit: string;
}

export function readUntrustedReleaseCertificateIdentity(bytes: Buffer): UntrustedReleaseCertificateIdentity {
  const certificate = parseJsonRecord(bytes, "Release certificate");
  if (certificate.schemaVersion !== 2 || certificate.product !== "GoatCitadel") {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate schema is unsupported.");
  }
  const tag = readString(certificate.tag);
  const version = readString(certificate.version);
  const commit = readLowerHex(certificate.commit, FULL_GIT_SHA);
  const workflow = isRecord(certificate.releaseWorkflow) ? certificate.releaseWorkflow : undefined;
  if (
    !tag ||
    !SAFE_RELEASE_TAG.test(tag) ||
    tag.includes("..") ||
    !version ||
    version.length > 79 ||
    tag !== `v${version}` ||
    !commit ||
    readLowerHex(certificate.targetCommit, FULL_GIT_SHA) !== commit ||
    certificate.repository !== FIXED_REPOSITORY ||
    !workflow ||
    workflow.name !== FIXED_WORKFLOW_NAME ||
    workflow.workflowFile !== FIXED_WORKFLOW_FILE ||
    workflow.eventName !== "push" ||
    workflow.ref !== `refs/tags/${tag}` ||
    readLowerHex(workflow.sha, FULL_GIT_SHA) !== commit ||
    workflow.workflowRef !== `${FIXED_REPOSITORY}/${FIXED_WORKFLOW_FILE}@refs/tags/${tag}` ||
    workflow.trustEligible !== true
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate pre-authentication identity is invalid.");
  }
  return { tag, version, commit };
}

export function readUntrustedReleaseCertificateTag(bytes: Buffer): string {
  return readUntrustedReleaseCertificateIdentity(bytes).tag;
}

export function buildReleaseWorkflowIdentity(tag: string): string {
  if (!SAFE_RELEASE_TAG.test(tag) || tag.includes("..")) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate tag is unsafe.");
  }
  return `https://github.com/goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/${tag}`;
}

export function resolveAuthenticatedRuntimePayloadManifest(input: {
  certificateBytes: Buffer;
  manifestBytes: Buffer;
  runtimePlatform: NodeJS.Platform;
  runtimeArch: string;
}): AuthenticatedRuntimePayloadManifest {
  const certificate = parseJsonRecord(input.certificateBytes, "Release certificate");
  const manifest = parseJsonRecord(input.manifestBytes, "Release manifest");
  const tag = readUntrustedReleaseCertificateTag(input.certificateBytes);
  const issuer = "https://token.actions.githubusercontent.com";
  const identity = buildReleaseWorkflowIdentity(tag);
  const expectedPlatform = input.runtimePlatform === "win32" ? "windows" : input.runtimePlatform;
  const certificateVersion = readString(certificate.version);
  const certificateCommit = readLowerHex(certificate.commit, FULL_GIT_SHA);
  const workflow = isRecord(certificate.releaseWorkflow) ? certificate.releaseWorkflow : undefined;
  const expectedWorkflowRef = `${FIXED_REPOSITORY}/${FIXED_WORKFLOW_FILE}@refs/tags/${tag}`;
  if (
    certificate.repository !== FIXED_REPOSITORY ||
    !certificateVersion ||
    certificateVersion.length > 79 ||
    tag !== `v${certificateVersion}` ||
    !certificateCommit ||
    readLowerHex(certificate.targetCommit, FULL_GIT_SHA) !== certificateCommit ||
    !workflow ||
    workflow.name !== FIXED_WORKFLOW_NAME ||
    workflow.workflowFile !== FIXED_WORKFLOW_FILE ||
    workflow.eventName !== "push" ||
    workflow.ref !== `refs/tags/${tag}` ||
    readLowerHex(workflow.sha, FULL_GIT_SHA) !== certificateCommit ||
    workflow.workflowRef !== expectedWorkflowRef ||
    workflow.trustEligible !== true
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate identity fields are invalid.");
  }

  const payloads = Array.isArray(certificate.runtimePayloads) ? certificate.runtimePayloads : [];
  const expectedTargets = new Set(["windows-x64", "windows-arm64"]);
  const observedTargets = new Set<string>();
  if (payloads.length !== expectedTargets.size) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate runtime target inventory is invalid.");
  }
  for (const value of payloads) {
    if (!isRecord(value)) {
      throw new ReleaseTrustFilesystemError("invalid", "Release certificate runtime target is malformed.");
    }
    const candidateTarget = readString(value.target);
    const candidateManifest = isRecord(value.manifest) ? value.manifest : undefined;
    if (
      !candidateTarget ||
      !expectedTargets.has(candidateTarget) ||
      observedTargets.has(candidateTarget) ||
      value.platform !== "windows" ||
      value.arch !== candidateTarget.slice("windows-".length) ||
      value.installLayout !== FIXED_INSTALL_LAYOUT ||
      !sameLiteralArray(value.immutableRoots, FIXED_IMMUTABLE_ROOTS) ||
      !sameLiteralArray(value.detachedMetadataFiles, FIXED_METADATA_FILES) ||
      !sameLiteralArray(value.detachedMetadataTrees, FIXED_METADATA_TREES) ||
      !candidateManifest ||
      candidateManifest.installedPath !== FIXED_METADATA_FILES[0] ||
      candidateManifest.relativePath !== `${candidateTarget}-release-assets/app/release-manifest.json` ||
      !readLowerHex(candidateManifest.sha256, SHA256) ||
      readSafeInteger(candidateManifest.sizeBytes, 1) === undefined
    ) {
      throw new ReleaseTrustFilesystemError("invalid", "Release certificate runtime target mapping is invalid.");
    }
    observedTargets.add(candidateTarget);
  }
  const matchingPayloads = payloads.filter((value) => {
    if (!isRecord(value)) return false;
    return value.platform === expectedPlatform && value.arch === input.runtimeArch;
  });
  if (matchingPayloads.length !== 1) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate does not bind exactly one runtime target.");
  }
  const payloadRecord = matchingPayloads[0]!;
  const target = readString(payloadRecord.target);
  const expectedRuntimeTarget = expectedPlatform === "windows" ? `windows-${input.runtimeArch}` : undefined;
  if (
    !target ||
    target.length > 40 ||
    target !== expectedRuntimeTarget ||
    payloadRecord.installLayout !== FIXED_INSTALL_LAYOUT ||
    !sameLiteralArray(payloadRecord.immutableRoots, FIXED_IMMUTABLE_ROOTS) ||
    !sameLiteralArray(payloadRecord.detachedMetadataFiles, FIXED_METADATA_FILES) ||
    !sameLiteralArray(payloadRecord.detachedMetadataTrees, FIXED_METADATA_TREES)
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Release certificate runtime policy is invalid.");
  }
  const manifestBinding = isRecord(payloadRecord.manifest) ? payloadRecord.manifest : undefined;
  const manifestSha256 = manifestBinding ? readLowerHex(manifestBinding.sha256, SHA256) : undefined;
  const manifestSizeBytes = manifestBinding ? readSafeInteger(manifestBinding.sizeBytes, 1) : undefined;
  if (
    !manifestBinding ||
    manifestBinding.installedPath !== FIXED_METADATA_FILES[0] ||
    manifestBinding.relativePath !== `${target}-release-assets/app/release-manifest.json` ||
    !manifestSha256 ||
    manifestSizeBytes !== input.manifestBytes.byteLength ||
    createHash("sha256").update(input.manifestBytes).digest("hex") !== manifestSha256
  ) {
    throw new ReleaseTrustFilesystemError("mismatch", "Installed release manifest is not certificate-bound.");
  }

  const sourceCommit = readLowerHex(manifest.sourceCommit, FULL_GIT_SHA);
  const payload = isRecord(manifest.payload) ? manifest.payload : undefined;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.product !== "GoatCitadel" ||
    manifest.version !== certificateVersion ||
    sourceCommit !== certificateCommit ||
    manifest.sourceModified !== false ||
    manifest.target !== target ||
    manifest.platform !== expectedPlatform ||
    manifest.arch !== input.runtimeArch ||
    !payload ||
    payload.algorithm !== "sha256" ||
    !sameLiteralArray(payload.roots, FIXED_IMMUTABLE_ROOTS) ||
    !sameLiteralArray(payload.detachedMetadataFiles, FIXED_METADATA_FILES) ||
    !sameLiteralArray(payload.detachedMetadataTrees, FIXED_METADATA_TREES)
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Release manifest policy or identity is invalid.");
  }

  const files = validateManifestFiles(payload.files);
  const fileCount = readSafeInteger(payload.fileCount, 0);
  const totalBytes = readSafeInteger(payload.totalBytes, 0);
  const calculatedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (
    fileCount === undefined ||
    totalBytes === undefined ||
    fileCount !== files.length ||
    totalBytes !== calculatedBytes ||
    fileCount > MAX_RUNTIME_PAYLOAD_FILES ||
    totalBytes > MAX_RUNTIME_PAYLOAD_BYTES
  ) {
    throw new ReleaseTrustFilesystemError("invalid", "Release manifest payload summary is inconsistent.");
  }

  return {
    certificate,
    tag,
    identity,
    issuer,
    target,
    manifestSha256,
    fileCount,
    totalBytes,
    files,
  };
}

function validateManifestFiles(value: unknown): RuntimePayloadManifestFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUNTIME_PAYLOAD_FILES) {
    throw new ReleaseTrustFilesystemError("oversize", "Release manifest file inventory is invalid.");
  }
  const files: RuntimePayloadManifestFile[] = [];
  const exactPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  let previousPath: string | undefined;
  for (const item of value) {
    if (!isRecord(item)) {
      throw new ReleaseTrustFilesystemError("invalid", "Release manifest contains a non-object file record.");
    }
    const filePath = readString(item.path);
    const sha256 = readLowerHex(item.sha256, SHA256);
    const sizeBytes = readSafeInteger(item.sizeBytes, 0);
    if (!filePath || !sha256 || sizeBytes === undefined || sizeBytes > MAX_RUNTIME_PAYLOAD_FILE_BYTES) {
      throw new ReleaseTrustFilesystemError("invalid", "Release manifest file metadata is invalid.");
    }
    assertSafePayloadRelativePath(filePath);
    const folded = filePath.toLowerCase();
    if (
      folded === FIXED_METADATA_FILE_CASEFOLDED ||
      folded === FIXED_METADATA_TREE_CASEFOLDED ||
      folded.startsWith(`${FIXED_METADATA_TREE_CASEFOLDED}/`)
    ) {
      throw new ReleaseTrustFilesystemError("invalid", "Release manifest includes detached metadata as payload.");
    }
    if (exactPaths.has(filePath) || caseFoldedPaths.has(folded)) {
      throw new ReleaseTrustFilesystemError("invalid", "Release manifest contains duplicate or case-colliding paths.");
    }
    if (previousPath !== undefined && Buffer.from(previousPath).compare(Buffer.from(filePath)) >= 0) {
      throw new ReleaseTrustFilesystemError("invalid", "Release manifest paths are not byte-lexically sorted.");
    }
    exactPaths.add(filePath);
    caseFoldedPaths.add(folded);
    previousPath = filePath;
    files.push({ path: filePath, sha256, sizeBytes });
  }
  return files;
}

function parseJsonRecord(bytes: Buffer, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ReleaseTrustFilesystemError("invalid", `${label} is not valid JSON.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ReleaseTrustFilesystemError("invalid", `${label} must be a JSON object.`);
  }
  return parsed;
}

function sameLiteralArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index])
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : undefined;
}

function readLowerHex(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) && value === value.toLowerCase() ? value : undefined;
}

function readSafeInteger(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
