import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("cell controller pipe binds actual caller identity and drains bounded I/O", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Controller Transport "));
  console.log(`Retained cell controller transport evidence: ${output}`);
  const repository = path.resolve(import.meta.dirname, "../..");
  const cell = "apps/remote-worker-windows-cell-native";
  const host = "apps/remote-worker-windows-host-native";
  const names = [
    ...["cell_controller_transport", "cell_controller_identity", "cell_filesystem", "cell_workspace", "cell_security"].flatMap((name) =>
      ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`)),
    ...["cell_runtime_bundle", "cell_job", "cell_job_stdio"].map((name) => `${cell}/src/${name}.hpp`),
    `${cell}/tests/cell_controller_transport_test.cpp`,
    `${host}/src/service_identity.cpp`, `${host}/src/service_identity.hpp`, `${host}/src/worker_host.hpp`,
  ];
  const snapshot = path.join(output, "source");
  const sourceManifest = names.map((name) => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const destination = path.join(snapshot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = compileTlsNative({
      target: "windows-x64", outputDirectory: output,
      outputName: asan ? "controller-transport-asan.exe" : "controller-transport.exe",
      sources: names.filter((name) => name.endsWith(".cpp")).map((name) => path.join(snapshot, name)),
      includes: [path.join(snapshot, cell, "src"), path.join(snapshot, host, "src")], asan,
    });
    const run = spawnSync(executable, [], {
      windowsHide: true, encoding: "utf8", timeout: 40000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
    });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "release.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Native transport evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.ok(report.checks >= 120, "Identity, descriptor, actual process exchanges and bounded-I/O cases must run.");
    assert.equal(report.pipeFixtures, 7);
    assert.equal(report.clientProcesses, 6);
    assert.equal(report.actualPipeIdentityVerified, true);
    assert.equal(report.privilegesUnchanged, true);
    assert.equal(report.installedService, false);
    assert.equal(report.workerServiceAdmitted, false);
    outcomes.push({ asan, ...report });
  }
  for (const item of sourceManifest) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({
    sourceManifest, outcomes,
    boundary: "Actual task-owned local pipes, separate client processes and OS identity, plus refusal/timeout/cancellation. No installed worker/controller service, positive installed admission, operation protocol, privileged effect or backend readiness.",
  }, null, 2), { flag: "wx" });
});
