import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const engines = [
  [
    "Windows PowerShell",
    path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ],
  ["PowerShell", "pwsh.exe"],
];
for (const [label, engine] of engines) {
  test(`worker enrollment handoff on ${label}`, { skip: process.platform !== "win32", timeout: 30000 }, () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Enrollment "));
    const run = spawnSync(
      engine,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dirname, "worker-enrollment-behavior.test.ps1"),
        "-FixtureRoot",
        output,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 25000 },
    );
    fs.writeFileSync(path.join(output, "run.log"), run.stdout + run.stderr, { flag: "wx" });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, `${output}\n${run.stdout}${run.stderr}`);
    const result = JSON.parse(fs.readFileSync(path.join(output, "acceptance.json")));
    assert.equal(result.passed, true);
    assert.equal(result.scmMutated, false);
    assert.equal(result.networkUsed, false);
    assert.ok(result.cases.length >= 18);
    const preflight = spawnSync(
      engine,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dirname, "enroll-worker-service.ps1"),
        "-Target",
        "windows-x64",
        "-ManifestSha256",
        "0".repeat(64),
        "-OutputRoot",
        path.join(output, "preflight"),
        "-Preflight",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    fs.writeFileSync(path.join(output, "preflight.log"), preflight.stdout + preflight.stderr, { flag: "wx" });
    assert.equal(preflight.error, undefined);
    assert.equal(preflight.status, 2, `${output}\n${preflight.stdout}${preflight.stderr}`);
    const evidence = JSON.parse(fs.readFileSync(path.join(output, "preflight/worker-enrollment-evidence.json")));
    assert.equal(evidence.preflight, true);
    assert.equal(evidence.admissionAttempted, false);
    assert.equal(evidence.scmMutated, false);
    assert.equal(evidence.credentialTransfer, null);
  });
}
