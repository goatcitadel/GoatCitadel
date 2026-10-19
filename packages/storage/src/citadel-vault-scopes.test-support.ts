import assert from "node:assert/strict";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type CitadelVaultMutation,
  type CitadelVaultSnapshot,
  type SealedValueV2,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CitadelRepository } from "./citadel-repo.js";

const wrapped = { iv: "synthetic-iv", ciphertext: "synthetic-wrapped", tag: "synthetic-tag" };
const legacy = { iv: "synthetic-iv", ciphertext: "synthetic-legacy", tag: "synthetic-tag" };
const bound = (keyId: string, marker = "value"): SealedValueV2 => ({
  v: 2,
  keyId,
  iv: "synthetic-iv",
  ciphertext: `synthetic-${marker}`,
  tag: "synthetic-tag",
});
const reason = (expected: string) => (error: unknown) =>
  error instanceof ConflictError && error.details?.reason === expected;

/** Scope, active-key and digest rules for bound Vault writes, run on both engines. */
export function verifyCitadelVaultScopes(db: DatabaseClient): void {
  const repo = new CitadelRepository(db);
  const citadelId = "vault-scopes";
  const chamber = repo.createChamber({ citadelId, name: "Finance" });
  const foreignChamber = repo.createChamber({ citadelId: "vault-scopes-foreign", name: "Elsewhere" });
  const keys = repo.vaultKeys;
  keys.ensureKeyState(citadelId, 1);
  keys.insertActiveKey({
    citadelId,
    chamberId: null,
    keyId: "k-citadel",
    dekVersion: 1,
    kekVersion: 1,
    wrappedDek: wrapped,
  });
  keys.insertActiveKey({
    citadelId,
    chamberId: chamber.chamberId,
    keyId: "k-finance",
    dekVersion: 1,
    kekVersion: 1,
    wrappedDek: wrapped,
  });
  const mutate = (base: CitadelVaultSnapshot, change: CitadelVaultMutation["change"]) =>
    repo.mutateVault({ citadelId, expectedRevision: base.revision, change });

  let current = repo.getVaultSnapshot(citadelId);
  assert.deepEqual(
    current.keys.scopes.map((scope) => [scope.chamberId, scope.chamberName ?? null, scope.activeKeyVersion]),
    [
      [null, null, 1],
      [chamber.chamberId, "Finance", 1],
    ],
  );

  current = mutate(current, {
    type: "store_bound",
    secretId: "s-api",
    secretName: "API",
    chamberId: chamber.chamberId,
    sealedValue: bound("k-finance"),
  });
  assert.deepEqual(
    current.items.map((item) => [item.secretName, item.chamberId, item.keyVersion]),
    [["API", chamber.chamberId, 1]],
  );
  assert.doesNotMatch(JSON.stringify(current), /synthetic-|ciphertext|sealedValue|wrapped/);

  // store with a mismatched secretId is a revision conflict
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-other",
        secretName: "API",
        chamberId: chamber.chamberId,
        sealedValue: bound("k-finance"),
      }),
    reason("CITADEL_VAULT_REVISION_CONFLICT"),
  );
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-api",
        secretName: "Renamed",
        chamberId: null,
        sealedValue: bound("k-citadel"),
      }),
    reason("CITADEL_VAULT_REVISION_CONFLICT"),
  );

  // store under another scope's key, or a missing key, is refused with VAULT_KEY_CHANGED
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-db",
        secretName: "DB",
        chamberId: null,
        sealedValue: bound("k-finance"),
      }),
    reason("VAULT_KEY_CHANGED"),
  );

  // store with a foreign chamberId is 404
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-db",
        secretName: "DB",
        chamberId: foreignChamber.chamberId,
        sealedValue: bound("k-citadel"),
      }),
    NotFoundError,
  );

  // v1 envelope writes through the bound path are rejected
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-db",
        secretName: "DB",
        chamberId: null,
        sealedValue: legacy as unknown as SealedValueV2,
      }),
    ValidationError,
  );
  assert.deepEqual(repo.getVaultSnapshot(citadelId), current, "refused writes do not consume the review");

  // move re-scopes the secret under the target scope's active key and records an update time
  const beforeMove = current.items.find((item) => item.secretId === "s-api")!;
  current = mutate(current, {
    type: "move",
    secretId: "s-api",
    chamberId: null,
    sealedValue: bound("k-citadel", "moved"),
  });
  assert.deepEqual(
    current.items.map((item) => [item.chamberId, item.keyVersion]),
    [[null, 1]],
  );
  assert.equal(repo.getVaultSecret(citadelId, "s-api")?.keyId, "k-citadel");
  assert.ok(
    current.items[0]!.updatedAt > beforeMove.updatedAt,
    "a move reseals the secret, so its update time advances",
  );
  assert.equal(current.items[0]!.createdAt, beforeMove.createdAt);
  assert.throws(
    () => mutate(current, { type: "move", secretId: "missing", chamberId: null, sealedValue: bound("k-citadel") }),
    NotFoundError,
  );

  // store under a retiring key is refused once a rotation makes a new key active
  const rotation = keys.createRotation({
    citadelId,
    target: "dek",
    chamberId: null,
    requestedBy: "operator",
    reason: "scheduled",
  });
  const awaiting = repo.getVaultSnapshot(citadelId);
  assert.notEqual(awaiting.revision, current.revision, "starting a rotation changes the review");
  keys.advanceRotation(rotation.rotationId, "awaiting_approval", { phase: "approved" });
  keys.startDekRotation(rotation.rotationId, {
    keyId: "k-citadel-2",
    dekVersion: 2,
    kekVersion: 1,
    wrappedDek: wrapped,
  });
  current = repo.getVaultSnapshot(citadelId);
  assert.throws(
    () =>
      mutate(current, {
        type: "store_bound",
        secretId: "s-db",
        secretName: "DB",
        chamberId: null,
        sealedValue: bound("k-citadel"),
      }),
    reason("VAULT_KEY_CHANGED"),
  );

  // the digest ignores batches (key versions and counts) but changes on phase changes
  const [row] = keys.readSealedRows(citadelId, { keyId: "k-citadel", limit: 10 });
  keys.advanceRotation(rotation.rotationId, "resealing", { resealedCount: 0 });
  assert.equal(repo.getVaultSnapshot(citadelId).revision, current.revision);
  keys.applyResealBatch(citadelId, [
    {
      secretId: "s-api",
      expectSealedJson: row!.sealedValueJson,
      expectKeyId: "k-citadel",
      next: bound("k-citadel-2", "rotated"),
    },
  ]);
  const afterBatch = repo.getVaultSnapshot(citadelId);
  assert.equal(afterBatch.revision, current.revision);
  assert.equal(afterBatch.items[0]?.keyVersion, 2);
  assert.ok(keys.finishDekRotation(rotation.rotationId));
  const completed = repo.getVaultSnapshot(citadelId);
  assert.notEqual(completed.revision, current.revision);
  assert.equal(completed.keys.rotation, undefined);

  // the legacy path still works and the legacy count is reported without changing the review on upgrade
  const legacyRow = repo.storeVaultSecret({ citadelId, secretName: "Old", sealedValue: legacy });
  const withLegacy = repo.getVaultSnapshot(citadelId);
  assert.equal(withLegacy.keys.legacySecretCount, 1);
  const [legacySealed] = keys.readSealedRows(citadelId, { legacyOnly: true, limit: 10 });
  keys.applyResealBatch(citadelId, [
    {
      secretId: legacyRow.secretId,
      expectSealedJson: legacySealed!.sealedValueJson,
      expectKeyId: null,
      next: bound("k-citadel-2", "upgraded"),
    },
  ]);
  const upgraded = repo.getVaultSnapshot(citadelId);
  assert.equal(upgraded.keys.legacySecretCount, 0);
  assert.equal(upgraded.revision, withLegacy.revision, "the background upgrade never 409s an operator");

  // once legacy reads are closed, no legacy v1 write can reopen the downgrade path
  assert.equal(keys.closeLegacyReads(citadelId), true);
  assert.throws(
    () => repo.storeVaultSecret({ citadelId, secretName: "Old", sealedValue: legacy }),
    reason("VAULT_KEY_CHANGED"),
  );
  assert.throws(
    () => mutate(upgraded, { type: "store", secretName: "New legacy", sealedValue: legacy }),
    reason("VAULT_KEY_CHANGED"),
  );
  assert.equal(
    repo.getVaultSecret(citadelId, legacyRow.secretId)?.envelopeVersion,
    2,
    "the upgraded row is not downgraded",
  );
  assert.equal(keys.countLegacy(citadelId), 0);
}
