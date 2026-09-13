import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeReleasePayloadFiles } from "./package-renderers.mjs";

export const WORKER_PACKAGE_SCHEMA = "goatcitadel.remote-worker-windows-package.v3";
export const WORKER_PACKAGE_NODE_VERSION = "24.19.0";
export const WORKER_PACKAGE_OPENSSL_VERSION = "3.5.7";
// https://nodejs.org/dist/v24.19.0/SHASUMS256.txt (win-{x64,arm64}/node.exe).
export const WORKER_PACKAGE_NODE_SHA256 = Object.freeze({
  "windows-x64": "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
  "windows-arm64": "3958e4bb3f2d4ef37c938215dfc65a9d3c9d839b5060fec103bd2345fa78e951",
});
export const WORKER_PACKAGE_MANIFEST_NAME = "worker-package.json";
export const WORKER_PACKAGE_LIMITS = Object.freeze({
  files: 10000,
  fileBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
});
export const workerPackageSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Package directory must be absolute.");
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()
  )
    throw new Error("Package directory must not contain links or reparse aliases.");
  return resolved;
}

function safeName(value) {
  if (
    !/^[a-zA-Z0-9_@+.-]+$/u.test(value) ||
    /[. ]$/u.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("Package contains an unsafe Windows path component.");
}

export function readPackageFile(file, { requireIndependent = false, maxBytes = WORKER_PACKAGE_LIMITS.fileBytes } = {}) {
  const before = fs.lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(maxBytes) ||
    (requireIndependent && before.nlink !== 1n)
  )
    throw new Error("Package file is linked, not regular, or oversized.");
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(handle, { bigint: true });
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, Math.min(bytes.length - offset, 65536), offset);
      if (count === 0) throw new Error("Package file was truncated while it was read.");
      offset += count;
    }
    if (fs.readSync(handle, Buffer.alloc(1), 0, 1, offset) !== 0)
      throw new Error("Package file grew while it was read.");
    const after = fs.fstatSync(handle, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    for (const stat of [opened, after, named]) {
      if (["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].some((key) => stat[key] !== before[key]))
        throw new Error("Package file changed while it was read.");
    }
    if (BigInt(bytes.length) !== before.size) throw new Error("Package file size changed while it was read.");
    return bytes;
  } finally {
    fs.closeSync(handle);
  }
}

export function copyWorkerPackageTree(source, destination, include = () => true) {
  canonicalDirectory(source);
  fs.mkdirSync(destination);
  const seen = new Set();
  for (const entry of fs.readdirSync(source).sort()) {
    safeName(entry);
    if (seen.has(entry.toLowerCase())) throw new Error("Package contains a case-fold collision.");
    seen.add(entry.toLowerCase());
    const from = path.join(source, entry),
      to = path.join(destination, entry);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error("Package source contains a link or special file.");
    if (!include(from, stat)) continue;
    if (stat.isDirectory()) copyWorkerPackageTree(from, to, include);
    else fs.writeFileSync(to, readPackageFile(from), { flag: "wx" });
  }
}

export function inventoryWorkerPackage(root, { manifestName = WORKER_PACKAGE_MANIFEST_NAME } = {}) {
  safeName(manifestName);
  canonicalDirectory(root);
  const files = [];
  let totalBytes = 0;
  const visit = (directory, relative) => {
    canonicalDirectory(directory);
    const seen = new Set();
    for (const name of fs.readdirSync(directory).sort()) {
      safeName(name);
      const folded = name.toLowerCase();
      if (seen.has(folded)) throw new Error("Package contains a case-fold collision.");
      seen.add(folded);
      if (!relative && name === manifestName) continue;
      const file = path.join(directory, name),
        recordPath = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Package contains a link or reparse alias.");
      if (stat.isDirectory()) {
        visit(file, recordPath);
        continue;
      }
      const bytes = readPackageFile(file, { requireIndependent: true });
      totalBytes += bytes.length;
      if (files.length >= WORKER_PACKAGE_LIMITS.files || totalBytes > WORKER_PACKAGE_LIMITS.totalBytes)
        throw new Error("Package exceeds its file or byte limit.");
      files.push({ path: recordPath, sizeBytes: bytes.length, sha256: workerPackageSha256(bytes) });
    }
  };
  visit(root, "");
  return normalizeReleasePayloadFiles(files, { platform: "windows" });
}

export function verifyRemoteWorkerWindowsPackage({ root, expectedManifestSha256 }) {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? ""))
    throw new Error("An independently supplied package manifest hash is required.");
  canonicalDirectory(root);
  const bytes = readPackageFile(path.join(root, WORKER_PACKAGE_MANIFEST_NAME), {
    requireIndependent: true,
    maxBytes: 2 * 1024 * 1024,
  });
  if (bytes.length > 2 * 1024 * 1024 || workerPackageSha256(bytes) !== expectedManifestSha256)
    throw new Error("Package manifest differs from its expected hash.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest.schemaVersion !== WORKER_PACKAGE_SCHEMA ||
    !["windows-x64", "windows-arm64"].includes(manifest.target) ||
    manifest.nodeVersion !== WORKER_PACKAGE_NODE_VERSION ||
    manifest.opensslVersion !== WORKER_PACKAGE_OPENSSL_VERSION ||
    manifest.entrypoint !== "app/worker/dist/main.js" ||
    manifest.nodeExecutable !== "app/runtime/node.exe" ||
    manifest.hostExecutable !== "bin/GoatCitadelRemoteWorkerHost.exe"
  )
    throw new Error("Package manifest runtime contract is invalid.");
  const actual = inventoryWorkerPackage(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Package inventory differs: changed, missing or unexpected files.");
  for (const required of [
    manifest.entrypoint,
    manifest.nodeExecutable,
    manifest.hostExecutable,
    "app/runtime/worker-host-receipt.json",
    "app/worker/dist/index.js",
    "app/install/install-worker-service.ps1",
    "app/install/uninstall-worker-service.ps1",
    "app/install/enroll-worker-service.ps1",
    "app/install/worker-enrollment-common.ps1",
    "app/install/worker-install-common.ps1",
  "app/install/worker-install-native.cs",
    "app/install/configure-worker-mesh-registry.ps1",
    "app/install/worker-mesh-registry-common.ps1",
    "app/install/broker-coordinator-common.ps1",
    "app/install/install-broker-coordinator.ps1",
    "app/install/uninstall-broker-coordinator.ps1",
    "bin/worker.ps1",
    "app/pnpm-lock.yaml",
    "app/worker/native/GoatCitadelRemoteWorkerImageGuard.node",
    "app/worker/native/GoatCitadelRemoteWorkerTlsKey.dll",
    "app/worker/native/GoatCitadelRemoteWorkerFiles.exe",
    "app/worker/native/GoatCitadelRemoteWorkerStdio.exe",
    "app/worker/native/GoatCitadelRemoteWorkerCellProvisioning.exe",
    "app/worker/native/GoatCitadelRemoteWorkerCellController.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisioner.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisionerClient.exe",
    "app/provisioner/GoatCitadelRemoteWorkerProvisionerAvailability.exe",
  ])
    if (!actual.some((file) => file.path === required))
      throw new Error("Package is missing a required runtime component.");
  return Object.freeze({
    manifestSha256: expectedManifestSha256,
    fileCount: actual.length,
    totalBytes: actual.reduce((sum, file) => sum + file.sizeBytes, 0),
    target: manifest.target,
  });
}
