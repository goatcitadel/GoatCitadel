#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PACKAGING_TARGETS } from "../packaging/lib/packaging-targets.mjs";
import {
  RELEASE_DETACHED_METADATA_FILES,
  RELEASE_DETACHED_METADATA_TREES,
  RELEASE_MANIFEST_PRODUCT,
  RELEASE_PAYLOAD_LIMITS,
  RELEASE_PAYLOAD_ROOTS,
  validateReleaseManifest,
} from "../packaging/lib/package-renderers.mjs";

const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_CERTIFICATE_SCHEMA_VERSION = 2;
const MAX_CERTIFICATE_BYTES = 2 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;
const REQUIRED_RUNTIME_PAYLOAD_TARGETS = Object.freeze(["windows-x64", "windows-arm64"]);
const RUNTIME_INSTALL_LAYOUT = "goatcitadel-bundle-v1";
const INSTALLED_MANIFEST_PATH = "app/release-manifest.json";
const EXPECTED_REPOSITORY = "goatcitadel/GoatCitadel";
const EXPECTED_WORKFLOW_NAME = "Release Installers and Bundles";
const EXPECTED_WORKFLOW_FILE = ".github/workflows/release-installers.yml";
const MAX_EVIDENCE_PATH_BYTES = 240;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export async function assembleRuntimeReleaseEvidence({
  certificatePath,
  attestationPath,
  artifactsDir,
  proofZipPath,
  outputDir,
  archiveDir = outputDir,
  installers = [],
  createArchives = true,
}) {
  const { certificate, raw: rawCertificate } = readCertificate(certificatePath);
  const rawAttestation = readAttestation(attestationPath);
  const releaseAssets = certificate.releaseAssets;
  const proofBundle = certificate.proofBundle;
  if (!Array.isArray(releaseAssets) || releaseAssets.length === 0 || releaseAssets.length > 256) {
    throw new Error("Release certificate must contain 1-256 releaseAssets records.");
  }
  if (!isRecord(proofBundle)) {
    throw new Error("Release certificate is missing proofBundle metadata.");
  }
  const runtimePayloadsByTarget = await validateRuntimePayloadBindings({
    certificate,
    artifactsDir,
  });

  const evidenceDir = path.resolve(outputDir, "release-evidence");
  assertChildPath(path.resolve(outputDir), evidenceDir);
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(evidenceDir, "release-assets"), { recursive: true });
  fs.mkdirSync(path.join(evidenceDir, "proof-bundle"), { recursive: true });

  const verifiedAssetPaths = new Set();
  const verifiedAssetRelativePaths = new Set();
  for (const record of releaseAssets) {
    if (!isRecord(record)) {
      throw new Error("Release certificate contains a non-object release asset record.");
    }
    const relativePath = readEvidenceRelativePath(record);
    const pathIdentity = relativePath.toLowerCase();
    if (verifiedAssetRelativePaths.has(pathIdentity)) {
      throw new Error(`Release certificate contains a duplicate release asset path: ${relativePath}`);
    }
    verifiedAssetRelativePaths.add(pathIdentity);
    const sourcePath = resolveSafeRegularFile(artifactsDir, relativePath);
    await verifyRecord(sourcePath, record, `release asset ${relativePath}`, artifactsDir);
    verifiedAssetPaths.add(path.resolve(sourcePath));
    const copiedPath = copyEvidenceFile(sourcePath, path.join(evidenceDir, "release-assets"), relativePath);
    await verifyRecord(
      copiedPath,
      record,
      `copied release asset ${relativePath}`,
      path.join(evidenceDir, "release-assets"),
    );
  }

  const proofRelativePath = readEvidenceRelativePath(proofBundle);
  const resolvedProofZip = path.resolve(proofZipPath);
  if (!isRegularFileWithoutLinks(resolvedProofZip)) {
    throw new Error(`Proof bundle is not a regular non-symlink file: ${resolvedProofZip}`);
  }
  await verifyRecord(
    resolvedProofZip,
    proofBundle,
    `proof bundle ${proofRelativePath}`,
    path.dirname(resolvedProofZip),
  );
  const copiedProofPath = copyEvidenceFile(resolvedProofZip, path.join(evidenceDir, "proof-bundle"), proofRelativePath);
  await verifyRecord(
    copiedProofPath,
    proofBundle,
    `copied proof bundle ${proofRelativePath}`,
    path.join(evidenceDir, "proof-bundle"),
  );
  fs.writeFileSync(path.join(evidenceDir, "release-certificate.json"), rawCertificate, { flag: "wx" });
  fs.writeFileSync(path.join(evidenceDir, "release-certificate.sigstore.json"), rawAttestation, { flag: "wx" });

  const tag = sanitizeTag(certificate.tag ?? certificate.version);
  const outputs = { evidenceDir, evidenceArchive: null, verifiedDistributions: [] };
  if (!createArchives) {
    return outputs;
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  const evidenceArchive = path.resolve(archiveDir, `GoatCitadel-${tag}-release-evidence.zip`);
  runZip(outputDir, evidenceArchive, "release-evidence");
  outputs.evidenceArchive = evidenceArchive;

  const verifiedInstallerTargets = new Set();
  for (const installer of installers) {
    const target = sanitizeTarget(installer.target);
    if (verifiedInstallerTargets.has(target)) {
      throw new Error(`Verified distribution target is duplicated: ${target}`);
    }
    verifiedInstallerTargets.add(target);
    const runtimePayload = runtimePayloadsByTarget.get(target);
    if (!runtimePayload) {
      throw new Error(`Verified distribution target is not bound by runtimePayloads: ${target}`);
    }
    const installerPath = path.resolve(installer.path);
    if (!isRegularFileWithoutLinks(installerPath)) {
      throw new Error(`Verified distribution installer is not a regular non-symlink file: ${installerPath}`);
    }
    if (!verifiedAssetPaths.has(installerPath)) {
      throw new Error(`Verified distribution installer is not bound by releaseAssets: ${installerPath}`);
    }
    const installerRecord = releaseAssets.find((record) => {
      if (!isRecord(record)) return false;
      try {
        return path.resolve(resolveSafeRegularFile(artifactsDir, readEvidenceRelativePath(record))) === installerPath;
      } catch {
        return false;
      }
    });
    if (!installerRecord) {
      throw new Error(`Verified distribution installer metadata is unavailable: ${installerPath}`);
    }
    const installerRelativePath = readEvidenceRelativePath(installerRecord);
    const manifestSuffix = `/${INSTALLED_MANIFEST_PATH}`;
    const manifestRelativePath = runtimePayload.manifest.relativePath;
    if (!manifestRelativePath.endsWith(manifestSuffix)) {
      throw new Error(`Runtime payload manifest path cannot bind a verified distribution: ${target}`);
    }
    const targetAssetRoot = manifestRelativePath.slice(0, -manifestSuffix.length);
    const expectedInstallerPath = `${targetAssetRoot}/GoatCitadel-Setup-${target}.exe`;
    if (installerRelativePath !== expectedInstallerPath) {
      throw new Error(`Verified distribution installer does not match runtime payload ${target}.`);
    }
    await verifyRecord(installerPath, installerRecord, `verified distribution installer ${target}`, artifactsDir);
    const stagingDir = path.resolve(outputDir, `.verified-${target}`);
    assertChildPath(path.resolve(outputDir), stagingDir);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagedInstallerPath = path.join(stagingDir, path.basename(installerPath));
    fs.copyFileSync(installerPath, stagedInstallerPath);
    await verifyRecord(
      stagedInstallerPath,
      installerRecord,
      `staged verified distribution installer ${target}`,
      stagingDir,
    );
    writeInstalledReleaseEvidenceSidecar({
      destinationDir: path.join(stagingDir, "release-evidence"),
      rawCertificate,
      rawAttestation,
    });
    const archivePath = path.resolve(archiveDir, `GoatCitadel-${tag}-${target}-verified.zip`);
    runZip(stagingDir, archivePath, ".");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    outputs.verifiedDistributions.push({ target, archivePath });
  }
  return outputs;
}

function parseArgs(argv) {
  const parsed = { installers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--installer") {
      if (!value || !value.includes("=")) throw new Error("--installer requires <target>=<path>.");
      const separator = value.indexOf("=");
      parsed.installers.push({ target: value.slice(0, separator), path: value.slice(separator + 1) });
      index += 1;
      continue;
    }
    const key = {
      "--certificate": "certificatePath",
      "--attestation": "attestationPath",
      "--artifacts-dir": "artifactsDir",
      "--proof-zip": "proofZipPath",
      "--output-dir": "outputDir",
      "--archive-dir": "archiveDir",
    }[arg];
    if (!key || !value) throw new Error(`Unknown or incomplete argument: ${arg}`);
    parsed[key] = value;
    index += 1;
  }
  for (const key of ["certificatePath", "attestationPath", "artifactsDir", "proofZipPath", "outputDir"]) {
    if (!parsed[key]) throw new Error(`Missing required argument for ${key}.`);
    parsed[key] = path.resolve(parsed[key]);
  }
  parsed.archiveDir = path.resolve(parsed.archiveDir ?? parsed.outputDir);
  return parsed;
}

function readCertificate(filePath) {
  const raw = readBoundedRegularFile(filePath, {
    label: "Release certificate",
    maxBytes: MAX_CERTIFICATE_BYTES,
  });
  let certificate;
  try {
    certificate = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("Release certificate is not valid JSON.", { cause: error });
  }
  if (
    !isRecord(certificate) ||
    certificate.schemaVersion !== RELEASE_CERTIFICATE_SCHEMA_VERSION ||
    certificate.product !== RELEASE_MANIFEST_PRODUCT
  ) {
    throw new Error("Release certificate does not match the supported GoatCitadel schema.");
  }
  if (
    typeof certificate.version !== "string" ||
    !/^[0-9][0-9a-z.+-]{0,79}$/iu.test(certificate.version) ||
    certificate.version.includes("..")
  ) {
    throw new Error("Release certificate version is invalid.");
  }
  if (certificate.tag !== `v${certificate.version}`) {
    throw new Error("Release certificate tag must exactly match its version.");
  }
  if (typeof certificate.commit !== "string" || !FULL_GIT_SHA.test(certificate.commit)) {
    throw new Error("Release certificate commit must be a lowercase full Git SHA.");
  }
  if (certificate.targetCommit !== undefined && certificate.targetCommit !== certificate.commit) {
    throw new Error("Release certificate targetCommit must match commit.");
  }
  if (certificate.repository !== EXPECTED_REPOSITORY) {
    throw new Error(`Release certificate repository must be ${EXPECTED_REPOSITORY}.`);
  }
  validateReleaseWorkflowIdentity(certificate);
  return { certificate, raw };
}

function validateReleaseWorkflowIdentity(certificate) {
  const workflow = certificate.releaseWorkflow;
  const expectedRef = `refs/tags/${certificate.tag}`;
  const expectedWorkflowRef = `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_FILE}@${expectedRef}`;
  if (
    !isRecord(workflow) ||
    workflow.name !== EXPECTED_WORKFLOW_NAME ||
    workflow.workflowFile !== EXPECTED_WORKFLOW_FILE ||
    workflow.eventName !== "push" ||
    workflow.ref !== expectedRef ||
    workflow.sha !== certificate.commit ||
    workflow.workflowRef !== expectedWorkflowRef ||
    workflow.trustEligible !== true
  ) {
    throw new Error("Release certificate releaseWorkflow identity is invalid.");
  }
}

async function validateRuntimePayloadBindings({ certificate, artifactsDir }) {
  const runtimePayloads = certificate.runtimePayloads;
  if (!Array.isArray(runtimePayloads) || runtimePayloads.length !== REQUIRED_RUNTIME_PAYLOAD_TARGETS.length) {
    throw new Error(
      `Release certificate must contain exactly ${REQUIRED_RUNTIME_PAYLOAD_TARGETS.length} runtimePayloads records.`,
    );
  }
  const releaseAssets = certificate.releaseAssets;
  const byTarget = new Map();
  const manifestPaths = new Set();
  for (const runtimePayload of runtimePayloads) {
    if (!isRecord(runtimePayload)) {
      throw new Error("Release certificate contains a non-object runtime payload record.");
    }
    const targetInfo = PACKAGING_TARGETS[runtimePayload.target];
    if (!targetInfo || !REQUIRED_RUNTIME_PAYLOAD_TARGETS.includes(runtimePayload.target)) {
      throw new Error(
        `Release certificate contains an unsupported runtime payload target: ${String(runtimePayload.target)}`,
      );
    }
    if (byTarget.has(runtimePayload.target)) {
      throw new Error(`Release certificate contains a duplicate runtime payload target: ${runtimePayload.target}`);
    }
    if (runtimePayload.platform !== targetInfo.platform || runtimePayload.arch !== targetInfo.arch) {
      throw new Error(`Release certificate runtime payload platform/arch does not match ${runtimePayload.target}.`);
    }
    if (runtimePayload.installLayout !== RUNTIME_INSTALL_LAYOUT) {
      throw new Error(`Release certificate runtime payload install layout does not match ${runtimePayload.target}.`);
    }
    requireExactStringArray(runtimePayload.immutableRoots, RELEASE_PAYLOAD_ROOTS, "immutable roots");
    requireExactStringArray(
      runtimePayload.detachedMetadataFiles,
      RELEASE_DETACHED_METADATA_FILES,
      "detached metadata files",
    );
    requireExactStringArray(
      runtimePayload.detachedMetadataTrees,
      RELEASE_DETACHED_METADATA_TREES,
      "detached metadata trees",
    );

    const manifestRecord = runtimePayload.manifest;
    if (!isRecord(manifestRecord)) {
      throw new Error(`Release certificate runtime payload ${runtimePayload.target} is missing manifest metadata.`);
    }
    const manifestRelativePath = readEvidenceRelativePath(manifestRecord);
    if (manifestPaths.has(manifestRelativePath)) {
      throw new Error(
        `Release certificate runtime manifest path is assigned to multiple targets: ${manifestRelativePath}`,
      );
    }
    manifestPaths.add(manifestRelativePath);
    if (manifestRecord.installedPath !== INSTALLED_MANIFEST_PATH) {
      throw new Error(
        `Release certificate runtime payload ${runtimePayload.target} has an invalid installed manifest path.`,
      );
    }
    if (
      typeof manifestRecord.sha256 !== "string" ||
      !SHA256.test(manifestRecord.sha256) ||
      !Number.isSafeInteger(manifestRecord.sizeBytes) ||
      manifestRecord.sizeBytes <= 0 ||
      manifestRecord.sizeBytes > RELEASE_PAYLOAD_LIMITS.maxManifestBytes
    ) {
      throw new Error(`Release certificate runtime payload ${runtimePayload.target} has invalid manifest metadata.`);
    }
    const matchingAssetRecords = releaseAssets.filter((record) => {
      if (!isRecord(record)) return false;
      try {
        return readEvidenceRelativePath(record) === manifestRelativePath;
      } catch {
        return false;
      }
    });
    if (matchingAssetRecords.length !== 1) {
      throw new Error(
        `Release certificate runtime manifest must be bound by exactly one releaseAssets record: ${manifestRelativePath}`,
      );
    }
    const assetRecord = matchingAssetRecords[0];
    if (assetRecord.sha256 !== manifestRecord.sha256 || assetRecord.sizeBytes !== manifestRecord.sizeBytes) {
      throw new Error(
        `Release certificate runtime manifest metadata does not match releaseAssets: ${manifestRelativePath}`,
      );
    }

    const manifestPath = resolveSafeRegularFile(artifactsDir, manifestRelativePath);
    await verifyRecord(manifestPath, manifestRecord, `runtime manifest ${manifestRelativePath}`, artifactsDir);
    const rawManifest = readBoundedRegularFile(manifestPath, {
      label: `Runtime manifest ${runtimePayload.target}`,
      maxBytes: RELEASE_PAYLOAD_LIMITS.maxManifestBytes,
    });
    if (
      rawManifest.length !== manifestRecord.sizeBytes ||
      createHash("sha256").update(rawManifest).digest("hex") !== manifestRecord.sha256
    ) {
      throw new Error(
        `Release certificate runtime manifest changed while it was being validated: ${manifestRelativePath}`,
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(rawManifest.toString("utf8"));
    } catch (error) {
      throw new Error(`Runtime manifest ${runtimePayload.target} is not valid JSON.`, { cause: error });
    }
    validateReleaseManifest(manifest, {
      targetInfo,
      expectedVersion: certificate.version,
      expectedCommit: certificate.commit,
      requireCleanSource: true,
    });
    byTarget.set(runtimePayload.target, runtimePayload);
  }
  const missingTargets = REQUIRED_RUNTIME_PAYLOAD_TARGETS.filter((target) => !byTarget.has(target));
  if (missingTargets.length > 0) {
    throw new Error(`Release certificate is missing required runtime payload target(s): ${missingTargets.join(", ")}.`);
  }
  return byTarget;
}

function readAttestation(filePath) {
  const raw = readBoundedRegularFile(filePath, {
    label: "Release certificate attestation",
    maxBytes: MAX_ATTESTATION_BYTES,
  });
  try {
    if (!isRecord(JSON.parse(raw.toString("utf8")))) {
      throw new Error("Sigstore bundle must be a JSON object.");
    }
  } catch (error) {
    throw new Error("Release certificate attestation is not a valid Sigstore JSON bundle.", { cause: error });
  }
  return raw;
}

function readBoundedRegularFile(filePath, { label, maxBytes }) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(`${label} path is required.`);
  }
  const resolved = path.resolve(filePath);
  let beforePathStats;
  try {
    assertNoLinkedPathComponents(resolved, label);
    beforePathStats = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`${label} must be an available bounded regular non-link file.`, { cause: error });
  }
  if (
    !beforePathStats.isFile() ||
    beforePathStats.isSymbolicLink() ||
    beforePathStats.nlink !== 1 ||
    beforePathStats.size <= 0 ||
    beforePathStats.size > maxBytes
  ) {
    throw new Error(`${label} must be a bounded regular non-link file.`);
  }
  let handle;
  try {
    handle = fs.openSync(resolved, fs.constants.O_RDONLY | readNoFollowFlag());
  } catch (error) {
    throw new Error(`${label} changed while it was being opened.`, { cause: error });
  }
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(resolved);
    assertNoLinkedPathComponents(resolved, label);
    if (
      !openedStats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      !sameFileIdentity(beforePathStats, openedStats) ||
      !sameFileIdentity(openedStats, currentPathStats)
    ) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    const raw = fs.readFileSync(handle);
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(resolved);
    assertNoLinkedPathComponents(resolved, label);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      !sameFileIdentity(openedStats, finalOpenedStats) ||
      !sameFileIdentity(finalOpenedStats, finalPathStats)
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return raw;
  } finally {
    fs.closeSync(handle);
  }
}

function assertNoLinkedPathComponents(filePath, label) {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path traverses a symlink or junction.`);
    }
    if (cursor !== resolved && !stats.isDirectory()) {
      throw new Error(`${label} path traverses a non-directory component.`);
    }
  }
}

function readEvidenceRelativePath(record) {
  const raw = record.relativePath ?? record.name ?? record.fileName;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_PATH_BYTES ||
    raw.includes("\0")
  ) {
    throw new Error("Release evidence record has an invalid relative path.");
  }
  const normalized = raw.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    path.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_BASENAME.test(segment),
    )
  ) {
    throw new Error(`Unsafe release evidence path: ${raw}`);
  }
  return segments.join("/");
}

function resolveSafeRegularFile(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release evidence root must be a regular non-symlink directory: ${root}`);
  }
  const segments = relativePath.split("/");
  const candidate = path.resolve(root, ...segments);
  assertChildPath(root, candidate);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) throw new Error(`Release evidence cannot traverse a symlink: ${relativePath}`);
  }
  if (!isRegularFileWithoutLinks(candidate)) throw new Error(`Release evidence file is unavailable: ${relativePath}`);
  const canonicalRoot = fs.realpathSync.native(root);
  const canonicalFile = fs.realpathSync.native(candidate);
  assertChildPath(canonicalRoot, canonicalFile);
  return candidate;
}

function copyEvidenceFile(sourcePath, destinationRoot, relativePath) {
  const destinationPath = path.resolve(destinationRoot, ...relativePath.split("/"));
  assertChildPath(path.resolve(destinationRoot), destinationPath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function writeInstalledReleaseEvidenceSidecar({ destinationDir, rawCertificate, rawAttestation }) {
  fs.mkdirSync(destinationDir, { recursive: false });
  const expectedFiles = [
    ["release-certificate.json", rawCertificate],
    ["release-certificate.sigstore.json", rawAttestation],
  ];
  for (const [fileName, expectedBytes] of expectedFiles) {
    const destinationPath = path.join(destinationDir, fileName);
    fs.writeFileSync(destinationPath, expectedBytes, { flag: "wx" });
    const stats = fs.lstatSync(destinationPath);
    const installedBytes = fs.readFileSync(destinationPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !installedBytes.equals(expectedBytes)) {
      throw new Error(`Installed release evidence sidecar changed while it was staged: ${fileName}`);
    }
  }
  const actualNames = fs.readdirSync(destinationDir).sort(compareStrings);
  const expectedNames = expectedFiles.map(([fileName]) => fileName).sort(compareStrings);
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error("Installed release evidence sidecar contains unexpected files.");
  }
}

async function verifyRecord(filePath, record, label, trustedRoot) {
  const expectedSha = typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
  const expectedSize = record.sizeBytes;
  assertAnchoredRegularFile(trustedRoot, filePath, label);
  const beforePathStats = fs.lstatSync(filePath);
  if (!SHA256.test(expectedSha) || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(`Certificate ${label} metadata is invalid.`);
  }
  if (!beforePathStats.isFile() || beforePathStats.isSymbolicLink() || beforePathStats.size !== expectedSize) {
    throw new Error(`Certificate ${label} does not match its source file.`);
  }
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | readNoFollowFlag());
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(filePath);
    assertAnchoredRegularFile(trustedRoot, filePath, label);
    if (
      !openedStats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      !sameFileIdentity(beforePathStats, openedStats) ||
      !sameFileIdentity(openedStats, currentPathStats) ||
      (await sha256Handle(filePath, handle)) !== expectedSha
    ) {
      throw new Error(`Certificate ${label} does not match its source file.`);
    }
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(filePath);
    assertAnchoredRegularFile(trustedRoot, filePath, label);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      !sameFileIdentity(openedStats, finalOpenedStats) ||
      !sameFileIdentity(finalOpenedStats, finalPathStats)
    ) {
      throw new Error(`Certificate ${label} changed while it was being verified.`);
    }
  } finally {
    fs.closeSync(handle);
  }
}

function assertAnchoredRegularFile(rootDir, filePath, label) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Certificate ${label} root is not a regular non-symlink directory.`);
  }
  assertChildPath(root, candidate);
  let cursor = root;
  const relative = path.relative(root, candidate);
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`Certificate ${label} traverses a symlink or junction.`);
    }
    if (cursor !== candidate && !stats.isDirectory()) {
      throw new Error(`Certificate ${label} traverses a non-directory path component.`);
    }
  }
  const candidateStats = fs.lstatSync(candidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink() || candidateStats.nlink !== 1) {
    throw new Error(`Certificate ${label} is not a regular single-link file.`);
  }
  assertChildPath(fs.realpathSync.native(root), fs.realpathSync.native(candidate));
}

function runZip(cwd, destinationPath, targetName) {
  fs.rmSync(destinationPath, { force: true });
  const result = spawnSync("zip", ["-r", destinationPath, targetName], { cwd, stdio: "inherit" });
  if (!result.error && result.status === 0) return;
  if (process.platform === "win32") {
    const sourcePath = targetName === "." ? path.join(cwd, "*") : path.join(cwd, targetName);
    const command = `Compress-Archive -Path '${sourcePath.replaceAll("'", "''")}' -DestinationPath '${destinationPath.replaceAll("'", "''")}' -Force`;
    const fallback = spawnSync("powershell", ["-NoProfile", "-Command", command], { cwd, stdio: "inherit" });
    if (!fallback.error && fallback.status === 0) return;
    if (fallback.error) throw fallback.error;
    throw new Error(`Compress-Archive exited with code ${fallback.status}`);
  }
  if (result.error) throw result.error;
  throw new Error(`zip exited with code ${result.status}`);
}

function assertChildPath(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Release evidence path escapes its supported root: ${candidate}`);
  }
}

function isRegularFileWithoutLinks(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
  } catch {
    return false;
  }
}

function sanitizeTag(value) {
  if (typeof value !== "string" || !/^v[0-9][a-z0-9.+-]{0,79}$/iu.test(value) || value.includes("..")) {
    throw new Error("Release certificate tag/version is unsafe for an artifact name.");
  }
  return value;
}

function sanitizeTarget(value) {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/i.test(value)) {
    throw new Error(`Invalid verified distribution target: ${value}`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireExactStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`Release certificate runtime payload ${label} do not match the fixed verifier policy.`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256Handle(filePath, handle) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, { fd: handle, autoClose: false, start: 0 }))
    hash.update(chunk);
  return hash.digest("hex");
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readNoFollowFlag() {
  return fs.constants.O_NOFOLLOW ?? 0;
}

async function main() {
  const outputs = await assembleRuntimeReleaseEvidence(parseArgs(process.argv.slice(2)));
  console.log(`Runtime release evidence ready: ${outputs.evidenceDir}`);
  if (outputs.evidenceArchive) console.log(`Release evidence archive ready: ${outputs.evidenceArchive}`);
  for (const output of outputs.verifiedDistributions) {
    console.log(`Verified ${output.target} distribution ready: ${output.archivePath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
