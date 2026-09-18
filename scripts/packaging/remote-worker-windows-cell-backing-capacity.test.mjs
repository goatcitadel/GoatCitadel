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
const sources = ["src/cell_virtual_disk.cpp", "src/cell_filesystem.cpp", "src/cell_workspace.cpp", "src/cell_security.cpp",
  "tests/cell_backing_capacity_test.cpp"];
const inputs = [...sources, "src/cell_virtual_disk.hpp", "src/cell_capacity.hpp", "src/cell_filesystem.hpp", "src/cell_workspace.hpp",
  "src/cell_security.hpp", "src/cell_runtime_bundle.hpp", "src/cell_job.hpp", "src/cell_job_stdio.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

test("native backing capacity binds host allocation to the recorded unattached VHDX", {
  skip: process.platform !== "win32", timeout: 180000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Backing Capacity "));
  t.diagnostic(`Retained backing capacity evidence: ${output}`);
  const before = snapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "cell-backing-capacity-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 45000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 60);
    assert.equal(receipt.volumeOperations, false); assert.equal(receipt.quotaEnforced, false);
    outcomes.push({ mode, ...receipt }); t.diagnostic(`${mode}: ${receipt.checks} backing-capacity checks.`);
  }
  assert.deepEqual(snapshot(), before, "Backing capacity sources changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, outcomes, arm64Executed: false,
    boundary: "Read-only capacity queries on exact recorded, unattached VHDX files in owned temporary directories. No drive operation, installed service, hard quota or complete pool inventory." }, null, 2), { flag: "wx" });
});
