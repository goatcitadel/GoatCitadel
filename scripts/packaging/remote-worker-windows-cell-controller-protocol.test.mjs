import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("controller service refuses interactive launch and protocol preserves exact checkpoints", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Controller Protocol "));
  console.log(`Retained cell controller protocol evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_controller_protocol_test.cpp";
  const layoutFixture = "apps/remote-worker-windows-cell-native/tests/cell_virtual_disk_layout_test.cpp";
  const formatFixture = "apps/remote-worker-windows-cell-native/tests/cell_ntfs_format_test.cpp";
  const protectionFixture = "apps/remote-worker-windows-cell-native/tests/cell_volume_protection_test.cpp";
  const mountFixture = "apps/remote-worker-windows-cell-native/tests/cell_volume_mount_test.cpp";
  const workspaceFixture = "apps/remote-worker-windows-cell-native/tests/cell_mounted_workspace_test.cpp";
  const clientSources = ["cpp", "hpp"].map((extension) => `apps/remote-worker-windows-cell-native/src/cell_controller_client_protocol.${extension}`);
  const snapshot = snapshotCellControllerSources(output, [fixture, layoutFixture, formatFixture, protectionFixture, mountFixture, workspaceFixture, ...clientSources]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const outcomes = [];
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  for (const asan of [false, true]) {
    const service = buildWindowsCellController({ outputDirectory: output, snapshot, asan, sourceBatchSize: 8 });
    for (const args of [[], ["--foreground"]]) {
      const launch = spawnSync(service, args, { windowsHide: true, encoding: "utf8", timeout: 10000, env });
      assert.equal(launch.error, undefined);
      assert.equal(launch.status, args.length ? 160 : 5, `Service must refuse this interactive process: ${launch.stdout}${launch.stderr}`);
    }
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture, sourceBatchSize: 8,
      extraSources: [layoutFixture, formatFixture, protectionFixture, mountFixture, workspaceFixture, ...clientSources.filter((source) => source.endsWith(".cpp"))] });
    const run = spawnSync(executable, [path.join(output, asan ? "asan-data" : "normal-data")], {
      // The full 122-session fixture flushes many independent NTFS files. Allow
      // slower temporary volumes without changing any native operation deadline.
      windowsHide: true, encoding: "utf8", timeout: 300000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Protocol evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.ok(report.checks >= 100);
    assert.equal(report.sessions, 122);
    assert.equal(report.nativeClientSessions, 109);
    assert.equal(report.creationCheckpoints, 5);
    assert.equal(report.recoveryCheckpoints, 5);
    assert.equal(report.controlledVolumeCheckpoints, 6);
    assert.equal(report.controlledFormatCheckpoints, 2);
    assert.equal(report.controlledProtectionCheckpoints, 2);
    assert.equal(report.controlledMountCheckpoints, 4);
    assert.ok(report.volumeAuthorityChecks >= 8);
    assert.ok(report.formatAuthorityChecks > report.volumeAuthorityChecks);
    assert.ok(report.protectionAuthorityChecks > report.formatAuthorityChecks);
    assert.ok(report.mountAuthorityChecks > report.protectionAuthorityChecks);
    assert.ok(report.mountAuthorityChecks <= 256);
    assert.equal(report.installedService, false);
    assert.equal(report.canonicalStorage, false);
    assert.equal(report.volumeAttached, false);
    assert.equal(report.ntfsFormatted, false);
    assert.equal(report.volumeRootProtected, false);
    assert.equal(report.volumeMounted, false);
    // The 27-session group flushes separate durable checkpoint fixtures. ASAN
    // measured 39.84s on Windows, so allow aggregate fixture overhead while
    // preserving every native per-operation/authority deadline.
    const workspaceRun = spawnSync(executable, ["--mounted-workspace", path.join(output, asan ? "asan-workspace-data" : "normal-workspace-data")], {
      windowsHide: true, encoding: "utf8", timeout: 60000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan-workspace.log" : "normal-workspace.log"), (workspaceRun.stdout ?? "") + (workspaceRun.stderr ?? ""), { flag: "wx" });
    assert.equal(workspaceRun.error, undefined);
    assert.equal(workspaceRun.status, 0, `Workspace protocol evidence: ${output}\n${workspaceRun.stdout}${workspaceRun.stderr}`);
    const workspaceReport = JSON.parse(workspaceRun.stdout);
    assert.equal(workspaceReport.passed, true); assert.ok(workspaceReport.checks >= 100);
    assert.equal(workspaceReport.sessions, 27); assert.equal(workspaceReport.nativeClientSessions, 23);
    assert.equal(workspaceReport.controlledMountedWorkspaceCheckpoints, 2);
    assert.ok(workspaceReport.mountedWorkspaceAuthorityChecks > report.mountAuthorityChecks);
    assert.ok(workspaceReport.mountedWorkspaceAuthorityChecks <= 256);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(workspaceReport[key], false);
    const capacityRun = spawnSync(executable, ["--capacity", path.join(output, asan ? "asan-capacity-data" : "normal-capacity-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan-capacity.log" : "normal-capacity.log"), (capacityRun.stdout ?? "") + (capacityRun.stderr ?? ""), { flag: "wx" });
    assert.equal(capacityRun.error, undefined);
    assert.equal(capacityRun.status, 0, `Capacity protocol evidence: ${output}\n${capacityRun.stdout}${capacityRun.stderr}`);
    const capacityReport = JSON.parse(capacityRun.stdout);
    assert.equal(capacityReport.passed, true); assert.ok(capacityReport.checks >= 100);
    assert.equal(capacityReport.sessions, 33); assert.equal(capacityReport.nativeClientSessions, 33);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(capacityReport[key], false);
    const backingRun = spawnSync(executable, ["--backing-capacity", path.join(output, asan ? "asan-backing-capacity-data" : "normal-backing-capacity-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan-backing-capacity.log" : "normal-backing-capacity.log"), (backingRun.stdout ?? "") + (backingRun.stderr ?? ""), { flag: "wx" });
    assert.equal(backingRun.error, undefined);
    assert.equal(backingRun.status, 0, `Host capacity protocol evidence: ${output}\n${backingRun.stdout}${backingRun.stderr}`);
    const backingCapacityReport = JSON.parse(backingRun.stdout);
    assert.equal(backingCapacityReport.passed, true); assert.ok(backingCapacityReport.checks >= 100);
    assert.equal(backingCapacityReport.sessions, 29); assert.equal(backingCapacityReport.nativeClientSessions, 29);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(backingCapacityReport[key], false);
    const inventoryRun = spawnSync(executable, ["--inventory", path.join(output, asan ? "asan-inventory-data" : "normal-inventory-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan-inventory.log" : "normal-inventory.log"), (inventoryRun.stdout ?? "") + (inventoryRun.stderr ?? ""), { flag: "wx" });
    assert.equal(inventoryRun.error, undefined);
    assert.equal(inventoryRun.status, 0, `Inventory protocol evidence: ${output}\n${inventoryRun.stdout}${inventoryRun.stderr}`);
    const inventoryReport = JSON.parse(inventoryRun.stdout);
    assert.equal(inventoryReport.passed, true); assert.ok(inventoryReport.checks >= 100);
    assert.equal(inventoryReport.sessions, 50); assert.equal(inventoryReport.nativeClientSessions, 50);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(inventoryReport[key], false);
    const runtimeRun = spawnSync(executable, ["--runtime-handoff", path.join(output, asan ? "asan-runtime-data" : "normal-runtime-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan-runtime.log" : "normal-runtime.log"), (runtimeRun.stdout ?? "") + (runtimeRun.stderr ?? ""), { flag: "wx" });
    assert.equal(runtimeRun.error, undefined);
    assert.equal(runtimeRun.status, 0, `Runtime handoff evidence: ${output}\n${runtimeRun.stdout}${runtimeRun.stderr}`);
    const runtimeReport = JSON.parse(runtimeRun.stdout);
    assert.equal(runtimeReport.passed, true); assert.ok(runtimeReport.checks >= 100);
    assert.equal(runtimeReport.sessions, 19); assert.equal(runtimeReport.nativeClientSessions, 19);
    for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"])
      assert.equal(runtimeReport[key], false);
    outcomes.push({ asan, ...report, workspaceReport, capacityReport, backingCapacityReport, inventoryReport, runtimeReport });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({
    sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Compiled production service with interactive refusal; actual protocol/journal creation and legacy recovery under a current-user fixture with OS pipe identity and flushed acknowledgements. Volume/format/protection/mount/workspace composition uses controlled physical-driver responses. Capacity uses independently retained native history, a controlled observation peer and the production client; the actual controller refuses missing quiescence ownership before filesystem access. Runtime handoff uses the production client with controlled server/runtime callbacks; the actual controller separately refuses absent owners and the unmounted fixture journal before runtime dispatch. No SCM install/start, real installed custody, privileged volume operation, actual mounted runtime, live capacity scan through the controller or canonical Gateway storage.",
  }, null, 2), { flag: "wx" });
});
