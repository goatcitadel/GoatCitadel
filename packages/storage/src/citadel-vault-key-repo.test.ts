import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConflictError, ValidationError, type SealedValueV2 } from "@goatcitadel/contracts";
import { CitadelRepository } from "./citadel-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();
after(() => tempDbs.cleanup());

const wrapped = { iv: "synthetic-iv", ciphertext: "synthetic-wrapped", tag: "synthetic-tag" };
const legacy = { iv: "synthetic-iv", ciphertext: "synthetic-legacy", tag: "synthetic-tag" };
const bound = (keyId: string, marker: string): SealedValueV2 => ({
  v: 2,
  keyId,
  iv: "synthetic-iv",
  ciphertext: `synthetic-${marker}`,
  tag: "synthetic-tag",
});
const reason = (expected: string) => (error: unknown) =>
  error instanceof ConflictError && error.details?.reason === expected;

function setup(prefix: string) {
  const db = tempDbs.open({ dbPath: tempDbs.path(prefix) });
  const repo = new CitadelRepository(db);
  const keys = repo.vaultKeys;
  keys.ensureKeyState("c1", 1);
  return { db, repo, keys };
}

function seedLegacy(repo: CitadelRepository, name: string) {
  return repo.storeVaultSecret({ citadelId: "c1", secretName: name, sealedValue: legacy });
}

function addKey(keys: CitadelRepository["vaultKeys"], keyId: string, dekVersion = 1, chamberId: string | null = null) {
  return keys.insertActiveKey({ citadelId: "c1", chamberId, keyId, dekVersion, kekVersion: 1, wrappedDek: wrapped });
}

function sealedJson(db: ReturnType<TempSqliteFiles["open"]>, secretId: string): string {
  return db
    .prepare("SELECT sealed_value_json FROM citadel_vault_secrets WHERE secret_id = @secretId")
    .get<{ sealed_value_json: string }>({ secretId })!.sealed_value_json;
}

test("applyResealBatch upgrades a legacy row and reports it read back as bound", () => {
  const { db, repo, keys } = setup("gc-vault-keys-upgrade");
  const secret = seedLegacy(repo, "API");
  addKey(keys, "k1");
  const [row] = keys.readSealedRows("c1", { legacyOnly: true, limit: 10 });
  assert.equal(row?.secretId, secret.secretId);
  const result = keys.applyResealBatch("c1", [
    {
      secretId: secret.secretId,
      expectSealedJson: row!.sealedValueJson,
      expectKeyId: null,
      next: bound("k1", "upgraded"),
    },
  ]);
  assert.deepEqual(result, { applied: 1, skipped: 0 });
  const stored = repo.getVaultSecret("c1", secret.secretId)!;
  assert.equal(stored.envelopeVersion, 2);
  assert.equal(stored.keyId, "k1");
  assert.equal(stored.updatedAt, secret.updatedAt);
  assert.equal(keys.readSealedRows("c1", { legacyOnly: true, limit: 10 }).length, 0);
  assert.match(sealedJson(db, secret.secretId), /synthetic-upgraded/);
});

test("batch skips a row changed after it was read", () => {
  const { db, repo, keys } = setup("gc-vault-keys-skip");
  const secret = seedLegacy(repo, "API");
  addKey(keys, "k1");
  const [row] = keys.readSealedRows("c1", { legacyOnly: true, limit: 10 });
  repo.storeVaultSecret({
    citadelId: "c1",
    secretName: "API",
    sealedValue: { ...legacy, ciphertext: "synthetic-operator" },
  });
  const result = keys.applyResealBatch("c1", [
    {
      secretId: secret.secretId,
      expectSealedJson: row!.sealedValueJson,
      expectKeyId: null,
      next: bound("k1", "stale"),
    },
  ]);
  assert.deepEqual(result, { applied: 0, skipped: 1 });
  assert.match(sealedJson(db, secret.secretId), /synthetic-operator/);
});

test("applyResealBatch refuses a key from another scope or Citadel", () => {
  const { repo, keys } = setup("gc-vault-keys-scope");
  const secret = seedLegacy(repo, "API");
  addKey(keys, "k-chamber", 1, "ch1");
  const [row] = keys.readSealedRows("c1", { legacyOnly: true, limit: 10 });
  assert.throws(
    () =>
      keys.applyResealBatch("c1", [
        {
          secretId: secret.secretId,
          expectSealedJson: row!.sealedValueJson,
          expectKeyId: null,
          next: bound("k-chamber", "x"),
        },
      ]),
    reason("VAULT_KEY_CHANGED"),
  );
  assert.throws(
    () =>
      keys.applyResealBatch("c1", [
        {
          secretId: secret.secretId,
          expectSealedJson: row!.sealedValueJson,
          expectKeyId: null,
          next: bound("missing", "x"),
        },
      ]),
    reason("VAULT_KEY_CHANGED"),
  );
});

test("insertActiveKey refuses a second active key for a scope", () => {
  const { keys } = setup("gc-vault-keys-active");
  addKey(keys, "k1");
  assert.throws(() => addKey(keys, "k2", 2), reason("VAULT_KEY_CHANGED"));
  assert.equal(keys.getActiveKey("c1", null)?.keyId, "k1");
  addKey(keys, "k3", 1, "ch1");
  assert.equal(keys.getActiveKey("c1", "ch1")?.keyId, "k3");
});

test("closeLegacyReads is a no-op while a v1 row remains", () => {
  const { repo, keys } = setup("gc-vault-keys-close");
  const secret = seedLegacy(repo, "API");
  assert.equal(keys.closeLegacyReads("c1"), false);
  assert.equal(keys.getKeyState("c1")?.legacyReadsClosed, false);
  addKey(keys, "k1");
  const [row] = keys.readSealedRows("c1", { legacyOnly: true, limit: 10 });
  keys.applyResealBatch("c1", [
    { secretId: secret.secretId, expectSealedJson: row!.sealedValueJson, expectKeyId: null, next: bound("k1", "u") },
  ]);
  assert.equal(keys.closeLegacyReads("c1"), true);
  assert.equal(keys.getKeyState("c1")?.legacyReadsClosed, true);
});

test("createRotation rejects a second open rotation and advanceRotation rejects a stale phase", () => {
  const { keys } = setup("gc-vault-keys-ledger");
  addKey(keys, "k1");
  const rotation = keys.createRotation({
    citadelId: "c1",
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  assert.equal(rotation.phase, "awaiting_approval");
  assert.throws(
    () =>
      keys.createRotation({
        citadelId: "c1",
        target: "kek",
        chamberId: null,
        requestedBy: "operator",
        reason: "again",
      }),
    reason("VAULT_ROTATION_IN_PROGRESS"),
  );
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved", approvalId: "ap1" });
  assert.throws(
    () => keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "cancelled" }),
    reason("VAULT_ROTATION_PHASE_CHANGED"),
  );
  const cancelled = keys.advanceRotation(rotation.rotationId, "approved", { phase: "cancelled" });
  assert.ok(cancelled.completedAt);
  assert.equal(keys.getOpenRotation("c1"), undefined);
  keys.createRotation({ citadelId: "c1", target: "kek", chamberId: null, requestedBy: "operator", reason: "next" });
});

test("DEK rotation moves rows and finishDekRotation refuses while any row names the old key", () => {
  const { repo, keys } = setup("gc-vault-keys-dek");
  addKey(keys, "k1");
  const stored = repo.mutateVault({
    citadelId: "c1",
    expectedRevision: repo.getVaultSnapshot("c1").revision,
    change: { type: "store_bound", secretId: "s1", secretName: "API", chamberId: null, sealedValue: bound("k1", "v1") },
  });
  const rotation = keys.createRotation({
    citadelId: "c1",
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved" });
  const resealing = keys.startDekRotation(rotation.rotationId, {
    keyId: "k2",
    dekVersion: 2,
    kekVersion: 1,
    wrappedDek: wrapped,
  });
  assert.deepEqual([resealing.phase, resealing.totalCount], ["resealing", 1]);
  assert.equal(keys.getActiveKey("c1", null)?.keyId, "k2");
  assert.equal(keys.finishDekRotation(rotation.rotationId), false);
  const [row] = keys.readSealedRows("c1", { keyId: "k1", limit: 10 });
  keys.applyResealBatch("c1", [
    { secretId: "s1", expectSealedJson: row!.sealedValueJson, expectKeyId: "k1", next: bound("k2", "v2") },
  ]);
  assert.equal(keys.finishDekRotation(rotation.rotationId), true);
  assert.equal(keys.getKey("c1", "k1"), undefined, "the old data key is shredded");
  assert.equal(keys.getRotation("c1", rotation.rotationId)?.phase, "completed");
  assert.notEqual(repo.getVaultSnapshot("c1").revision, stored.revision);
});

test("rewrapAll updates every key and the KEK version atomically", () => {
  const { keys } = setup("gc-vault-keys-rewrap");
  addKey(keys, "k1");
  addKey(keys, "k2", 1, "ch1");
  const rotation = keys.createRotation({
    citadelId: "c1",
    target: "kek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved" });
  keys.advanceRotation(rotation.rotationId, "approved", { phase: "kek_staged", fromKekVersion: 1, toKekVersion: 2 });
  const rewrapped = { ...wrapped, ciphertext: "synthetic-rewrapped" };
  assert.throws(
    () => keys.rewrapAll(rotation.rotationId, [{ keyId: "k1", wrappedDek: rewrapped }]),
    reason("VAULT_KEY_CHANGED"),
    "every key must be rewrapped together",
  );
  assert.equal(keys.getKeyState("c1")?.kekVersion, 1);
  assert.deepEqual(
    keys.listKeys("c1").map((key) => key.kekVersion),
    [1, 1],
  );
  keys.rewrapAll(rotation.rotationId, [
    { keyId: "k1", wrappedDek: rewrapped },
    { keyId: "k2", wrappedDek: rewrapped },
  ]);
  assert.equal(keys.getKeyState("c1")?.kekVersion, 2);
  assert.deepEqual(
    keys.listKeys("c1").map((key) => [key.kekVersion, key.wrappedDek.ciphertext]),
    [
      [2, "synthetic-rewrapped"],
      [2, "synthetic-rewrapped"],
    ],
  );
  assert.equal(keys.getRotation("c1", rotation.rotationId)?.phase, "rewrapped");
});

test("hasSealedData sees key rows and secret rows", () => {
  const { repo, keys } = setup("gc-vault-keys-sealed");
  assert.equal(keys.hasSealedData("c1"), false);
  seedLegacy(repo, "API");
  assert.equal(keys.hasSealedData("c1"), true);
  assert.equal(keys.hasSealedData("c2"), false);
  keys.ensureKeyState("c2", 1);
  keys.insertActiveKey({
    citadelId: "c2",
    chamberId: null,
    keyId: "k9",
    dekVersion: 1,
    kekVersion: 1,
    wrappedDek: wrapped,
  });
  assert.equal(keys.hasSealedData("c2"), true);
});

test("data key creation must carry the current KEK version", () => {
  const { keys } = setup("gc-vault-keys-kek-cas");
  assert.throws(
    () =>
      keys.insertActiveKey({
        citadelId: "c1",
        chamberId: null,
        keyId: "k-stale",
        dekVersion: 1,
        kekVersion: 2,
        wrappedDek: wrapped,
      }),
    reason("VAULT_KEY_CHANGED"),
  );
  assert.throws(
    () =>
      keys.insertActiveKey({
        citadelId: "c-no-state",
        chamberId: null,
        keyId: "k-orphan",
        dekVersion: 1,
        kekVersion: 1,
        wrappedDek: wrapped,
      }),
    reason("VAULT_KEY_CHANGED"),
    "a data key needs recorded key state first",
  );
  addKey(keys, "k1");
  const rotation = keys.createRotation({
    citadelId: "c1",
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved" });
  assert.throws(
    () =>
      keys.startDekRotation(rotation.rotationId, { keyId: "k2", dekVersion: 2, kekVersion: 2, wrappedDek: wrapped }),
    reason("VAULT_KEY_CHANGED"),
  );
  assert.equal(keys.getActiveKey("c1", null)?.keyId, "k1");
});

test("a rotation needs a key to rotate", () => {
  const { keys } = setup("gc-vault-keys-nothing");
  assert.throws(
    () =>
      keys.createRotation({
        citadelId: "c1",
        target: "dek",
        chamberId: null,
        requestedBy: "operator",
        reason: "scheduled",
      }),
    reason("VAULT_NO_KEY_TO_ROTATE"),
  );
  assert.throws(
    () =>
      keys.createRotation({
        citadelId: "c-no-state",
        target: "kek",
        chamberId: null,
        requestedBy: "operator",
        reason: "scheduled",
      }),
    reason("VAULT_NO_KEY_TO_ROTATE"),
  );
  addKey(keys, "k1");
  keys.createRotation({
    citadelId: "c1",
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
});

test("a rotation cannot fail or cancel once key material changed", () => {
  const { keys } = setup("gc-vault-keys-no-terminal");
  addKey(keys, "k1");
  const rotation = keys.createRotation({
    citadelId: "c1",
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved" });
  keys.startDekRotation(rotation.rotationId, { keyId: "k2", dekVersion: 2, kekVersion: 1, wrappedDek: wrapped });
  for (const phase of ["failed", "cancelled"] as const) {
    assert.throws(() => keys.advanceRotation(rotation.rotationId, "resealing", { phase }), ValidationError);
  }
  const recorded = keys.advanceRotation(rotation.rotationId, "resealing", { lastErrorCode: "open_failed" });
  assert.equal(recorded.lastErrorCode, "open_failed");
  assert.equal(keys.getOpenRotation("c1")?.rotationId, rotation.rotationId, "the rotation stays open for resume");
  assert.throws(
    () =>
      keys.createRotation({
        citadelId: "c1",
        target: "kek",
        chamberId: null,
        requestedBy: "operator",
        reason: "again",
      }),
    reason("VAULT_ROTATION_IN_PROGRESS"),
  );
});
