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
const components = ["cell_volume_mount_target", "cell_filesystem", "cell_security"];
const sources = [...components.map((name) => `src/${name}.cpp`), "tests/cell_volume_mount_target_test.cpp"];
const inputs = [...sources, ...components.map((name) => `src/${name}.hpp`), "src/cell_job.hpp", "src/cell_runtime_bundle.hpp"];
const snapshot = () => inputs.map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex") }));

test("mount target probes bind host identity, exact volume reparse target and root identity without volume writes", {
  skip: process.platform !== "win32", timeout: 120000,
}, (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Mount Target "));
  t.diagnostic(`Retained read-only mount target evidence: ${output}`);
  const before = snapshot(), outcomes = [];
  fs.writeFileSync(path.join(output, "sources.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  for (const mode of ["normal", "asan", "arm64-compile"]) {
    const directory = path.join(output, mode); fs.mkdirSync(directory);
    const target = mode === "arm64-compile" ? "windows-arm64" : "windows-x64";
    const executable = compileTlsNative({ target, outputDirectory: directory, outputName: "mount-target-test.exe",
      sources: sources.map((file) => path.join(source, file)), includes: [path.join(source, "src")], asan: mode === "asan" });
    if (mode === "arm64-compile") continue;
    const run = spawnSync(executable, [path.join(directory, "data")], { encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain(target).compilerPath),
        ...(mode === "asan" ? { ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } : {}) } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 300); assert.ok(receipt.nativeDirectoryChecks >= 15);
    for (const key of ["volumeMounted", "volumeAttached", "ntfsFormatted", "rootPermissionsChanged"]) assert.equal(receipt[key], false);
    outcomes.push({ mode, ...receipt });
  }
  assert.deepEqual(snapshot(), before, "Mount target inputs changed during proof.");
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: before, outcomes,
    arm64Executed: false, boundary: "SDK response decoders plus read-only inspection of exclusively created ordinary NTFS directories. No drive attachment, partitioning, formatting, mounting or volume-root permission change. This is a mount-target inspection primitive, not a mounted workspace or execution grant." }, null, 2), { flag: "wx" });
});
