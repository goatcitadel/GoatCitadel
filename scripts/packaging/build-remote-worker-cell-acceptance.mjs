import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { WORKER_CELL_SOURCE_FILES, WORKER_CELL_FIXTURE_SOURCES, WORKER_CELL_CONTROLLER_SOURCES } from "./lib/remote-worker-cell-build-inputs.mjs";
import { CELL_ACCEPTANCE_SCHEMA, CELL_ACCEPTANCE_MANIFEST, CELL_ACCEPTANCE_SCRIPT_FILES, CELL_ACCEPTANCE_RUNTIME_FILES,
  verifyWorkerCellAcceptance } from "./lib/remote-worker-cell-acceptance-files.mjs";
import { inventoryWorkerPackage, readPackageFile, workerPackageSha256,
  WORKER_PACKAGE_NODE_VERSION, WORKER_PACKAGE_NODE_SHA256 } from "./lib/remote-worker-package-files.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
function copy(source, destination, expected) {
  const bytes = readPackageFile(source);
  if (expected && workerPackageSha256(bytes) !== expected) throw new Error("Cell acceptance input differs from its independent pin.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: "wx" });
}

export function buildWorkerCellAcceptance({ output, nodeExecutable, nodeLicense }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build cell acceptance on Windows x64.");
  for (const value of [output, nodeExecutable, nodeLicense])
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Absolute build-input and fresh output paths are required.");
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const parent = path.dirname(path.resolve(output));
  if (fs.realpathSync.native(parent).toLowerCase() !== parent.toLowerCase()) throw new Error("The output parent must not contain path aliases.");
  fs.mkdirSync(output); // Never replace an existing candidate or its evidence.
  const payload = path.join(output, "payload"), build = path.join(output, "build");
  fs.mkdirSync(payload); fs.mkdirSync(build);
  copy(nodeExecutable, path.join(payload, "app/runtime/node.exe"), WORKER_PACKAGE_NODE_SHA256["windows-x64"]);
  copy(nodeLicense, path.join(payload, "app/licenses/Node-LICENSE.txt"));
  copy(path.join(toolchain.visualStudioRoot, "Licenses/1033/ThirdPartyNotices.txt"), path.join(payload, "app/licenses/MSVC-ThirdPartyNotices.txt"));
  copy(path.join(toolchain.visualStudioRoot, "Licenses/1033/Redist.txt"), path.join(payload, "app/licenses/MSVC-Redist.txt"));
  for (const file of CELL_ACCEPTANCE_SCRIPT_FILES) copy(path.join(repository, file), path.join(payload, "app", file));
  const source = path.join(payload, "app/apps/remote-worker-windows-cell-native");
  for (const file of WORKER_CELL_SOURCE_FILES) copy(path.join(repository, "apps/remote-worker-windows-cell-native", file), path.join(source, file));
  // Compile the frozen staged sources, then retain only execution inputs in the
  // test package. Compiler output and build logs remain outside its inventory.
  const options = { target: "windows-x64", outputDirectory: build, includes: [path.join(source, "src")] };
  const fixture = compileTlsNative({ ...options, outputName: "job-fixture.exe", sources: WORKER_CELL_FIXTURE_SOURCES.map((file) => path.join(source, file)) });
  const sources = WORKER_CELL_CONTROLLER_SOURCES.map((file) => path.join(source, file));
  const controller = compileTlsNative({ ...options, outputName: "cell-job-test.exe", sources });
  const asan = compileTlsNative({ ...options, outputName: "cell-job-asan.exe", sources, asan: true });
  for (const file of [fixture, controller, asan]) copy(file, path.join(payload, "app/native", path.basename(file)));
  for (const file of CELL_ACCEPTANCE_RUNTIME_FILES)
    copy(path.join(path.dirname(toolchain.compilerPath), file), path.join(payload, "app/native", file));
  fs.writeFileSync(path.join(payload, "app/README.txt"), `GoatCitadel native Windows cell acceptance\n\nPrivate test bundle for your Windows x64 test machines. This is an unsigned acceptance candidate, not a worker installer. No compiler, pnpm, provider account or network download is needed. Keep the independently supplied manifest SHA-256 with the bundle.\n\nFrom PowerShell in the payload directory, replace HASH below with that supplied value:\n\n.\\app\\runtime\\node.exe .\\app\\scripts\\packaging\\run-remote-worker-cell-acceptance.mjs --manifest-sha256 HASH\n\nThis runs normal and AddressSanitizer resource, identity, recovery, loopback and controller-crash checks in a fresh temporary directory. It creates only its own test files, disk images and AppContainer profiles, retains evidence and does not attach a volume by default.\n\nAdd --preflight to check the existing Windows volume-management privilege without attaching a disk. Add --attachment in an administrator PowerShell session to run the same suite plus attachment, recorded recovery and explicit detach of the test's own images. The runner never elevates or grants a user right. A failed volume operation can retain its own image for reconciliation; preserve the printed evidence directory.\n\nThis bundle does not certify installed worker services, Gateway authorization, quotas, real-provider results or a second machine until those corresponding journeys actually run. The included Microsoft sanitizer runtime is for these private tests; it is not part of the shipped worker runtime.\n`, { flag: "wx" });
  const files = inventoryWorkerPackage(payload, { manifestName: CELL_ACCEPTANCE_MANIFEST });
  const manifest = { schemaVersion: CELL_ACCEPTANCE_SCHEMA, target: "windows-x64", testingOnly: true, nodeVersion: WORKER_PACKAGE_NODE_VERSION, files };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(payload, CELL_ACCEPTANCE_MANIFEST), bytes, { flag: "wx" });
  const manifestSha256 = workerPackageSha256(bytes);
  verifyWorkerCellAcceptance({ root: payload, expectedManifestSha256: manifestSha256 });
  return { payload, manifestSha256, fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    boundary: "Unsigned private Windows test bundle; no installed-service or physical-machine acceptance is implied." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const names = { "--output-dir": "output", "--node-executable": "nodeExecutable", "--node-license": "nodeLicense" };
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = Object.hasOwn(names, process.argv[index]) ? names[process.argv[index]] : undefined;
      if (!key || Object.hasOwn(options, key) || !process.argv[index + 1]) throw new Error("Usage: --output-dir <fresh directory> --node-executable <pinned Node> --node-license <license file>");
      options[key] = process.argv[index + 1];
    }
    console.log(JSON.stringify(buildWorkerCellAcceptance(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
