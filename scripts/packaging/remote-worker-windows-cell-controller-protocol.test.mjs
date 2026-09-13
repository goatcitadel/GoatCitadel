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
    const service = buildWindowsCellController({ outputDirectory: output, snapshot, asan });
    for (const args of [[], ["--foreground"]]) {
      const launch = spawnSync(service, args, { windowsHide: true, encoding: "utf8", timeout: 10000, env });
      assert.equal(launch.error, undefined);
      assert.equal(launch.status, args.length ? 160 : 5, `Service must refuse this interactive process: ${launch.stdout}${launch.stderr}`);
    }
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture,
      extraSources: [layoutFixture, formatFixture, protectionFixture, mountFixture, workspaceFixture, ...clientSources.filter((source) => source.endsWith(".cpp"))] });
    const run = spawnSync(executable, [path.join(output, asan ? "asan-data" : "normal-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
    });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "normal.log"), (run.stdout ?? "") + (run.stderr ?? ""), { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Protocol evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.ok(report.checks >= 100);
    assert.equal(report.sessions, 121);
    assert.equal(report.nativeClientSessions, 108);
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
    // Separate invocation preserves the existing per-process watchdog for both groups.
    const workspaceRun = spawnSync(executable, ["--mounted-workspace", path.join(output, asan ? "asan-workspace-data" : "normal-workspace-data")], {
      windowsHide: true, encoding: "utf8", timeout: 40000, env,
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
    outcomes.push({ asan, ...report, workspaceReport });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({
    sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Compiled production service with interactive refusal; actual protocol/journal creation and legacy recovery under a current-user fixture with OS pipe identity and flushed acknowledgements. Volume/format/protection/mount/workspace composition uses controlled attachment/layout/NTFS/root-security/fixed-folder/directory driver responses; production client recovery is checked separately against exact recorded frames and real recovery refuses the unattached fixture. No SCM install/start, real installed custody, privileged volume operation or canonical Gateway storage.",
  }, null, 2), { flag: "wx" });
});
