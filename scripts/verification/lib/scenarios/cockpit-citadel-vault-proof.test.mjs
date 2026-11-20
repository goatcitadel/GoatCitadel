import assert from "node:assert/strict";
import { it } from "node:test";
import { assertVaultReleaseHoldAgreement } from "./cockpit-citadel-vault-proof.mjs";

function fixture() {
  const citadelId = "fixture";
  const before = { citadelId, revision: "a".repeat(64), items: [], keys: { cryptoAvailability: "release_hold" } };
  return { citadelId, before, owner: structuredClone(before), browserOperations: [] };
}

it("requires a Gateway-confirmed release hold and unchanged metadata", () => {
  assert.doesNotThrow(() => assertVaultReleaseHoldAgreement(fixture()));
});

it("rejects absent or different availability, wrong revisions or scope, attempts to write or reveal, and values in metadata", () => {
  for (const patch of [
    { owner: { ...fixture().owner, keys: {} } },
    { owner: { ...fixture().owner, keys: { cryptoAvailability: "available" } } },
    { citadelId: "foreign" },
    { owner: { ...fixture().owner, revision: "b".repeat(64) } },
    { browserOperations: ["POST /api/v1/citadels/fixture/vault-secrets"] },
    { browserOperations: ["GET /api/v1/citadels/fixture/vault-secrets/one/reveal"] },
  ]) {
    assert.throws(() => assertVaultReleaseHoldAgreement({ ...fixture(), ...patch }));
  }
  const value = fixture();
  value.before.items.push({ secretId: "one", secretName: "Name", value: "plaintext" });
  value.owner = structuredClone(value.before);
  assert.throws(() => assertVaultReleaseHoldAgreement(value));
});
