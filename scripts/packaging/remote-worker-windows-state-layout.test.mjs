import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("installed state layouts agree across native startup and enrollment without installation", { skip: process.platform !== "win32" }, () => {
  const repository = path.resolve(import.meta.dirname, "../..");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker State Layout "));
  console.log("Retained state-layout evidence: " + output);
  const host = "apps/remote-worker-windows-host-native";
  const names = [
    ...["installed_worker_files.cpp", "installed_worker_files.hpp", "service_identity.cpp", "service_identity.hpp", "worker_host.hpp"].map(name => host + "/src/" + name),
    host + "/tests/installed_worker_files_test.cpp",
    ...["worker-install-common.ps1", "worker-enrollment-common.ps1", "broker-coordinator-common.ps1", "worker-settings-layout.test.ps1", "worker-state-writer-gate.test.ps1", "worker-install-native.cs", "worker-controller-key.cs", "install-worker-service.ps1", "enroll-worker-service.ps1"].map(name => "scripts/remote-worker/" + name),
  ];
  const source = path.join(output, "source");
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifest = names.map(name => {
    const bytes = fs.readFileSync(path.join(repository, name));
    const destination = path.join(source, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    return { name, sha256: sha(bytes) };
  });
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const binaries = [false, true].map(asan => ({ asan, executable: compileTlsNative({
    target: "windows-x64", outputDirectory: output, outputName: asan ? "layout-asan.exe" : "layout.exe", asan,
    sources: names.filter(name => name.endsWith(".cpp")).map(name => path.join(source, name)),
    includes: [path.join(source, host, "src")],
  }) }));
  const outcomes = [];
  for (const [index, engine] of [path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), "pwsh.exe"].entries()) {
    const fixture = path.join(output, "fixture-" + index);
    const run = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-File", path.join(source, "scripts/remote-worker/worker-settings-layout.test.ps1"), "-FixtureRoot", fixture], { windowsHide: true, encoding: "utf8", timeout: 30000 });
    fs.writeFileSync(path.join(output, "settings-" + index + ".log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true); assert.equal(report.checks, 27);
    assert.equal(report.processStarted, false); assert.equal(report.installedService, false); assert.equal(report.volumeAttached, false);
    const gate = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-File", path.join(source, "scripts/remote-worker/worker-state-writer-gate.test.ps1"), "-FixtureRoot", path.join(output, "writer-gate-" + index)], { windowsHide: true, encoding: "utf8", timeout: 45000 });
    fs.writeFileSync(path.join(output, "writer-gate-" + index + ".log"), (gate.stdout ?? "") + (gate.stderr ?? ""), { flag: "wx" });
    assert.equal(gate.error, undefined); assert.equal(gate.status, 0, gate.stderr);
    const gateReport = JSON.parse(gate.stdout);
    assert.equal(gateReport.passed, true); assert.equal(gateReport.checks, 17); assert.equal(gateReport.crossProcess, true);
    assert.equal(gateReport.installedService, false); assert.equal(gateReport.volumeAttached, false);
    for (const { asan, executable } of binaries) for (const capacity of [false, true]) {
      const native = spawnSync(executable, [path.join(fixture, "settings-" + (capacity ? "True" : "False") + ".bin"), report.installRoot], {
        windowsHide: true, encoding: "utf8", timeout: 15000,
        env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
      });
      fs.writeFileSync(path.join(output, "native-" + index + "-" + asan + "-" + capacity + ".log"), (native.stdout ?? "") + (native.stderr ?? ""), { flag: "wx" });
      assert.equal(native.error, undefined); assert.equal(native.status, 0, native.stderr);
      const proof = JSON.parse(native.stdout);
      assert.equal(proof.passed, true); assert.equal(proof.installedService, false); assert.equal(proof.checks, 112);
      outcomes.push({ engine: index, asan, capacity, ...proof });
    }
  }
  for (const item of manifest) assert.equal(sha(fs.readFileSync(path.join(repository, item.name))), item.sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ manifest, outcomes, installedService: false, volumeAttached: false }, null, 2), { flag: "wx" });
});
