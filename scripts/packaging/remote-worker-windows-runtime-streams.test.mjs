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

test("runtime stream frames preserve bounded duplex native job input and output", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Streams "));
  console.log(`Retained runtime stream evidence: ${output}`);
  const native = "apps/remote-worker-windows-cell-native";
  const fixture = `${native}/tests/cell_runtime_streams_test.cpp`;
  const jobSources = [`${native}/tests/job_fixture.cpp`, `${native}/tests/workspace_fixture.cpp`];
  const appContainer = `${native}/tests/appcontainer_fixture.cpp`;
  const snapshot = snapshotCellControllerSources(output, [fixture, ...jobSources, appContainer, `${native}/tests/appcontainer_fixture.hpp`]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const job = compileTlsNative({ target: "windows-x64", outputDirectory: output, outputName: "stream-job-fixture.exe",
    sources: jobSources.map(name => path.join(snapshot.root, name)), includes: [path.join(snapshot.root, native, "src")] });
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture, extraSources: [appContainer] });
    const run = spawnSync(executable, [job], { windowsHide: true, encoding: "utf8", timeout: 40000, env });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Runtime stream evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.ok(report.checks >= 100);
    assert.equal(report.pipeFixtures, 13); assert.equal(report.actualJobs, 4); assert.equal(report.jobAttempts, 7); assert.equal(report.inputBytes, 73728);
    assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false);
    outcomes.push({ asan, ...report });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Actual private local pipes and task-owned AppContainer jobs multiplex 73728 binary input bytes, both output streams and fresh runtime approval through a serialized I/O owner. After both EOFs and job join, terminal delivery carries actual native job metadata on the same pipe. Canonical runtime/input/result admission callbacks and the journal side are controlled; no inventory is claimed here. Denial before resume, while awaiting input, malformed or unsolicited approval, reentrant input, expired input admission and frozen caller tables are exercised. Native channel backpressure and exact ACKs are also checked separately. Full journal-backed dispatch, durable Gateway result retention, the installed listener and live Gateway admission are not exercised. No installed service or volume operation is performed.",
  }, null, 2), { flag: "wx" });
});
