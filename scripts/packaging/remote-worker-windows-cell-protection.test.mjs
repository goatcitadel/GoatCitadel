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
const components = ["cell_volume_protection", "cell_ntfs_format", "cell_ntfs_format_wmi", "cell_virtual_disk_volume",
  "cell_virtual_disk_layout", "cell_virtual_disk_device", "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_volume_protection_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

function verifyRecords(records) {
  assert.equal(records.length, 2);
  let previous = Buffer.alloc(32);
  for (const [index, hex] of records.entries()) {
    assert.match(hex, /^[0-9a-f]{1024}$/u);
    const expected = Buffer.alloc(512);
    expected.write("GCCPRT01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); previous.copy(expected, 16);
    expected.fill(0xa1, 48, 80); expected.fill(0xb2, 80, 112);
    Buffer.from("78563412bc9aef4d8123456789abcdef", "hex").copy(expected, 112);
    expected.writeBigUInt64LE(238n * 1024n * 1024n, 128); expected.writeBigUInt64LE(0xfedcba9876543210n, 136);
    expected.writeBigUInt64LE(487423n, 144); expected.writeBigUInt64LE(60927n, 152);
    expected.writeBigUInt64LE(0xfedcba9876543210n, 160); expected.fill(0xc3, 168, 184);
    previous = createHash("sha256").update(expected.subarray(0, 480)).digest(); previous.copy(expected, 480);
    assert.deepEqual(Buffer.from(hex, "hex"), expected, "Native protection bytes must match the independently constructed record.");
  }
}

test("native cell root protection binds format identity, exact ACLs and canonical acknowledgements", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Volume Protection "));
  t.diagnostic(`Retained root protection evidence: ${output}`);
  const before = snapshot();
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "protection-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")],
      defines: ["GOATCITADEL_CELL_PROTECTION_STANDALONE"], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const result = spawnSync(executable, [directory], { encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.componentChecks >= 1100); assert.ok(receipt.nativeDirectoryChecks >= 35);
    assert.equal(receipt.physicalVolumeProtectionExercised, false);
    assert.equal(receipt.physicalFormattingExercised, false); assert.equal(receipt.attachmentExercised, false);
    verifyRecords(receipt.records);
    t.diagnostic(`${mode}: ${receipt.componentChecks} component checks and ${receipt.nativeDirectoryChecks} actual NTFS directory checks; no attachment or formatting.`);
  }
  assert.deepEqual(snapshot(), before, "Native inputs changed during protection proof.");
});
