import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { runRuntimeStreamParentFixture } from "./lib/remote-worker-runtime-stream-parent-fixture.mjs";

test("bound runtime request crosses actual local pipes without implying execution", { skip: process.platform !== "win32" }, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Transfer "));
  console.log(`Retained runtime transfer evidence: ${output}`);
  const repository = path.resolve(import.meta.dirname, "../.."), hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const parentInputs = ["apps/remote-worker/src/worker-windows-runtime-streams.ts", "apps/remote-worker/dist/worker-windows-runtime-streams.js",
    "scripts/packaging/lib/remote-worker-runtime-stream-parent-fixture.mjs"].map(name => ({ name, sha256: hash(fs.readFileSync(path.join(repository, name))) }));
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_transfer_test.cpp";
  const dispatchFixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_dispatch_test.cpp";
  const authorityFixture = "apps/remote-worker-windows-cell-native/tests/cell_controller_runtime_test.cpp";
  const parentStreamsFixture = "apps/remote-worker-windows-cell-native/tests/cell_runtime_parent_streams_test.cpp";
  const snapshot = snapshotCellControllerSources(output, [fixture, dispatchFixture, authorityFixture, parentStreamsFixture]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const service = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan });
    for (const args of [[], ["--foreground"]]) {
      const launch = spawnSync(service, args, { windowsHide: true, encoding: "utf8", timeout: 10000, env });
      assert.equal(launch.error, undefined);
      assert.equal(launch.status, args.length ? 160 : 5, `Service must refuse interactive launch: ${launch.stdout}${launch.stderr}`);
    }
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan, fixture, extraSources: [dispatchFixture, authorityFixture, parentStreamsFixture] });
    const run = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Runtime transfer evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.ok(report.checks >= 100);
    assert.equal(report.dispatchChecks, 1999);
    assert.ok(report.runtimeAuthorityChecks >= 90);
    assert.equal(report.pipeFixtures, 20);
    assert.equal(report.runtimeAuthorityPipeFixtures, 122);
    assert.equal(report.parentStreamPipeFixtures, 30); assert.ok(report.parentStreamChecks >= 80);
    assert.equal(report.largeBytes, 513935);
    assert.equal(report.installedService, false);
    assert.equal(report.volumeAttached, false);
    const parentStreams = await runRuntimeStreamParentFixture(executable, output, env, asan);
    outcomes.push({ asan, ...report, parentStreams });
  }
  for (const item of [...snapshot.sourceManifest, ...parentInputs]) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({
    sourceManifest: snapshot.sourceManifest, parentInputs, outcomes,
    boundary: "Production controller compiles and refuses interactive launch. Private local pipes transfer bound configurations and fresh authority, with thirty stream pipe fixtures and sixty-six dedicated control pipe fixtures. Control tests preserve queued runtime bytes while checking exact repeated input, delivery, revocation, replay, malformed replies, aliases, cancellation and long budgets. Actual native-to-Node stream cases exercise the production parent handler with independent controlled request/history material, binary input, separate output EOFs, input/output denial, altered receipts and cancellation. Canonical authority and consumers remain controlled. No installed listener dispatch, live Gateway admission, workload process, volume attachment, formatting or mount is exercised.",
  }, null, 2), { flag: "wx" });
});
