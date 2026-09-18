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
const components = ["cell_volume_mount", "cell_volume_mount_target", "cell_volume_protection", "cell_ntfs_format",
  "cell_ntfs_format_wmi", "cell_virtual_disk_volume", "cell_virtual_disk_layout", "cell_virtual_disk_device",
  "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_volume_mount_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp", "src/cell_capacity.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

function verifyRecords(records) {
  assert.equal(records.length, 4);
  let previous = Buffer.alloc(32);
  for (const [index, hex] of records.entries()) {
    assert.match(hex, /^[0-9a-f]{1024}$/u);
    const expected = Buffer.alloc(512);
    expected.write("GCCMNT01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); previous.copy(expected, 16);
    expected.fill(0xa1, 48, 80); expected.fill(0xb2, 80, 112);
    Buffer.from("78563412bc9aef4d8123456789abcdef", "hex").copy(expected, 112);
    expected.writeBigUInt64LE(0x123456789abcdef0n, 128); expected.fill(0xc3, 136, 152);
    expected.writeBigUInt64LE(0xfedcba9876543210n, 152); expected.fill(0xd4, 160, 176);
    if (index > 0) { expected.writeBigUInt64LE(0x123456789abcdef0n, 176); expected.fill(0xe5, 184, 200); }
    previous = createHash("sha256").update(expected.subarray(0, 480)).digest(); previous.copy(expected, 480);
    assert.deepEqual(Buffer.from(hex, "hex"), expected, "Native mount records must match the independently constructed chain.");
  }
}

test("governed mount owner requires exact intent/ACKs and read-only recovery without real volume mutations", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Volume Mount "));
  t.diagnostic(`Retained controlled mount evidence: ${output}`);
  const before = snapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "mount-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")],
      defines: ["GOATCITADEL_CELL_MOUNT_STANDALONE"], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 2300); assert.ok(receipt.nativeDirectoryChecks >= 9);
    for (const key of ["volumeMounted", "volumeAttached", "ntfsFormatted", "rootPermissionsChanged"]) assert.equal(receipt[key], false);
    verifyRecords(receipt.records);
    outcomes.push({ mode, ...receipt });
    t.diagnostic(`${mode}: ${receipt.checks} checks including ${receipt.nativeDirectoryChecks} ordinary directory checks; mount SDK simulated.`);
  }
  assert.deepEqual(snapshot(), before, "Native mount inputs changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, outcomes, arm64Executed: false,
    boundary: "Controlled mount operations, independent record decoder and ordinary temporary NTFS directories. No real attachment, partitioning, formatting, mounting or volume-root permission change. Native mount success and installed recovery are not proven; journal/transport, quotas and execution remain separate." }, null, 2), { flag: "wx" });
});
