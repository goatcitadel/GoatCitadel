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
const components = ["cell_virtual_disk_volume", "cell_virtual_disk_layout", "cell_virtual_disk_device",
  "cell_virtual_disk", "cell_workspace", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_virtual_disk_volume_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

test("native volume binding rejects foreign identities, ambiguous discovery and changed driver replies", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Volume Binding "));
  t.diagnostic(`Retained volume binding component evidence: ${output}`);
  const before = snapshot();
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "volume-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")],
      defines: ["GOATCITADEL_CELL_VOLUME_STANDALONE"], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 45000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.ok(receipt.componentChecks >= 300);
    assert.equal(receipt.actualVolumeBindingExercised, false);
    assert.equal(receipt.formattingExercised, false);
    t.diagnostic(`${mode}: ${receipt.componentChecks} component checks; physical volume binding and formatting were not exercised.`);
  }
  assert.deepEqual(snapshot(), before, "Native inputs changed during component proof.");
});
