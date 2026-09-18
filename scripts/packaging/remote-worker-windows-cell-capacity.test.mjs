import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { readRemoteWorkerNativeCapacityLayout, readRemoteWorkerNativeCapacityCapture } from "../../packages/contracts/dist/index.js";

const source = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native");
const sources = ["src/cell_capacity.cpp", "src/cell_capacity_wire.cpp", "src/cell_filesystem.cpp", "src/cell_workspace.cpp", "src/cell_security.cpp",
  "tests/cell_capacity_test.cpp"];
const inputs = [...sources, "src/cell_capacity.hpp", "src/cell_capacity_wire.hpp", "src/cell_filesystem.hpp", "src/cell_runtime_bundle.hpp",
  "src/cell_job.hpp", "src/cell_job_stdio.hpp", "src/cell_workspace.hpp", "src/cell_security.hpp",
  ...["cell_volume_mount", "cell_volume_mount_target", "cell_volume_protection", "cell_ntfs_format",
    "cell_virtual_disk_volume", "cell_virtual_disk_layout", "cell_virtual_disk_device", "cell_virtual_disk"].map(name => `src/${name}.hpp`)];
const snapshot = () => inputs.map((file) => ({ file,
  sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));
const consumerSnapshot = () => ["remote-worker-native-capacity-capture", "remote-worker-native-capacity-layout", "remote-worker-cell", "sha256", "canonical-json"]
  .flatMap(name => ["src", "dist"].map(kind => {
    const file = `packages/contracts/${kind}/${name}.${kind === "src" ? "ts" : "js"}`;
    return { file, sha256: createHash("sha256").update(fs.readFileSync(path.resolve(source, "../..", file))).digest("hex") };
  }));

test("native capacity inventory binds handles and accounts complete ordinary, sparse and compressed trees", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Capacity "));
  t.diagnostic(`Retained native capacity inventory evidence: ${output}`);
  const before = snapshot(), consumers = consumerSnapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "cell-capacity-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 100);
    assert.ok(receipt.pinnedFileReadChecks >= 40, "Run bounded pinned-file export and revocation checks.");
    assert.ok(receipt.pinnedFileSelectionChecks >= 50, "Resolve approved relative paths through pinned memberships under fresh authority.");
    assert.equal(receipt.volumeOperations, false); assert.equal(receipt.quotaEnforced, false);
    const layout = readRemoteWorkerNativeCapacityLayout(fs.readFileSync(path.join(directory, "data", "expected-layout.bin")).toString("hex"));
    const frame = fs.readFileSync(path.join(directory, "data", "layout-capture.bin"));
    const capture = readRemoteWorkerNativeCapacityCapture(frame.toString("hex"), "33".repeat(32), layout);
    const borrowedFrame = fs.readFileSync(path.join(directory, "data", "borrowed-capture.bin"));
    assert.deepEqual(borrowedFrame, frame, "Borrowing the exact original writer handle must preserve counts and identities.");
    assert.deepEqual(readRemoteWorkerNativeCapacityCapture(borrowedFrame.toString("hex"), "33".repeat(32), layout), capture);
    assert.equal(capture.areas.length, 13); assert.deepEqual(capture.nativeLayout, layout);
    for (let area = 0; area < 13; area++) {
      assert.equal(capture.areas[area].objects.length, 2);
      const file = capture.areas[area].objects.find(object => object.kind === "file");
      assert.equal(file.logicalBytes, fs.statSync(path.join(directory, "data", `layout-${area}`, "data")).size);
    }
    for (const offset of [0, 8, 40, 48, 80, 112, 436, 852, 868, frame.length - 1]) {
      const changed = Buffer.from(frame); changed[offset] ^= 0x80;
      assert.throws(() => readRemoteWorkerNativeCapacityCapture(changed.toString("hex"), "33".repeat(32), layout));
    }
    assert.throws(() => readRemoteWorkerNativeCapacityCapture(frame.toString("hex"), "44".repeat(32), layout));
    fs.writeFileSync(path.join(directory, "decoded-capture.json"), JSON.stringify(capture, null, 2), { flag: "wx" });
    outcomes.push({ mode, ...receipt });
    t.diagnostic(`${mode}: ${receipt.checks} checks on retained ordinary NTFS fixtures.`);
  }
  assert.deepEqual(snapshot(), before, "Capacity inventory sources changed during proof.");
  assert.deepEqual(consumerSnapshot(), consumers, "Capacity decoder sources changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, consumerManifest: consumers, outcomes, arm64Executed: false,
    boundary: "Read-only inventory of owned temporary directories. No virtual-disk operation, installed service, hard quota enforcement or complete pool inventory." }, null, 2), { flag: "wx" });
});
