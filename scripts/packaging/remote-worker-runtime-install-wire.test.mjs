import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { encodeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256 } from "../../packages/contracts/dist/remote-worker-runtime-install.js";

test("native installation decoder matches the independent contracts binding", { skip: process.platform !== "win32", timeout: 240000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Install Wire "));
  console.log(`Retained runtime installation wire evidence: ${root}`);
  const fixtureSource = "apps/remote-worker-windows-cell-native/tests/cell_runtime_install_wire_test.cpp";
  const snapshot = snapshotCellControllerSources(root, [fixtureSource]);
  const value = { schemaVersion: "goatcitadel.worker-runtime-install.v1", nonce: "11".repeat(32), journalIdentityHex: "22".repeat(24),
    preparedSha256: "33".repeat(32), checkpointSha256: "44".repeat(32), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: "goatcitadel.worker-runtime-bundle.v1", files: [
      { relativePath: "node.exe", bytes: 123456, sha256: "66".repeat(32) },
      { relativePath: "worker-host-receipt.json", bytes: 789, sha256: "77".repeat(32) },
    ] },
  };
  const input = path.join(root, "request.bin");
  fs.writeFileSync(input, Buffer.concat([Buffer.from(value.nonce, "hex"), Buffer.from(remoteWorkerRuntimeInstallRequestSha256(value), "hex"), encodeRemoteWorkerRuntimeInstallRequest(value)]), { flag: "wx" });
  fs.writeFileSync(path.join(root, "sources.json"), JSON.stringify(snapshot.sourceManifest), { flag: "wx" });
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  for (const asan of [false, true]) {
    const fixture = buildWindowsCellController({ outputDirectory: root, snapshot, asan, fixture: fixtureSource, sourceBatchSize: 8 });
    const run = spawnSync(fixture, [input], { encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
    });
    fs.writeFileSync(path.join(root, `${asan ? "asan" : "normal"}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${root}\n${run.stdout}${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.passed, true); assert.ok(result.checks > 570);
    assert.equal(result.volumeOperations, false); assert.equal(result.serviceInstalled, false);
  }
});
