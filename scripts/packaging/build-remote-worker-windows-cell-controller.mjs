import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { assertNoRemoteWorkerBuildPathLeak, resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

const cell = "apps/remote-worker-windows-cell-native";
const host = "apps/remote-worker-windows-host-native";
export const CELL_CONTROLLER_IMAGE = "GoatCitadelRemoteWorkerCellController.exe";
export const CELL_CONTROLLER_SERVICE_INPUTS = Object.freeze([
  `${cell}/src/cell_controller_main.cpp`,
  ...["cell_controller_protocol", "cell_controller_transport", "cell_controller_identity", "cell_provisioning_journal",
    "cell_virtual_disk", "cell_virtual_disk_device", "cell_virtual_disk_layout", "cell_virtual_disk_volume",
    "cell_ntfs_format", "cell_ntfs_format_wmi", "cell_volume_protection", "cell_volume_mount", "cell_volume_mount_target",
    "cell_mounted_workspace", "cell_filesystem", "cell_workspace", "cell_security"].flatMap((name) =>
    ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`)),
  ...["cell_runtime_bundle", "cell_job", "cell_job_stdio"].map((name) => `${cell}/src/${name}.hpp`),
  `${host}/src/service_identity.cpp`, `${host}/src/service_identity.hpp`, `${host}/src/worker_host.hpp`,
  `${host}/src/service_inspection.cpp`, `${host}/src/service_inspection.hpp`,
]);

// Build-only snapshot, not an installed-custody receipt or release signature.
export function snapshotCellControllerSources(output, extra = []) {
  const repository = path.resolve(import.meta.dirname, "../..");
  const root = path.join(output, "source");
  const sourceManifest = [...CELL_CONTROLLER_SERVICE_INPUTS, ...extra].map((name) => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx" });
    return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return { root, sourceManifest };
}
export function buildWindowsCellController({ target = "windows-x64", outputDirectory, snapshot, asan = false, fixture, extraSources = [] }) {
  const sources = CELL_CONTROLLER_SERVICE_INPUTS.filter((name) => name.endsWith(".cpp") &&
    (!fixture || !name.endsWith("/cell_controller_main.cpp")));
  if (fixture) sources.push(fixture);
  sources.push(...extraSources);
  return compileTlsNative({
    target, outputDirectory,
    outputName: fixture ? `cell-controller-session${asan ? "-asan" : ""}.exe`
      : `GoatCitadelRemoteWorkerCellController${asan ? "-asan" : ""}.exe`,
    sources: sources.map((name) => path.join(snapshot.root, name)),
    includes: [path.join(snapshot.root, cell, "src"), path.join(snapshot.root, host, "src")], asan,
  });
}

export function buildWindowsCellControllerPayload({ target, outputDirectory }) {
  resolveExactWindowsToolchain(target);
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("An absolute fresh controller output directory is required.");
  fs.mkdirSync(outputDirectory);
  const snapshot = snapshotCellControllerSources(outputDirectory);
  const executable = buildWindowsCellController({ target, outputDirectory, snapshot });
  const bytes = fs.readFileSync(executable);
  assertNoRemoteWorkerBuildPathLeak(bytes, [path.resolve(import.meta.dirname, "../.."), outputDirectory]);
  const receipt = {
    schemaVersion: "goatcitadel.remote-worker.windows-cell-controller-build.v1",
    target,
    sourceManifest: snapshot.sourceManifest,
    artifact: { name: CELL_CONTROLLER_IMAGE, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length },
    acceptance: { installedService: "unproven", protectedCustody: "unproven", signature: "unsigned_candidate" },
  };
  fs.writeFileSync(path.join(outputDirectory, "cell-controller-build-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return { executable, receipt };
}
