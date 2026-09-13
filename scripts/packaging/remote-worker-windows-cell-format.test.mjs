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
const components = ["cell_ntfs_format", "cell_ntfs_format_wmi", "cell_virtual_disk_volume", "cell_virtual_disk_layout",
  "cell_virtual_disk_device", "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_ntfs_format_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

function verifyRecords(records) {
  assert.equal(records.length, 2);
  let previous = Buffer.alloc(32);
  for (const [index, hex] of records.entries()) {
    assert.match(hex, /^[0-9a-f]{1024}$/u);
    const expected = Buffer.alloc(512);
    expected.write("GCCNTF01", 0, "ascii"); expected.writeUInt32LE(index + 1, 8); previous.copy(expected, 16);
    expected.fill(0xa1, 48, 80); Buffer.from("78563412bc9aef4d8123456789abcdef", "hex").copy(expected, 80);
    expected.writeBigUInt64LE(238n * 1024n * 1024n, 96);
    expected.writeUInt32LE(512, 104); expected.writeUInt32LE(4096, 108); expected.write("GoatCitadel cell", 112, "utf16le");
    if (index === 1) {
      expected.writeBigUInt64LE(0xfedcba9876543210n, 184);
      expected.writeBigUInt64LE(487423n, 192); expected.writeBigUInt64LE(60927n, 200);
    }
    previous = createHash("sha256").update(expected.subarray(0, 480)).digest(); previous.copy(expected, 480);
    assert.deepEqual(Buffer.from(hex, "hex"), expected, "Native checkpoint bytes must match the independently constructed record.");
  }
}

test("native NTFS format requires durable intent, current authority and verified readback", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker NTFS Format "));
  t.diagnostic(`Retained formatter component evidence: ${output}`);
  const before = snapshot();
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "format-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")],
      defines: ["GOATCITADEL_CELL_FORMAT_STANDALONE"], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 45000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.componentChecks >= 1100); assert.ok(receipt.wmiSchemaChecks >= 17);
    assert.equal(receipt.physicalFormattingExercised, false); verifyRecords(receipt.records);
    t.diagnostic(`${mode}: ${receipt.componentChecks} component checks and ${receipt.wmiSchemaChecks} read-only Windows schema checks; no physical formatting.`);
  }
  assert.deepEqual(snapshot(), before, "Native inputs changed during formatter proof.");
});
