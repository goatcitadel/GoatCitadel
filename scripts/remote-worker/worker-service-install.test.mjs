import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "../packaging/build-remote-worker-windows-tls.mjs";
import { snapshotCellControllerSources, buildWindowsCellController } from "../packaging/build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "../packaging/lib/remote-worker-windows-toolchain.mjs";
import { inventoryWorkerPackage, workerPackageSha256, verifyRemoteWorkerWindowsPackage } from "../packaging/lib/remote-worker-package-files.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const nativeRoot = path.join(repository, "apps/remote-worker-windows-host-native");
const names = [
  "bin/GoatCitadelRemoteWorkerHost.exe",
  "bin/worker.ps1",
  "app/runtime/node.exe",
  "app/worker/dist/main.js",
  "app/worker/dist/index.js",
  "app/install/install-worker-service.ps1",
  "app/install/uninstall-worker-service.ps1",
  "app/install/enroll-worker-service.ps1",
  "app/install/worker-enrollment-common.ps1",
  "app/install/worker-install-common.ps1",
  "app/install/worker-install-native.cs",
  "app/install/configure-worker-mesh-registry.ps1",
  "app/install/worker-mesh-registry-common.ps1",
  "app/install/broker-coordinator-common.ps1",
  "app/install/install-broker-coordinator.ps1",
  "app/install/uninstall-broker-coordinator.ps1",
  "app/pnpm-lock.yaml",
  "app/worker/native/GoatCitadelRemoteWorkerImageGuard.node",
  "app/worker/native/GoatCitadelRemoteWorkerTlsKey.dll",
  "app/worker/native/GoatCitadelRemoteWorkerFiles.exe",
  "app/worker/native/GoatCitadelRemoteWorkerStdio.exe",
  "app/worker/native/GoatCitadelRemoteWorkerCellProvisioning.exe",
  "app/worker/native/GoatCitadelRemoteWorkerCellController.exe",
  "app/provisioner/GoatCitadelRemoteWorkerProvisioner.exe",
  "app/provisioner/GoatCitadelRemoteWorkerProvisionerClient.exe",
  "app/provisioner/GoatCitadelRemoteWorkerProvisionerAvailability.exe",
];
function packageFixture(directory, omit) {
  fs.mkdirSync(directory);
  const root = path.join(directory, "payload");
  for (const name of names) {
    if (name === omit) continue;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), `fixture:${name}`, { flag: "wx" });
  }
  const hash = (name) => workerPackageSha256(fs.readFileSync(path.join(root, name)));
  const receipt = {
    schemaVersion: "goatcitadel.remote-worker.windows-host.v3",
    target: "windows-x64",
    serviceName: "GoatCitadelRemoteWorker",
    serviceIdentity: {
      account: "NT SERVICE\\GoatCitadelRemoteWorker",
      sid: "S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905",
      configuration: "configuration/worker.environment",
    },
    artifact: { sha256: hash("bin/GoatCitadelRemoteWorkerHost.exe") },
    nodeSha256: hash("app/runtime/node.exe"),
    entrypointSha256: hash("app/worker/dist/main.js"),
  };
  fs.writeFileSync(path.join(root, "app/runtime/worker-host-receipt.json"), JSON.stringify(receipt), { flag: "wx" });
  const manifest = {
    schemaVersion: "goatcitadel.remote-worker-windows-package.v3",
    target: "windows-x64",
    nodeVersion: "24.19.0",
    opensslVersion: "3.5.7",
    entrypoint: "app/worker/dist/main.js",
    nodeExecutable: "app/runtime/node.exe",
    hostExecutable: "bin/GoatCitadelRemoteWorkerHost.exe",
    files: inventoryWorkerPackage(root),
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "worker-package.json"), bytes, { flag: "wx" });
  const result = { root, sha256: workerPackageSha256(bytes) };
  fs.writeFileSync(path.join(directory, "fixture-pin.json"), JSON.stringify(result), { flag: "wx" });
  return result;
}
test(
  "worker installer file operations and native configuration agree on Windows",
  { skip: process.platform !== "win32", timeout: 180000 },
  () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Install "));
    const compile = path.join(output, "native");
    fs.mkdirSync(compile);
    const toolchain = resolveExactWindowsToolchain("windows-x64");
    const custodyFixture = "apps/remote-worker-windows-cell-native/tests/cell_controller_custody_install_test.cpp";
    const custodySnapshot = snapshotCellControllerSources(compile, [custodyFixture]);
    const custodyBinaries = [false, true].map((asan) => buildWindowsCellController({
      outputDirectory: compile, snapshot: custodySnapshot, asan, fixture: custodyFixture,
    }));
    const binaries = [false, true].map((asan) =>
      compileTlsNative({
        target: "windows-x64",
        outputDirectory: compile,
        outputName: asan ? "installed-asan.exe" : "installed.exe",
        asan,
        sources: [
          "src/installed_worker_files.cpp",
          "src/service_identity.cpp",
          "tests/installed_worker_files_test.cpp",
        ].map((name) => path.join(nativeRoot, name)),
        includes: [path.join(nativeRoot, "src")],
      }),
    );
    const engines = [path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), "pwsh.exe"];
    const outcomes = [];
    for (const [index, engine] of engines.entries()) {
      const fixture = path.join(output, `package-${index}`);
      const complete = packageFixture(fixture);
      assert.ok(verifyRemoteWorkerWindowsPackage({ root: complete.root, expectedManifestSha256: complete.sha256 }));
      const missingHelpers = names.filter((name) => name.startsWith("app/worker/native/")).map((relative, missingIndex) => {
        const helper = path.posix.basename(relative);
        const missing = packageFixture(path.join(output, `missing-helper-${index}-${missingIndex}`), relative);
        assert.throws(() => verifyRemoteWorkerWindowsPackage({ root: missing.root, expectedManifestSha256: missing.sha256 }), /required runtime component/u);
        return { helper, ...missing };
      });
      fs.writeFileSync(path.join(fixture, "missing-helper-fixtures.json"), JSON.stringify({ cases: missingHelpers }), { flag: "wx" });
      const temporary = path.join(output, `files-${index}`);
      const result = spawnSync(
        engine,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(repository, "scripts/remote-worker/worker-install-behavior.test.ps1"),
          "-FixtureRoot",
          temporary,
          "-PackageFixture",
          fixture,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30000 },
      );
      fs.writeFileSync(path.join(output, `powershell-${index}.log`), result.stdout + result.stderr, { flag: "wx" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${output}\n${result.stdout}${result.stderr}`);
      const behavior = JSON.parse(fs.readFileSync(path.join(temporary, "acceptance.json")));
      assert.equal(behavior.scmMutated, false);
      for (const missing of missingHelpers) assert.ok(behavior.cases.includes(`required-native-helper-${missing.helper}`));
      const custody = custodyBinaries.map((binary) => {
        const run = spawnSync(binary, [behavior.custodyFile, behavior.nativeDirectory, behavior.cellsDirectory, behavior.parentSddlFile], {
          windowsHide: true, encoding: "utf8", timeout: 10000,
          env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
        });
        assert.equal(run.error, undefined);
        assert.equal(run.status, 0, `${output}\n${run.stdout}${run.stderr}`);
        return JSON.parse(run.stdout);
      });
      const native = binaries.map((binary) => {
        const run = spawnSync(binary, [behavior.settingsFile, behavior.installRoot], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 10000,
          env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath) },
        });
        assert.equal(run.error, undefined);
        assert.equal(run.status, 0, `${output}\n${run.stdout}${run.stderr}`);
        return JSON.parse(run.stdout);
      });
      const preflightFixture = path.join(output, `preflight-package-${index}`);
      const candidate = packageFixture(preflightFixture);
      const certificate = path.join(preflightFixture, "fixture-certificate.pem");
      const ticket = path.join(preflightFixture, "fixture-ticket.json");
      const reference = path.join(preflightFixture, "fixture-reference.json");
      fs.writeFileSync(
        certificate,
        "-----BEGIN CERTIFICATE-----\nfixture-no-network-use\n-----END CERTIFICATE-----\n",
        { flag: "wx" },
      );
      fs.writeFileSync(ticket, JSON.stringify({ protectedSignerPublicKeySpkiBase64Url: "synthetic-fixture" }), {
        flag: "wx",
      });
      fs.writeFileSync(reference, JSON.stringify({ syntheticFixture: true }), { flag: "wx" });
      const evidence = path.join(output, `preflight-evidence-${index}`);
      const preflight = spawnSync(
        engine,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(repository, "scripts/remote-worker/install-worker-service.ps1"),
          "-Preflight",
          "-Target",
          "windows-x64",
          "-PackageRoot",
          candidate.root,
          "-ManifestSha256",
          candidate.sha256,
          "-GatewayHost",
          "127.0.0.1",
          "-GatewayPort",
          "8787",
          "-ClientCertificateFile",
          certificate,
          "-TrustAnchorFile",
          certificate,
          "-TicketFile",
          ticket,
          "-ProtectedKeyFile",
          reference,
          "-OutputRoot",
          evidence,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 30000 },
      );
      fs.writeFileSync(path.join(output, `preflight-${index}.log`), preflight.stdout + preflight.stderr, {
        flag: "wx",
      });
      assert.equal(preflight.error, undefined);
      assert.ok([0, 2].includes(preflight.status), `${output}\n${preflight.stdout}${preflight.stderr}`);
      const preflightReport = JSON.parse(fs.readFileSync(path.join(evidence, "worker-install-evidence.json")));
      assert.equal(preflightReport.createdService, false);
      assert.equal(preflightReport.createdController, false);
      assert.equal(preflightReport.createdCells, false);
      assert.equal(preflightReport.controllerStarted, false);
      assert.equal(preflightReport.serviceStarted, false);
      assert.equal(preflightReport.inputContentsInEvidence, false);
      assert.equal(preflightReport.cleanupFailures.length, 0);
      assert.ok(
        ["", "Preflight passed; no installation was performed."].includes(preflightReport.detail),
        `${output}\n${preflight.stdout}`,
      );
      const uninstallEvidence = path.join(output, `uninstall-preflight-evidence-${index}`);
      const uninstall = spawnSync(
        engine,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(repository, "scripts/remote-worker/uninstall-worker-service.ps1"),
          "-Preflight",
          "-Target",
          "windows-x64",
          "-ManifestSha256",
          candidate.sha256,
          "-OutputRoot",
          uninstallEvidence,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 30000 },
      );
      fs.writeFileSync(path.join(output, `uninstall-preflight-${index}.log`), uninstall.stdout + uninstall.stderr, {
        flag: "wx",
      });
      assert.equal(uninstall.error, undefined);
      assert.ok([0, 2].includes(uninstall.status), `${output}\n${uninstall.stdout}${uninstall.stderr}`);
      const uninstallReport = JSON.parse(
        fs.readFileSync(path.join(uninstallEvidence, "worker-uninstall-evidence.json")),
      );
      assert.equal(uninstallReport.preflight, true);
      assert.equal(uninstallReport.removedService, false);
      assert.equal(uninstallReport.removedController, false);
      assert.equal(uninstallReport.cellsRetained, true);
      assert.equal(uninstallReport.removedFiles, 0);
      assert.equal(uninstallReport.processesStopped, false);
      assert.equal(uninstallReport.configurationRetained, true);
      assert.equal(uninstallReport.stateRetained, true);
      assert.equal(uninstallReport.verdict, uninstall.status === 0 ? "passed" : "refused");
      const meshEvidence = path.join(output, `mesh-preflight-evidence-${index}`);
      const meshPreflight = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        path.join(repository, "scripts/remote-worker/configure-worker-mesh-registry.ps1"), "-Preflight", "-Disable",
        "-Target", "windows-x64", "-ManifestSha256", candidate.sha256, "-ExpectedCurrent", "none", "-OutputRoot", meshEvidence],
      { windowsHide: true, encoding: "utf8", timeout: 30000 });
      fs.writeFileSync(path.join(output, `mesh-preflight-${index}.log`), meshPreflight.stdout + meshPreflight.stderr, { flag: "wx" });
      assert.equal(meshPreflight.error, undefined);
      assert.ok([0, 2].includes(meshPreflight.status), `${output}\n${meshPreflight.stdout}${meshPreflight.stderr}`);
      const meshReport = JSON.parse(fs.readFileSync(path.join(meshEvidence, "worker-mesh-registry-evidence.json")));
      assert.equal(meshReport.preflight, true);
      assert.equal(meshReport.result, null);
      assert.equal(meshReport.serviceStarted, false);
      assert.equal(meshReport.destinationPermissionsChanged, false);
      assert.equal(meshReport.inputContentsInEvidence, false);
      outcomes.push({ behavior, native, custody, preflight: preflightReport, uninstallPreflight: uninstallReport, meshPreflight: meshReport });
    }
    fs.writeFileSync(
      path.join(output, "acceptance.json"),
      JSON.stringify({ outcomes, installedService: false }, null, 2),
      { flag: "wx" },
    );
    console.log(`Retained worker installation evidence: ${output}`);
  },
);
