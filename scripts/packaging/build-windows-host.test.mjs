import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const scriptPath = path.join(scriptDir, "build-windows-host.mjs");
const executableName = "GoatCitadel-Mission-Control-Windows.exe";

function resolveSourceState() {
  const commit = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  assert.equal(commit.status, 0, commit.stderr);
  const status = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  return {
    sourceCommit: commit.stdout.trim().toLowerCase(),
    sourceModified: status.stdout.trim().length > 0,
  };
}

function runSkipBuild(outDir) {
  const environment = { ...process.env };
  delete environment.GITHUB_SHA;
  return spawnSync(process.execPath, [scriptPath, "--target", "windows-x64", "--out-dir", outDir, "--skip-build"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
  });
}

function withHostFixture(manifest, assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-windows-host-skip-"));
  const executablePath = path.join(root, executableName);
  const manifestPath = path.join(root, "desktop-manifest.json");
  try {
    fs.writeFileSync(executablePath, "existing-native-host", "utf8");
    if (manifest !== undefined) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
    assertion({ root, executablePath, manifestPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("skip-build preserves a host and manifest with exact source provenance", () => {
  const source = resolveSourceState();
  const manifest = {
    target: "windows-x64",
    ...source,
    createdAt: "2000-01-01T00:00:00.000Z",
    proof: "existing-build",
  };
  withHostFixture(manifest, ({ root, executablePath, manifestPath }) => {
    const executableBefore = fs.readFileSync(executablePath);
    const manifestBefore = fs.readFileSync(manifestPath);
    const result = runSkipBuild(root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Reused verified GoatCitadel Windows host/u);
    assert.deepEqual(fs.readFileSync(executablePath), executableBefore);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
  });
});

test("skip-build rejects stale or missing provenance without rewriting the host", () => {
  const source = resolveSourceState();
  const staleCommit = `${source.sourceCommit[0] === "a" ? "b" : "a"}${source.sourceCommit.slice(1)}`;
  withHostFixture(
    {
      target: "windows-x64",
      ...source,
      sourceCommit: staleCommit,
      createdAt: "2000-01-01T00:00:00.000Z",
    },
    ({ root, executablePath, manifestPath }) => {
      const executableBefore = fs.readFileSync(executablePath);
      const manifestBefore = fs.readFileSync(manifestPath);
      const result = runSkipBuild(root);

      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /does not match bundle source commit/u);
      assert.deepEqual(fs.readFileSync(executablePath), executableBefore);
      assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
    },
  );

  withHostFixture(undefined, ({ root, executablePath }) => {
    const executableBefore = fs.readFileSync(executablePath);
    const result = runSkipBuild(root);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /manifest is missing/u);
    assert.deepEqual(fs.readFileSync(executablePath), executableBefore);
  });
});
