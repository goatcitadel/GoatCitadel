import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireWorktreeOutputLock, WORKTREE_OUTPUT_LOCK_LEASE_ENV, WORKTREE_OUTPUT_LOCK_PATH_ENV, WORKTREE_OUTPUT_LOCK_ROOT_ENV } from "../../lib/worktree-output-lock.mjs";
import { buildVerificationBuildEnv, buildVerificationProcessEnv } from "./runtime.mjs";
import { buildVerificationCommandEnv } from "./shared.mjs";
import { prepareBackupRoundtripFixture } from "./scenarios/backup-roundtrip-fixture.mjs";

test("scrubbed fixture build child inherits its live parent lease while Gateway/restart/restore remain isolated", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-build-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GOAT_PRIVATE: "synthetic", OPENAI_API_KEY: "synthetic", VITE_GATEWAY_URL: "synthetic" };
  for (const key of [WORKTREE_OUTPUT_LOCK_LEASE_ENV, WORKTREE_OUTPUT_LOCK_PATH_ENV, WORKTREE_OUTPUT_LOCK_ROOT_ENV]) delete env[key];
  const lease = await acquireWorktreeOutputLock({ repoRoot: root, environment: env, owner: "unit-parent" });
  t.after(() => lease.release());
  const fixture = await prepareBackupRoundtripFixture("lease-unit", "http://127.0.0.1:1/v1", { env, tempParent: root });
  const buildEnv = await buildVerificationBuildEnv(env, {}, fixture.gatewayEnvOmit, root);
  for (const key of [WORKTREE_OUTPUT_LOCK_LEASE_ENV, WORKTREE_OUTPUT_LOCK_PATH_ENV, WORKTREE_OUTPUT_LOCK_ROOT_ENV]) assert.equal(buildEnv[key], env[key]);
  for (const key of ["GOAT_PRIVATE", "OPENAI_API_KEY", "VITE_GATEWAY_URL"]) assert.equal(buildEnv[key], undefined);
  const ownerUrl = new URL("../../lib/worktree-output-lock.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireWorktreeOutputLock } from ${JSON.stringify(ownerUrl)}; const lease = await acquireWorktreeOutputLock({ repoRoot: process.cwd() }); if (!lease.inherited) throw new Error('Child did not inherit'); await lease.release();`], { cwd: root, env: buildEnv, encoding: "utf8" });
  assert.equal(child.status, 0, "Actual child must validate and reuse the parent lease");
  for (const builder of [buildVerificationProcessEnv, buildVerificationProcessEnv, buildVerificationCommandEnv]) {
    const runtimeEnv = builder(env, fixture.gatewayEnv, fixture.gatewayEnvOmit);
    for (const key of [WORKTREE_OUTPUT_LOCK_LEASE_ENV, WORKTREE_OUTPUT_LOCK_PATH_ENV, WORKTREE_OUTPUT_LOCK_ROOT_ENV, "GOAT_PRIVATE", "OPENAI_API_KEY", "VITE_GATEWAY_URL"]) assert.equal(runtimeEnv[key], undefined);
    for (const key of ["HOME", "USERPROFILE", "GOATCITADEL_HOME", "GOATCITADEL_ROOT_DIR", "GOATCITADEL_BACKUP_DIR", "GOATCITADEL_LOCAL_ENV_FILE", "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT", "GOATCITADEL_CODE_MODE_TEMP_ROOT"]) assert(runtimeEnv[key].startsWith(fixture.runtimeRoot));
  }
  await assert.rejects(buildVerificationBuildEnv(env, {}, fixture.gatewayEnvOmit, path.join(root, "another-worktree")), /different worktree/u);
  await assert.rejects(buildVerificationBuildEnv({ ...env, [WORKTREE_OUTPUT_LOCK_LEASE_ENV]: "invalid" }, {}, fixture.gatewayEnvOmit, root), /no longer valid/u);
  const partial = { ...env }; delete partial[WORKTREE_OUTPUT_LOCK_LEASE_ENV];
  await assert.rejects(buildVerificationBuildEnv(partial, {}, fixture.gatewayEnvOmit, root), /incomplete/u);
  const noLease = { ...partial }; delete noLease[WORKTREE_OUTPUT_LOCK_PATH_ENV]; delete noLease[WORKTREE_OUTPUT_LOCK_ROOT_ENV];
  const extraInjection = await buildVerificationBuildEnv(noLease, { [WORKTREE_OUTPUT_LOCK_LEASE_ENV]: "invalid" }, fixture.gatewayEnvOmit, root);
  assert.equal(extraInjection[WORKTREE_OUTPUT_LOCK_LEASE_ENV], undefined);
  // Identity-valid but dead-owner metadata still fails closed (no lease token is printed).
  const original = await fs.readFile(lease.lockPath, "utf8"), metadata = JSON.parse(original);
  await fs.writeFile(lease.lockPath, JSON.stringify({ ...metadata, pid: 2147483647 }));
  try { await assert.rejects(buildVerificationBuildEnv(env, {}, fixture.gatewayEnvOmit, root), /no longer valid/u); }
  finally { await fs.writeFile(lease.lockPath, original); }
});
