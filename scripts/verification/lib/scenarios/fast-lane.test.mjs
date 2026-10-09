import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  prepareFastLaneCommandTempRoot,
  removeFastLaneCommandTempRoot,
  resolveFastLaneCommandEnv,
  resolveFastLaneCommandOmitEnv,
  resolveFastLaneCommandTempRoot,
} from "./fast-lane.mjs";

const createdRoots = [];

async function createTestRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-fast-lane-temp-"));
  createdRoots.push(root);
  return root;
}

after(async () => {
  for (const root of createdRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("fast lane command scratch roots", () => {
  it("derives a distinct root per command beneath the configured temp root", async () => {
    const configured = await createTestRoot();
    const previous = process.env.GOATCITADEL_VERIFY_TEMP_ROOT;
    process.env.GOATCITADEL_VERIFY_TEMP_ROOT = configured;
    try {
      const context = { runId: "2026-07-31T00-00-00-000Z-fast-abcdef12", artifactRoot: configured };
      const storage = await resolveFastLaneCommandTempRoot(context, { id: "fast.test.storage" });
      const shard = await resolveFastLaneCommandTempRoot(context, { id: "fast.test.gateway.shard1" });

      assert.notEqual(storage, shard);
      for (const root of [storage, shard]) {
        assert.equal(path.dirname(root), path.join(configured, context.runId));
      }
    } finally {
      if (previous === undefined) delete process.env.GOATCITADEL_VERIFY_TEMP_ROOT;
      else process.env.GOATCITADEL_VERIFY_TEMP_ROOT = previous;
    }
  });

  it("clears residue from an earlier run before handing the root to a command", async () => {
    const base = await createTestRoot();
    const commandTempRoot = path.join(base, "fast.test.storage");
    await fs.mkdir(path.join(commandTempRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(commandTempRoot, "goatcitadel-leftover.db"), "stale");
    await fs.writeFile(path.join(commandTempRoot, "nested", "gc-quarantine.db"), "stale");

    const preparedRoot = await prepareFastLaneCommandTempRoot(commandTempRoot);
    const env = await resolveFastLaneCommandEnv({ runId: "run" }, { id: "fast.test.storage" }, preparedRoot);

    assert.deepEqual(await fs.readdir(preparedRoot), ["npm-cache"]);
    assert.equal(env.TEMP, preparedRoot);
    assert.equal(env.TMP, preparedRoot);
    assert.equal(env.TMPDIR, preparedRoot);
    assert.equal(env.NPM_CONFIG_CACHE, path.join(preparedRoot, "npm-cache"));
  });

  it("uses a fresh sibling when a locked stale root cannot be removed", async () => {
    const base = await createTestRoot();
    const preferredRoot = path.join(base, "fast.test.storage");
    await fs.mkdir(preferredRoot, { recursive: true });
    await fs.writeFile(path.join(preferredRoot, "goatcitadel-stale.db"), "stale");

    const preparedRoot = await prepareFastLaneCommandTempRoot(preferredRoot, {
      removeRoot: async () => false,
    });
    const env = await resolveFastLaneCommandEnv({ runId: "run" }, { id: "fast.test.storage" }, preparedRoot);

    assert.notEqual(preparedRoot, preferredRoot);
    assert.equal(path.dirname(preparedRoot), base);
    assert.match(path.basename(preparedRoot), /^fast\.test\.storage-fresh-/u);
    assert.equal(await fs.readFile(path.join(preferredRoot, "goatcitadel-stale.db"), "utf8"), "stale");
    assert.deepEqual(await fs.readdir(preparedRoot), ["npm-cache"]);
    assert.equal(env.TEMP, preparedRoot);
  });

  it("removes a populated scratch root and reports success", async () => {
    const base = await createTestRoot();
    const commandTempRoot = path.join(base, "fast.test.storage");
    await fs.mkdir(path.join(commandTempRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(commandTempRoot, "nested", "goatcitadel-agent-catalog.db"), "scratch");

    assert.equal(await removeFastLaneCommandTempRoot(commandTempRoot), true);
    await assert.rejects(() => fs.stat(commandTempRoot), { code: "ENOENT" });
  });

  it("treats an absent scratch root as already removed", async () => {
    const base = await createTestRoot();
    assert.equal(await removeFastLaneCommandTempRoot(path.join(base, "never-created")), true);
  });

  it("reports a failed removal instead of throwing so a locked handle cannot fail the command", async () => {
    const base = await createTestRoot();
    const locked = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    const removed = await removeFastLaneCommandTempRoot(path.join(base, "fast.test.storage"), {
      rm: async () => {
        throw locked;
      },
    });

    assert.equal(removed, false);
  });
});

describe("fast smoke isolation", () => {
  it("gives smoke a fresh empty runtime root with every GoatCitadel path pinned inside it", async () => {
    const preparedRoot = await prepareFastLaneCommandTempRoot(path.join(await createTestRoot(), "fast.smoke"));
    const env = await resolveFastLaneCommandEnv({ runId: "run" }, { id: "fast.smoke" }, preparedRoot);

    const runtimeRoot = env.GOATCITADEL_ROOT_DIR;
    assert.equal(path.dirname(runtimeRoot), preparedRoot);
    // Nothing is copied from the checkout: no config, skills or workspaces.
    assert.deepEqual(await fs.readdir(runtimeRoot), []);
    for (const key of [
      "GOATCITADEL_HOME",
      "GOATCITADEL_LOCAL_ENV_FILE",
      "GOATCITADEL_BACKUP_DIR",
      "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT",
      "GOATCITADEL_CODE_MODE_TEMP_ROOT",
    ]) {
      assert.ok(env[key]?.startsWith(runtimeRoot), key);
    }
    assert.equal(env.GOATCITADEL_DATABASE_DRIVER, "sqlite");
    assert.equal(env.GOATCITADEL_DISABLE_SECRET_STORE, "true");
  });

  it("omits every inherited GoatCitadel setting from smoke only", () => {
    const inherited = { GOATCITADEL_EXAMPLE_INHERITED: "operator", VITE_GOATCITADEL_EXAMPLE: "operator", PATH: "kept" };
    const omitted = resolveFastLaneCommandOmitEnv({ id: "fast.smoke" }, inherited);
    assert.ok(omitted.includes("GOATCITADEL_EXAMPLE_INHERITED"));
    assert.ok(omitted.includes("VITE_GOATCITADEL_EXAMPLE"));
    assert.ok(omitted.includes("GOATCITADEL_PROMPT_PACK_PATH"));
    assert.ok(!omitted.includes("PATH"));
    assert.deepEqual(resolveFastLaneCommandOmitEnv({ id: "fast.test.storage" }, inherited), []);
  });
});
