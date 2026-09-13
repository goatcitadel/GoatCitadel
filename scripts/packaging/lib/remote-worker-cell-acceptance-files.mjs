import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { inventoryWorkerPackage, readPackageFile, workerPackageSha256,
  WORKER_PACKAGE_NODE_VERSION, WORKER_PACKAGE_NODE_SHA256 } from "./remote-worker-package-files.mjs";
import { WORKER_CELL_SOURCE_FILES } from "./remote-worker-cell-build-inputs.mjs";

export const CELL_ACCEPTANCE_SCHEMA = "goatcitadel.windows-cell-acceptance.v1";
export const CELL_ACCEPTANCE_MANIFEST = "cell-acceptance.json";
export const CELL_ACCEPTANCE_RUNTIME_FILES = Object.freeze([
  "clang_rt.asan_dynamic-x86_64.dll", "vcruntime140.dll", "vcruntime140_1.dll",
]);
export const CELL_ACCEPTANCE_NATIVE_FILES = Object.freeze([
  "cell-job-test.exe", "cell-job-asan.exe", "job-fixture.exe", ...CELL_ACCEPTANCE_RUNTIME_FILES,
]);
export const CELL_ACCEPTANCE_SCRIPT_FILES = Object.freeze([
  "scripts/packaging/run-remote-worker-cell-acceptance.mjs",
  "scripts/packaging/remote-worker-windows-cell.test.mjs",
  "scripts/packaging/build-remote-worker-windows-tls.mjs",
  "scripts/packaging/lib/remote-worker-windows-toolchain.mjs",
  "scripts/packaging/lib/remote-worker-cell-build-inputs.mjs",
  "scripts/packaging/lib/remote-worker-cell-acceptance-files.mjs",
  "scripts/packaging/lib/remote-worker-package-files.mjs",
  "scripts/packaging/lib/package-renderers.mjs",
]);
export const CELL_ACCEPTANCE_FILES = Object.freeze([
  ...CELL_ACCEPTANCE_NATIVE_FILES.map((file) => `app/native/${file}`),
  ...CELL_ACCEPTANCE_SCRIPT_FILES.map((file) => `app/${file}`),
  ...WORKER_CELL_SOURCE_FILES.map((file) => `app/apps/remote-worker-windows-cell-native/${file}`),
  "app/runtime/node.exe", "app/licenses/Node-LICENSE.txt", "app/licenses/MSVC-ThirdPartyNotices.txt",
  "app/licenses/MSVC-Redist.txt", "app/README.txt",
].sort());

export function verifyWorkerCellAcceptance({ root, expectedManifestSha256 }) {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")) throw new Error("An independent cell acceptance manifest hash is required.");
  const bytes = readPackageFile(path.join(root, CELL_ACCEPTANCE_MANIFEST), { requireIndependent: true, maxBytes: 128 * 1024 });
  if (workerPackageSha256(bytes) !== expectedManifestSha256) throw new Error("Cell acceptance manifest hash differs.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["files", "nodeVersion", "schemaVersion", "target", "testingOnly"]);
  if (manifest.schemaVersion !== CELL_ACCEPTANCE_SCHEMA || manifest.target !== "windows-x64" || manifest.testingOnly !== true ||
      manifest.nodeVersion !== WORKER_PACKAGE_NODE_VERSION) throw new Error("Unsupported cell acceptance package.");
  const inventory = inventoryWorkerPackage(root, { manifestName: CELL_ACCEPTANCE_MANIFEST });
  assert.deepEqual(inventory.map((file) => file.path).sort(), CELL_ACCEPTANCE_FILES, "Cell acceptance package has missing or extra files.");
  assert.deepEqual(inventory, manifest.files, "Cell acceptance inventory changed.");
  if (inventory.find((file) => file.path === "app/runtime/node.exe")?.sha256 !== WORKER_PACKAGE_NODE_SHA256["windows-x64"])
    throw new Error("Cell acceptance Node binary differs from its independent pin.");
  return Object.freeze({ root, manifestSha256: expectedManifestSha256, files: Object.freeze(inventory.map(Object.freeze)) });
}

/** Copy only verified bytes into the lane's fresh output directory. Native
 * fixtures create their own files beside these copies, never in the package. */
export function stageWorkerCellAcceptance(reference, output) {
  const inventory = verifyWorkerCellAcceptance(reference);
  for (const name of CELL_ACCEPTANCE_NATIVE_FILES) {
    const entry = inventory.files.find((file) => file.path === `app/native/${name}`);
    const bytes = readPackageFile(path.join(reference.root, entry.path), { requireIndependent: true });
    if (workerPackageSha256(bytes) !== entry.sha256) throw new Error("Cell acceptance input changed before staging.");
    fs.writeFileSync(path.join(output, name), bytes, { flag: "wx" });
  }
  fs.writeFileSync(path.join(output, "acceptance-package.json"), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
  return { fixture: path.join(output, "job-fixture.exe"), controller: path.join(output, "cell-job-test.exe"),
    asan: path.join(output, "cell-job-asan.exe"), runtimeDirectory: output };
}
