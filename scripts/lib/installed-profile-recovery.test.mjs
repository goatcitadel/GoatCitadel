import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopCredentialResource, installedProfileRecovery, readDesktopProfileId } from "./installed-profile-recovery.mjs";
import { inspectLocalProfileStorage } from "./installed-profile-windows.mjs";

function fixture(t) {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-profile-test-"));
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  const active = path.join(install, "runtime-root");
  const recoveryRoot = path.join(install, "profile-recovery");
  const backups = path.join(recoveryRoot, "backups");
  fs.mkdirSync(active);
  return { install, active, recoveryRoot, backups, recovery: installedProfileRecovery(install) };
}

function write(root, relative, data) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

test("reset archives the whole local profile and restore saves the comparison profile", (t) => {
  const { active, recovery, backups } = fixture(t);
  const state = {
    "config/goatcitadel.json": '{"testOnly":true}',
    "data/index.db": "example data",
    "skills/example/SKILL.md": "example skill",
    "workspaces/default/file.txt": "example file",
    ".env": "GOAT_FIXTURE=example",
  };
  for (const [relative, content] of Object.entries(state)) write(active, relative, content);

  assert.deepEqual(recovery.list(), { limit: 3, backups: [] });
  const original = recovery.switchProfile(null);
  assert.deepEqual(fs.readdirSync(active), [".desktop-profile-id"]);
  const comparisonScope = readDesktopProfileId(active);
  write(active, "data/index.db", "comparison data");
  const comparison = recovery.switchProfile(original);
  assert.deepEqual(recovery.list().backups.map(({ id, reason }) => [id, reason]), [[comparison, "restore"]]);
  assert.equal(fs.existsSync(path.join(backups, original, "profile")), false);
  assert.equal(readDesktopProfileId(active), undefined);
  for (const [relative, content] of Object.entries(state)) {
    assert.equal(fs.readFileSync(path.join(active, relative), "utf8"), content);
  }
  recovery.switchProfile(comparison);
  assert.equal(readDesktopProfileId(active), comparisonScope);
  assert.equal(fs.readFileSync(path.join(active, "data", "index.db"), "utf8"), "comparison data");
});

test("only three restore points survive and expired scoped browser data and sign-ins can be retired", (t) => {
  const { active, install, recovery, recoveryRoot, backups } = fixture(t);
  const retired = [];
  const ids = [];
  const legacy = recovery.switchProfile(null);
  const expiredScope = readDesktopProfileId(active);
  const browser = path.join(recoveryRoot, "browser", expiredScope);
  write(browser, "test.txt", "browser state");
  for (let index = 0; index < 4; index += 1) {
    ids.push(recovery.switchProfile(null));
    recovery.prune((resource) => retired.push(resource));
  }
  assert.deepEqual(recovery.list().backups.map(({ id }) => id), ids.slice(-3).reverse());
  assert.deepEqual(fs.readdirSync(backups).sort(), ids.slice(-3).sort());
  assert.equal(fs.existsSync(browser), false);
  assert.deepEqual(retired, [desktopCredentialResource(install, expiredScope)]);
  assert.throws(() => recovery.switchProfile(legacy), /backup is no longer available/u);
});

test("recovery finishes an interrupted directory switch before startup can seed the active folder", (t) => {
  const { active, recovery, recoveryRoot, backups } = fixture(t);
  const outgoing = randomUUID();
  const freshId = randomUUID();
  const prepared = path.join(backups, outgoing);
  write(active, "data/example.txt", "saved state");
  write(prepared, "receipt.json", JSON.stringify({ version: 1, createdAt: new Date().toISOString(), reason: "reset", sequence: 1 }));
  write(prepared, "fresh/.desktop-profile-id", freshId);
  write(recoveryRoot, "pending.json", JSON.stringify({ version: 1, outgoing, selected: null }));
  fs.renameSync(active, path.join(prepared, "profile"));

  assert.equal(recovery.recoverIfInterrupted(), true);
  assert.equal(readDesktopProfileId(active), freshId);
  assert.equal(fs.readFileSync(path.join(prepared, "profile", "data", "example.txt"), "utf8"), "saved state");
  assert.equal(recovery.recoverIfInterrupted(), undefined);
});

test("a failed activation restores the old profile at its original path", (t) => {
  const { active, recovery, recoveryRoot } = fixture(t);
  write(active, "data/example.txt", "keep me");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.basename(from) === "fresh") throw new Error("injected switch failure");
    rename(from, to);
  });
  assert.throws(() => recovery.switchProfile(null), /injected switch failure/u);
  assert.equal(fs.readFileSync(path.join(active, "data", "example.txt"), "utf8"), "keep me");
  assert.equal(fs.existsSync(path.join(recoveryRoot, "pending.json")), false);
  assert.equal(recovery.list().backups.length, 0);
});

test("database preflight requires the active database storage to be local", (t) => {
  const { install, active } = fixture(t);
  const outside = path.join(install, "unrelated");
  assert.throws(() => inspectLocalProfileStorage(active, active, { GOATCITADEL_POSTGRES_MODE: "external" }), /external PostgreSQL/u);
  assert.throws(() => inspectLocalProfileStorage(active, active, { GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR: outside }), /inside this install/u);
  assert.deepEqual(inspectLocalProfileStorage(active, active, {}), [path.join(active, "data", "postgres")]);
});

test("SQLite preflight rejects external data paths and linked database files", (t) => {
  const { install, active } = fixture(t);
  const config = "config/assistant.config.json";
  const database = { driver: "sqlite" };
  write(active, config, JSON.stringify({ database, dataDir: "../unrelated" }));
  assert.throws(() => inspectLocalProfileStorage(active, active, {}), /SQLite storage inside this install/u);
  assert.throws(() => inspectLocalProfileStorage(active, active, { GOATCITADEL_DATABASE_DRIVER: "typo" }), /SQLite storage inside this install/u);

  write(active, config, JSON.stringify({ database, dataDir: "sqlite-store" }));
  write(active, "sqlite-store/index.db", "fixture");
  assert.doesNotThrow(() => inspectLocalProfileStorage(active, active, {}));
  fs.linkSync(path.join(active, "sqlite-store/index.db"), path.join(install, "linked-database.db"));
  assert.throws(() => inspectLocalProfileStorage(active, active, {}), /regular SQLite files/u);
});

test("SQLite preflight rejects a junction to data outside the selected backup", (t) => {
  const { install, active } = fixture(t);
  const stored = path.join(install, "selected-backup");
  const outside = path.join(install, "unrelated");
  write(outside, "index.db", "external database");
  write(stored, "config/goatcitadel.json", JSON.stringify({ assistant: { dataDir: "sqlite-store" } }));
  write(stored, ".env", "GOATCITADEL_DATABASE_DRIVER=sqlite\n");
  try {
    fs.symlinkSync(outside, path.join(stored, "sqlite-store"), "junction");
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    t.skip("This environment cannot create a junction.");
    return;
  }
  assert.throws(() => inspectLocalProfileStorage(active, stored, {}), /regular folders/u);
});

test("a junction cannot redirect the backup folder", (t) => {
  const { install, recoveryRoot, recovery } = fixture(t);
  const outside = path.join(install, "unrelated");
  write(outside, "marker", "outside profile");
  try {
    fs.symlinkSync(outside, recoveryRoot, "junction");
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    t.skip("This environment cannot create a junction.");
    return;
  }
  assert.throws(() => recovery.switchProfile(null), /regular folders/u);
  assert.equal(fs.readFileSync(path.join(outside, "marker"), "utf8"), "outside profile");
});
