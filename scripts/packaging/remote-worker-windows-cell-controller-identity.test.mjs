import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("dedicated cell controller identity and custody reject substitute authority", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Controller Identity "));
  console.log(`Retained cell controller identity evidence: ${output}`);
  const repository = path.resolve(import.meta.dirname, "../..");
  const cell = "apps/remote-worker-windows-cell-native";
  const host = "apps/remote-worker-windows-host-native";
  const sourceNames = [
    ...["cell_controller_identity", "cell_filesystem", "cell_workspace", "cell_security"].flatMap((name) =>
      ["cpp", "hpp"].map((extension) => `${cell}/src/${name}.${extension}`)),
    ...["cell_runtime_bundle", "cell_job", "cell_job_stdio", "cell_capacity"].map((name) => `${cell}/src/${name}.hpp`),
    `${cell}/tests/cell_controller_identity_test.cpp`,
    `${host}/src/service_identity.cpp`, `${host}/src/service_identity.hpp`, `${host}/src/worker_host.hpp`,
    ...["worker-install-native.cs", "worker-controller-key.cs", "worker-install-common.ps1", "broker-coordinator-common.ps1", "worker-capacity-custody.test.ps1"]
      .map(name => `scripts/remote-worker/${name}`),
  ];
  const snapshot = path.join(output, "source");
  const sourceManifest = sourceNames.map((name) => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const destination = path.join(snapshot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const serviceName = "GoatCitadelRemoteWorkerCellController";
  const digest = createHash("sha1").update(Buffer.from(serviceName.toUpperCase(), "utf16le")).digest();
  const serviceSid = `S-1-5-80-${Array.from({ length: 5 }, (_, index) => digest.readUInt32LE(index * 4)).join("-")}`;
  const header = fs.readFileSync(path.join(snapshot, cell, "src/cell_controller_identity.hpp"), "utf8");
  assert.ok(header.includes(`L"${serviceSid}"`), "The service SID must match its independently derived name.");
  const showSid = spawnSync(path.join(process.env.SystemRoot, "System32/sc.exe"), ["showsid", serviceName], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(showSid.error, undefined);
  assert.equal(showSid.status, 0, showSid.stderr);
  assert.ok(showSid.stdout.includes(serviceSid), "Windows must independently derive the same service SID without installation.");
  fs.writeFileSync(path.join(output, "service-sid.log"), showSid.stdout + showSid.stderr, { flag: "wx" });
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const outcomes = [];
  const capacityRecords = [];
  for (const [index, engine] of [path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), "pwsh.exe"].entries()) {
    const fixture = path.join(output, `capacity-roots-${index}`);
    const encoded = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-File",
      path.join(snapshot, "scripts/remote-worker/worker-capacity-custody.test.ps1"), "-FixtureRoot", fixture],
    { windowsHide: true, encoding: "utf8", timeout: 30000 });
    fs.writeFileSync(path.join(output, `capacity-encoder-${index}.log`), `${encoded.stdout ?? ""}${encoded.stderr ?? ""}`, { flag: "wx" });
    assert.equal(encoded.error, undefined); assert.equal(encoded.status, 0, encoded.stderr);
    const report = JSON.parse(encoded.stdout);
    assert.equal(report.passed, true); assert.equal(report.checks, 52);
    assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false);
    capacityRecords.push(path.join(fixture, "capacity.identity"));
  }
  for (const asan of [false, true]) {
    const executable = compileTlsNative({
      target: "windows-x64", outputDirectory: output,
      outputName: asan ? "controller-identity-asan.exe" : "controller-identity.exe",
      sources: sourceNames.filter((name) => name.endsWith(".cpp")).map((name) => path.join(snapshot, name)),
      includes: [path.join(snapshot, cell, "src"), path.join(snapshot, host, "src")], asan,
    });
    const run = spawnSync(executable, [], {
      windowsHide: true, encoding: "utf8", timeout: 15000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
    });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "release.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Native identity evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.ok(report.checks >= 240, "Token/configuration/custody cases and actual OS refusal must run.");
    assert.equal(report.actualInteractiveTokenRefused, true);
    assert.equal(report.privilegesUnchanged, true);
    assert.equal(report.installedService, false);
    assert.equal(report.volumeAttached, false);
    outcomes.push({ asan, ...report });
    for (const [index, record] of capacityRecords.entries()) {
      const paired = spawnSync(executable, [record], { windowsHide: true, encoding: "utf8", timeout: 15000,
        env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
      fs.writeFileSync(path.join(output, `capacity-paired-${asan ? "asan" : "normal"}-${index}.log`),
        `${paired.stdout ?? ""}${paired.stderr ?? ""}`, { flag: "wx" });
      assert.equal(paired.error, undefined); assert.equal(paired.status, 0, paired.stderr);
      const pairedReport = JSON.parse(paired.stdout);
      assert.equal(pairedReport.passed, true); assert.ok(pairedReport.checks > report.checks);
      assert.equal(pairedReport.installedService, false); assert.equal(pairedReport.volumeAttached, false);
    }
  }
  for (const item of sourceManifest) {
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
      `Source changed during proof: ${item.name}`);
  }
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({
    sourceManifest, serviceName, serviceSid, outcomes,
    boundary: "Read-only identity/custody policy and actual interactive-token refusal; no controller service installation, positive installed custody, IPC, privilege change, volume attachment or backend readiness.",
  }, null, 2), { flag: "wx" });
});
