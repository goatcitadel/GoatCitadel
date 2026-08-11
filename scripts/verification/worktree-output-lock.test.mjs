import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  WORKTREE_OUTPUT_LOCK_PATH_ENV,
  WORKTREE_OUTPUT_LOCK_ROOT_ENV,
  WORKTREE_OUTPUT_LOCK_LEASE_ENV,
  acquireWorktreeOutputLock,
  worktreeOutputLockPath,
} from "../lib/worktree-output-lock.mjs";
import {
  buildExtensionsSdkDist,
  publishStagedDirectory,
  recoverInterruptedPublication,
} from "../../packages/extensions-sdk/scripts/build-dist.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";

const currentFile = fileURLToPath(import.meta.url);
const WORKER_FLAG = "--fr362-lock-worker";

if (process.argv.includes(WORKER_FLAG)) {
  await runWorker().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
} else {
  test("official raw output entrypoints use the shared boundary and staged SDK owner", async () => {
    const repoRoot = path.resolve(path.dirname(currentFile), "..", "..");
    const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const gatewayPackage = JSON.parse(
      await fs.readFile(path.join(repoRoot, "apps", "gateway", "package.json"), "utf8"),
    );
    const extensionsPackage = JSON.parse(
      await fs.readFile(path.join(repoRoot, "packages", "extensions-sdk", "package.json"), "utf8"),
    );

    for (const scriptName of ["build", "typecheck", "ts7:build", "ts7:typecheck"]) {
      assert.match(rootPackage.scripts[scriptName], /run-with-worktree-output-lock\.mjs/u, scriptName);
    }
    for (const scriptName of ["build", "typecheck", "lint"]) {
      assert.match(gatewayPackage.scripts[scriptName], /run-with-worktree-output-lock\.mjs/u, scriptName);
    }
    assert.equal(extensionsPackage.scripts.build, "node scripts/build-dist.mjs");
    assert.equal(extensionsPackage.scripts.typecheck, "node scripts/build-dist.mjs");
    assert.match(rootPackage.scripts["verify:extensions:package:raw"], /run-with-worktree-output-lock\.mjs/u);
    assert.match(rootPackage.scripts["verify:extensions:package:from-build"], /run-with-worktree-output-lock\.mjs/u);
  });

  test("verification secret scrubbing preserves the non-secret inherited lease", async () => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-scrub-"));
    const environment = {
      [WORKTREE_OUTPUT_LOCK_LEASE_ENV]: "lease-id",
      [WORKTREE_OUTPUT_LOCK_PATH_ENV]: path.join(configRoot, "lock"),
      [WORKTREE_OUTPUT_LOCK_ROOT_ENV]: configRoot,
      GOATCITADEL_PROVIDER_API_KEY: "must-scrub",
    };
    try {
      const scrubbed = await collectVerificationSecretEnvKeys(configRoot, environment);
      assert.ok(scrubbed.includes("GOATCITADEL_PROVIDER_API_KEY"));
      assert.ok(!scrubbed.includes(WORKTREE_OUTPUT_LOCK_LEASE_ENV));
      assert.ok(!scrubbed.includes(WORKTREE_OUTPUT_LOCK_PATH_ENV));
      assert.ok(!scrubbed.includes(WORKTREE_OUTPUT_LOCK_ROOT_ENV));
    } finally {
      await fs.rm(configRoot, { recursive: true, force: true });
    }
  });

  test("cross-process contenders cannot enter one worktree output boundary", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-lock-"));
    const readyPath = path.join(repoRoot, "holder-ready");
    const releasePath = path.join(repoRoot, "holder-release");
    const holder = spawnWorker(["hold", repoRoot, readyPath, releasePath]);
    try {
      await waitForPath(readyPath);
      const contender = await runWorkerProcess(["once", repoRoot, "verification:contender"]);
      assert.notEqual(contender.code, 0);
      assert.match(contender.stderr, /locked by verification:holder/u);
      assert.match(contender.stderr, /Wait for that command to finish/u);
    } finally {
      await fs.writeFile(releasePath, "release", "utf8");
      const holderResult = await collectChild(holder);
      assert.equal(holderResult.code, 0, holderResult.stderr);
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("descendant commands validate and reuse the inherited lease", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-reentrant-"));
    try {
      const result = await runWorkerProcess(["reentrant", repoRoot]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /reentrant-ok/u);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("a dead same-host owner is reclaimed without weakening a live lock", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-stale-"));
    const lockPath = worktreeOutputLockPath(repoRoot);
    const exitedChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = exitedChild.pid;
    await new Promise((resolve, reject) => {
      exitedChild.once("error", reject);
      exitedChild.once("close", resolve);
    });
    assert.ok(Number.isSafeInteger(deadPid));
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        pid: deadPid,
        hostname: os.hostname(),
        owner: "verification:dead",
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot,
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      acquireWorktreeOutputLock({ environment: {}, repoRoot, owner: "verification:too-soon" }),
      /locked by verification:dead/u,
    );
    const staleTimestamp = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, staleTimestamp, staleTimestamp);
    const environment = {};
    try {
      const lease = await acquireWorktreeOutputLock({ environment, repoRoot, owner: "verification:replacement" });
      assert.equal(lease.inherited, false);
      await lease.release();
      await assert.rejects(fs.access(lockPath));
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("extensions SDK build publishes a complete stage and preserves old dist on compiler failure", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-sdk-"));
    const packageDir = path.join(repoRoot, "packages", "extensions-sdk");
    const distPath = path.join(packageDir, "dist");
    await fs.mkdir(distPath, { recursive: true });
    await fs.writeFile(path.join(distPath, "index.js"), "old-js", "utf8");
    await fs.writeFile(path.join(distPath, "index.d.ts"), "old-types", "utf8");
    try {
      await assert.rejects(
        buildExtensionsSdkDist({
          environment: {},
          packageDir,
          repoRoot,
          async runCompiler() {
            throw new Error("injected compiler failure");
          },
        }),
        /injected compiler failure/u,
      );
      assert.equal(await fs.readFile(path.join(distPath, "index.js"), "utf8"), "old-js");

      await buildExtensionsSdkDist({
        environment: {},
        packageDir,
        repoRoot,
        async runCompiler({ projectPath }) {
          const stagedDist = path.join(path.dirname(projectPath), "next-dist");
          await fs.mkdir(stagedDist, { recursive: true });
          await fs.writeFile(path.join(stagedDist, "index.js"), "new-js", "utf8");
          await fs.writeFile(path.join(stagedDist, "index.d.ts"), "new-types", "utf8");
        },
      });
      assert.equal(await fs.readFile(path.join(distPath, "index.js"), "utf8"), "new-js");
      assert.equal(await fs.readFile(path.join(distPath, "index.d.ts"), "utf8"), "new-types");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("extensions SDK publication recovers the previous complete tree after an interrupted swap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-recover-"));
    const distPath = path.join(root, "dist");
    const previousDistPath = path.join(root, ".tmp", "dist-publication", "previous-dist");
    await fs.mkdir(previousDistPath, { recursive: true });
    await fs.writeFile(path.join(previousDistPath, "index.js"), "recoverable", "utf8");
    try {
      assert.equal(await recoverInterruptedPublication({ distPath, previousDistPath }), "restored");
      assert.equal(await fs.readFile(path.join(distPath, "index.js"), "utf8"), "recoverable");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("extensions SDK publication rolls the old tree back when promotion fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fr362-rollback-"));
    const distPath = path.join(root, "dist");
    const stagedDistPath = path.join(root, ".tmp", "next-dist");
    const previousDistPath = path.join(root, ".tmp", "previous-dist");
    await fs.mkdir(distPath, { recursive: true });
    await fs.mkdir(stagedDistPath, { recursive: true });
    await fs.writeFile(path.join(distPath, "index.js"), "old-complete", "utf8");
    await fs.writeFile(path.join(stagedDistPath, "index.js"), "new-complete", "utf8");
    try {
      await assert.rejects(
        publishStagedDirectory({
          distPath,
          stagedDistPath,
          previousDistPath,
          async rename(source, target) {
            if (source === stagedDistPath) throw new Error("injected promotion failure");
            await fs.rename(source, target);
          },
        }),
        /injected promotion failure/u,
      );
      assert.equal(await fs.readFile(path.join(distPath, "index.js"), "utf8"), "old-complete");
      assert.equal(await fs.readFile(path.join(stagedDistPath, "index.js"), "utf8"), "new-complete");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

async function runWorker() {
  const index = process.argv.indexOf(WORKER_FLAG);
  const [mode, repoRoot, ...args] = process.argv.slice(index + 1);
  if (!mode || !repoRoot) throw new Error("worker mode and repo root are required");
  if (mode === "hold") {
    const [readyPath, releasePath] = args;
    const lease = await acquireWorktreeOutputLock({ repoRoot, owner: "verification:holder" });
    try {
      await fs.writeFile(readyPath, "ready", "utf8");
      await waitForPath(releasePath, 10_000);
    } finally {
      await lease.release();
    }
    return;
  }
  if (mode === "once") {
    const lease = await acquireWorktreeOutputLock({ repoRoot, owner: args[0] ?? "verification:once" });
    await lease.release();
    process.stdout.write("acquired\n");
    return;
  }
  if (mode === "reentrant") {
    const owner = await acquireWorktreeOutputLock({ repoRoot, owner: "verification:parent" });
    try {
      const descendant = await acquireWorktreeOutputLock({ repoRoot, owner: "build:descendant" });
      assert.equal(descendant.inherited, true);
      await descendant.release();
      process.stdout.write("reentrant-ok\n");
    } finally {
      await owner.release();
    }
    return;
  }
  throw new Error(`unknown worker mode: ${mode}`);
}

function spawnWorker(args) {
  return spawn(process.execPath, [currentFile, WORKER_FLAG, ...args], {
    cwd: path.dirname(currentFile),
    env: withoutInheritedLock(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runWorkerProcess(args) {
  return await collectChild(spawnWorker(args));
}

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForPath(targetPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await fs
        .access(targetPath)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${targetPath}`);
}

function withoutInheritedLock(environment) {
  const clean = { ...environment };
  delete clean[WORKTREE_OUTPUT_LOCK_LEASE_ENV];
  delete clean[WORKTREE_OUTPUT_LOCK_PATH_ENV];
  delete clean[WORKTREE_OUTPUT_LOCK_ROOT_ENV];
  return clean;
}
