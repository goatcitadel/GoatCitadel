import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { encodeRemoteWorkerInstallCapacityChallenge, hashRemoteWorkerInstallCapacityCapture } from "../../packages/contracts/dist/remote-worker-install-capacity-challenge.js";

test("native and TypeScript bind installation reservation challenges to identical capture bytes", { skip: process.platform !== "win32", timeout: 240000 }, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Install Capacity Challenge "));
  t.diagnostic(`Retained installation reservation wire evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_install_capacity_challenge_test.cpp";
  const contract = "packages/contracts/src/remote-worker-install-capacity-challenge.ts";
  const snapshot = snapshotCellControllerSources(output, [fixture, contract]), outcomes = [];
  const payload = Uint8Array.from({ length: 1013 }, (_, i) => i % 251);
  const binding = { connectionNonceHex: "11".repeat(32), installationNonce: "22".repeat(32), requestSha256: "33".repeat(32),
    captureSha256: hashRemoteWorkerInstallCapacityCapture(payload), byteLength: payload.length };
  const fixturePath = path.join(output, "binding.bin");
  fs.writeFileSync(fixturePath, Buffer.concat([payload, encodeRemoteWorkerInstallCapacityChallenge(binding, 1),
    encodeRemoteWorkerInstallCapacityChallenge(binding, 65536)]), { flag: "wx" });
  for (const asan of [false, true]) {
    const directory = path.join(output, asan ? "asan" : "normal"); fs.mkdirSync(directory);
    const executable = buildWindowsCellController({ outputDirectory: directory, snapshot, asan, fixture, sourceBatchSize: 8 });
    const run = spawnSync(executable, [fixturePath], { windowsHide: true, encoding: "utf8", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain("windows-x64").compilerPath),
        ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
    fs.writeFileSync(path.join(directory, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 300);
    assert.equal(receipt.installedService, false); assert.equal(receipt.volumeOperations, false);
    outcomes.push({ asan, ...receipt });
  }
  for (const input of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.resolve(import.meta.dirname, "../..", input.name))).digest("hex"), input.sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ outcomes, sourceManifest: snapshot.sourceManifest,
    boundary: "Cross-language opaque capture hash and challenge codec only. No installed service, pipe dispatch, reservation authority or volume operation." }, null, 2), { flag: "wx" });
});
