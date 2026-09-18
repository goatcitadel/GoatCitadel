import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("installation capture and copy retain one live reservation window", { skip: process.platform !== "win32", timeout: 240000 }, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Install Capacity Owner "));
  t.diagnostic(`Retained controlled installation-capacity owner evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_install_capacity_test.cpp";
  const snapshot = snapshotCellControllerSources(output, [fixture]), outcomes = [];
  for (const asan of [false, true]) {
    const directory = path.join(output, asan ? "asan" : "normal"); fs.mkdirSync(directory);
    const executable = buildWindowsCellController({ outputDirectory: directory, snapshot, asan, fixture, sourceBatchSize: 8 });
    const run = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain("windows-x64").compilerPath),
        ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 90);
    assert.equal(receipt.installedService, false); assert.equal(receipt.volumeOperations, false);
    outcomes.push({ asan, ...receipt });
  }
  for (const input of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.resolve(import.meta.dirname, "../..", input.name))).digest("hex"), input.sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ outcomes, sourceManifest: snapshot.sourceManifest,
    boundary: "Controlled collector, admission reservation and copy callbacks. No installed service, real copying, physical pool scan or volume operation." }, null, 2), { flag: "wx" });
});
