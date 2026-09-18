import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { snapshotCellControllerSources, buildWindowsCellController } from "./build-remote-worker-windows-cell-controller.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("runtime installation rechecks authority and retains revoked partial copies", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Runtime Install Authority "));
  const fixtureSource = "apps/remote-worker-windows-cell-native/tests/cell_runtime_install_authority_test.cpp";
  const snapshot = snapshotCellControllerSources(root, [fixtureSource]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  for (const asan of [false, true]) {
    const fixture = buildWindowsCellController({ outputDirectory: root, snapshot, asan, fixture: fixtureSource, sourceBatchSize: 8 });
    const scratch = path.join(root, asan ? "asan" : "normal");
    fs.mkdirSync(path.join(scratch, "source"), { recursive: true });
    const bytes = Buffer.alloc(6 * 65536, 0x41);
    fs.writeFileSync(path.join(scratch, "source", "entry.bin"), bytes, { flag: "wx" });
    const run = spawnSync(fixture, [scratch, createHash("sha256").update(bytes).digest("hex")], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
    });
    fs.writeFileSync(path.join(scratch, "run.log"), run.stdout + run.stderr, { flag: "wx" });
    assert.equal(run.error, undefined, root);
    assert.equal(run.status, 0, `${root}\n${run.stdout}${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.passed, true);
    assert.ok(result.authorityChecks > 6);
    assert.equal(result.volumeOperations, false);
    assert.equal(result.serviceInstalled, false);
  }
});
