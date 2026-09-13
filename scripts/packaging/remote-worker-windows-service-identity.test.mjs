import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";

test("worker service identity rejects broader accounts and authority", { skip: process.platform !== "win32" }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Identity "));
  const root = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-host-native");
  const sources = ["src/service_identity.cpp", "tests/service_identity_test.cpp"];
  const sourceManifest = [...sources, "src/service_identity.hpp", "src/worker_host.hpp"].map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, name)))
      .digest("hex"),
  }));
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const outcomes = [];
  for (const asan of [false, true]) {
    const executable = compileTlsNative({
      target: "windows-x64",
      outputDirectory: output,
      outputName: asan ? "identity-asan.exe" : "identity.exe",
      sources: sources.map((name) => path.join(root, name)),
      includes: [path.join(root, "src")],
      asan,
    });
    const run = spawnSync(executable, [], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath) },
    });
    fs.writeFileSync(path.join(output, asan ? "asan.log" : "release.log"), run.stdout + run.stderr, { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `Native identity evidence: ${output}\n${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.installedService, false);
    outcomes.push({ asan, ...report });
  }
  fs.writeFileSync(
    path.join(output, "acceptance.json"),
    JSON.stringify(
      {
        sourceManifest,
        outcomes,
        boundary: "Policy projections and actual interactive-token refusal; no SCM mutation.",
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(`Retained worker identity evidence: ${output}`);
});
