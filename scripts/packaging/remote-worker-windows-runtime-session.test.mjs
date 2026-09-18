import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("one runtime session owns request, authority, streams, job join and result receipt", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Session "));
  console.log(`Retained runtime session evidence: ${output}`);
  const native = "apps/remote-worker-windows-cell-native";
  const fixture = `${native}/tests/cell_runtime_session_test.cpp`;
  const dispatchFixture = `${native}/tests/cell_runtime_dispatch_test.cpp`;
  const jobSources = [`${native}/tests/job_fixture.cpp`, `${native}/tests/workspace_fixture.cpp`];
  const appContainer = `${native}/tests/appcontainer_fixture.cpp`;
  const snapshot = snapshotCellControllerSources(output, [fixture, dispatchFixture, ...jobSources, appContainer, `${native}/tests/appcontainer_fixture.hpp`]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const job = compileTlsNative({ target: "windows-x64", outputDirectory: output, outputName: "session-job-fixture.exe",
    sources: jobSources.map(name => path.join(snapshot.root, name)), includes: [path.join(snapshot.root, native, "src")] });
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan, fixture, extraSources: [dispatchFixture, appContainer] });
    const run = spawnSync(executable, [job], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Runtime session evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 70);
    assert.equal(report.pipeFixtures, 39); assert.equal(report.sessionAttempts, 39); assert.equal(report.controllerConnections, 9); assert.ok(report.actualJobs >= 22);
    assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false);
    outcomes.push({ asan, ...report });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Real private pipes, independent cancellation events and actual AppContainer jobs exercise both native session owners and nine composed controller connections. The controller establishes a second pipe bound to actual primary process/token evidence, sends input/delivery challenges, and retains endpoint custody through a controlled outer receipt/finish boundary. The actual outer settlement gate refuses missing local persistence flags. Controlled persistence callbacks verify intent-before-launch, outcome-after-join, cancellation retention and withholding remote completion on persistence failure. Secondary test ACL, journal/runtime-bundle dispatch, canonical callbacks and retention committers are controlled in job cases; the production session separately refuses an absent original journal before launch. A controlled loss of cleanup evidence after a real joined job requires controller shutdown even though terminal retention succeeded. No installed-service execution, actual mounted journal or live Gateway acceptance is claimed. No installed service or physical volume operation occurs.",
  }, null, 2), { flag: "wx" });
});

test("helper forwarding stays live through controller receipt and joins before parent finish", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Forwarding "));
  console.log(`Retained helper forwarding evidence: ${output}`);
  const native = "apps/remote-worker-windows-cell-native";
  const fixture = `${native}/tests/cell_runtime_helper_forwarding_test.cpp`;
  const dispatchFixture = `${native}/tests/cell_runtime_dispatch_test.cpp`;
  const snapshot = snapshotCellControllerSources(output, [fixture, dispatchFixture]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, sourceBatchSize: 8, asan, fixture, extraSources: [dispatchFixture] });
    const run = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 30000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Helper forwarding evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 50);
    assert.equal(report.pipePairs, 33); assert.equal(report.forwardingSessions, 11);
    assert.equal(report.installedService, false); assert.equal(report.workloadsRun, 0);
    outcomes.push({ asan, ...report });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Production helper forwarding and runtime/retention composition over four actual local pipe paths. Primary admission, controller traffic, parent permission/retention and terminal job metadata are controlled. Tests cover repeated exact input, concurrent runtime/control traffic, a post-Run delivery check, long budgets, cancellation, revocation after retention, changed replies, lost control and reentrant custody. They do not exercise installed service custody, a live Gateway, real durable result retention or any workload or disk operation." }, null, 2), { flag: "wx" });
});
