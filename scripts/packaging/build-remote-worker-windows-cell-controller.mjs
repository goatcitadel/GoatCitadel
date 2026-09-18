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
    "cell_mounted_workspace", "cell_capacity", "cell_capacity_wire", "cell_joined_capacity_wire", "cell_pool_capacity", "cell_installed_pool_capacity", "cell_filesystem", "cell_workspace", "cell_security",
    "cell_runtime_client_session", "cell_runtime_session", "cell_runtime_result", "cell_runtime_file_transfer", "cell_runtime_streams", "cell_controller_runtime", "cell_runtime_transfer", "cell_runtime_dispatch", "cell_journal_runtime", "cell_stdio_protocol",
    "cell_runtime_bundle", "cell_job", "cell_job_stdio"].flatMap((name) =>
    ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`)),
  `${cell}/src/cell_mounted_workspace_capacity.cpp`,
  `${cell}/src/cell_runtime_bundle_install.cpp`,
  `${cell}/src/cell_runtime_install.cpp`, `${cell}/src/cell_runtime_install.hpp`,
  `${cell}/src/cell_controller_install.cpp`, `${cell}/src/cell_controller_install.hpp`,
  `${cell}/src/cell_install_capacity.cpp`, `${cell}/src/cell_install_capacity.hpp`,
  `${cell}/src/cell_install_capacity_challenge.cpp`, `${cell}/src/cell_install_capacity_challenge.hpp`,
  `${cell}/src/cell_controller_attestation.cpp`, `${cell}/src/cell_controller_attestation.hpp`,
  `${cell}/src/cell_install_capacity_pipe.cpp`, `${cell}/src/cell_install_capacity_pipe.hpp`,
  `${cell}/src/cell_install_capacity_stdio.hpp`,
  `${cell}/src/cell_job_stdio_internal.hpp`,
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
export function buildWindowsCellController({ target = "windows-x64", outputDirectory, snapshot, asan = false, fixture, extraSources = [], sourceBatchSize = 0 }) {
  const sources = CELL_CONTROLLER_SERVICE_INPUTS.filter((name) => name.endsWith(".cpp") &&
    (!fixture || !name.endsWith("/cell_controller_main.cpp")));
  if (fixture) sources.push(fixture);
  sources.push(...extraSources);
  return compileTlsNative({
    target, outputDirectory,
    outputName: fixture ? `cell-controller-session${asan ? "-asan" : ""}.exe`
      : `GoatCitadelRemoteWorkerCellController${asan ? "-asan" : ""}.exe`,
    sources: sources.map((name) => path.join(snapshot.root, name)),
    includes: [path.join(snapshot.root, cell, "src"), path.join(snapshot.root, host, "src")], asan, sourceBatchSize,
  });
}

export function buildWindowsCellControllerPayload({ target, outputDirectory }) {
  resolveExactWindowsToolchain(target);
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory))
    throw new Error("An absolute fresh controller output directory is required.");
  fs.mkdirSync(outputDirectory);
  const snapshot = snapshotCellControllerSources(outputDirectory);
  // Keep each compiler invocation within the existing bounded build timeout.
  const executable = buildWindowsCellController({ target, outputDirectory, snapshot, sourceBatchSize: 8 });
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
