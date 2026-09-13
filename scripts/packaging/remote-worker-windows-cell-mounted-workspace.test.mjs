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
const components = ["cell_mounted_workspace", "cell_volume_mount", "cell_volume_mount_target", "cell_volume_protection",
  "cell_ntfs_format", "cell_ntfs_format_wmi", "cell_virtual_disk_volume", "cell_virtual_disk_layout",
  "cell_virtual_disk_device", "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_mounted_workspace_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file,
  sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

function verifyRecords(records) {
  assert.equal(records.length, 2);
  let previous = Buffer.alloc(32);
  for (const [index, hex] of records.entries()) {
    assert.match(hex, /^[0-9a-f]{1024}$/u);
    const expected = Buffer.alloc(512);
    expected.write("GCCWRK01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); previous.copy(expected, 16);
    expected.fill(0xa1, 48, 80); expected.fill(0xb2, 80, 112);
    expected.write("gc-cell-0123456789abcdef0123456789abcdef", 112, "ascii");
    expected.writeBigUInt64LE(0xfedcba9876543210n, 152); expected.fill(0xc3, 160, 176);
    if (index) {
      for (let directory = 0; directory < 4; ++directory) {
        const offset = 176 + directory * 24;
        expected.writeBigUInt64LE(0xfedcba9876543210n, offset); expected.fill(0xd0 + directory, offset + 8, offset + 24);
      }
    }
    previous = createHash("sha256").update(expected.subarray(0, 480)).digest(); previous.copy(expected, 480);
    assert.deepEqual(Buffer.from(hex, "hex"), expected, "Native workspace records must match an independently constructed chain.");
  }
}

test("mounted workspace owner requires exact ACKs, per-directory guards and read-only recorded recovery", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Mounted Workspace "));
  t.diagnostic(`Retained controlled mounted workspace evidence: ${output}`);
  const before = snapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "mounted-workspace-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")],
      defines: ["GOATCITADEL_CELL_MOUNTED_WORKSPACE_STANDALONE"], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 200); assert.ok(receipt.nativeDirectoryChecks >= 80);
    for (const key of ["volumeMounted", "volumeAttached", "ntfsFormatted", "rootPermissionsChanged"]) assert.equal(receipt[key], false);
    verifyRecords(receipt.records); outcomes.push({ mode, ...receipt });
    t.diagnostic(`${mode}: ${receipt.checks} checks including ${receipt.nativeDirectoryChecks} ordinary directory checks; physical volume operations disabled.`);
  }
  assert.deepEqual(snapshot(), before, "Native mounted workspace inputs changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, outcomes, arm64Executed: false,
    boundary: "Controlled owner operations, independent record decoder and ordinary temporary NTFS directories. No real attachment, partitioning, formatting, mounting or volume-root permission change. Journal/transport integration, quotas, protected execution and installed recovery remain separate." }, null, 2), { flag: "wx" });
});
