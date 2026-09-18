import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

const source = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native");
const components = ["cell_capacity", "cell_mounted_workspace", "cell_volume_mount", "cell_volume_mount_target", "cell_volume_protection",
  "cell_ntfs_format", "cell_ntfs_format_wmi", "cell_virtual_disk_volume", "cell_virtual_disk_layout",
  "cell_virtual_disk_device", "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "src/cell_mounted_workspace_capacity.cpp",
  "src/cell_runtime_bundle_install.cpp",
  "tests/cell_mounted_workspace_capacity_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_job_stdio.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file,
  sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

test("mounted capacity reads bind immutable history, live authority and actual protected directory inventory", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Mounted Capacity "));
  t.diagnostic(`Retained controlled mounted capacity evidence: ${output}`);
  const before = snapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "mounted-capacity-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 100);
    assert.equal(receipt.physicalVolumeVerified, false); assert.equal(receipt.volumeOperations, false);
    outcomes.push({ mode, ...receipt });
    t.diagnostic(`${mode}: ${receipt.checks} checks with controlled volume verification and real directory inventory.`);
  }
  assert.deepEqual(snapshot(), before, "Mounted capacity sources changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, outcomes, arm64Executed: false,
    boundary: "Controlled mounted-boundary verifier with real protected NTFS directory inventory. No physical volume operation, installed custody, controller transport or hard quota enforcement." }, null, 2), { flag: "wx" });
});
