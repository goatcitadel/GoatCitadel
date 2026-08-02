import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureConfigJsonSnapshots, findBackupConfigSnapshotDrift } from "./backup-snapshot-stability.mjs";

async function createFixture(t) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-snapshot-"));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const configDir = path.join(runtimeRoot, "config");
  const payloadRoot = path.join(runtimeRoot, "backup", "payload");
  await fs.mkdir(path.join(configDir, "generations"), { recursive: true });
  await fs.mkdir(path.join(payloadRoot, "config", "generations"), { recursive: true });
  await fs.writeFile(path.join(configDir, "root.json"), '{"root":true}\n');
  await fs.writeFile(path.join(configDir, "generations", "receipt.json"), '{"generation":1}\n');
  await fs.cp(configDir, path.join(payloadRoot, "config"), { recursive: true, force: true });
  return { runtimeRoot, configDir, payloadRoot };
}

test("config snapshot pairing accepts the exact recursive path set and bytes", async (t) => {
  const fixture = await createFixture(t);
  const snapshots = await captureConfigJsonSnapshots(fixture.configDir, fixture.runtimeRoot);

  assert.deepEqual(
    snapshots.map((item) => item.relativePath),
    ["config/generations/receipt.json", "config/root.json"],
  );
  assert.deepEqual(await findBackupConfigSnapshotDrift(snapshots, fixture.payloadRoot), []);
});

test("config snapshot pairing reports changed, missing, and unexpected paths without content", async (t) => {
  const fixture = await createFixture(t);
  const snapshots = await captureConfigJsonSnapshots(fixture.configDir, fixture.runtimeRoot);
  const backupConfigDir = path.join(fixture.payloadRoot, "config");
  await fs.writeFile(path.join(backupConfigDir, "root.json"), '{"root":false}\n');
  await fs.rm(path.join(backupConfigDir, "generations", "receipt.json"));
  await fs.writeFile(path.join(backupConfigDir, "unexpected.json"), '{"secret":"not-reported"}\n');

  assert.deepEqual(await findBackupConfigSnapshotDrift(snapshots, fixture.payloadRoot), [
    "changed:config/root.json",
    "missing:config/generations/receipt.json",
    "unexpected:config/unexpected.json",
  ]);
});

test("config snapshot pairing treats a missing backup config tree as missing expected paths", async (t) => {
  const fixture = await createFixture(t);
  const snapshots = await captureConfigJsonSnapshots(fixture.configDir, fixture.runtimeRoot);
  await fs.rm(path.join(fixture.payloadRoot, "config"), { recursive: true });

  assert.deepEqual(await findBackupConfigSnapshotDrift(snapshots, fixture.payloadRoot), [
    "missing:config/generations/receipt.json",
    "missing:config/root.json",
  ]);
});
