import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("installation client requires exact fresh authority and preserves workload handoff", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Install Client "));
  console.log(`Retained installation client evidence: ${output}`);
  const fixture = "apps/remote-worker-windows-cell-native/tests/cell_controller_protocol_test.cpp";
  const helpers = ["cell_virtual_disk_layout", "cell_ntfs_format", "cell_volume_protection", "cell_volume_mount", "cell_mounted_workspace"]
    .map(name => `apps/remote-worker-windows-cell-native/tests/${name}_test.cpp`);
  const clients = ["cpp", "hpp"].map(extension => `apps/remote-worker-windows-cell-native/src/cell_controller_client_protocol.${extension}`);
  const snapshot = snapshotCellControllerSources(output, [fixture, ...helpers, ...clients]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const env = { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" };
  const results = [];
  for (const asan of [false, true]) {
    const executable = buildWindowsCellController({ outputDirectory: output, snapshot, asan, fixture, sourceBatchSize: 8, extraSources: [...helpers, clients[0]] });
    for (const mode of ["installation", "runtime-handoff"]) {
      const label = `${asan ? "asan" : "normal"}-${mode}`;
      const run = spawnSync(executable, [`--${mode}`, path.join(output, `${label}-data`)], { windowsHide: true, encoding: "utf8", timeout: 300000, env });
      fs.writeFileSync(path.join(output, `${label}.log`), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
      assert.equal(run.error, undefined); assert.equal(run.status, 0, `${output}\n${run.stdout}${run.stderr}`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.passed, true); assert.ok(report.checks > 100);
      // Two workspace setup/refusal sessions, 18 peers for each operation,
      // six capture-dispatch peers, one combined-owner refusal, two recovery
      // refusals and six exclusion refusals.
      assert.equal(report.sessions, mode === "installation" ? 53 : 19);
      assert.equal(report.nativeClientSessions, mode === "installation" ? 53 : 19);
      for (const key of ["installedService", "canonicalStorage", "volumeAttached", "ntfsFormatted", "volumeRootProtected", "volumeMounted"]) assert.equal(report[key], false);
      results.push({ asan, mode, ...report });
    }
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256);
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, results,
    boundary: "Real private pipe and production client with controlled server/current-authority responses. No installed runtime copying, canonical admission, readiness publication or physical volume operations."
  }, null, 2), { flag: "wx" });
});
