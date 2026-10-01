import assert from "node:assert/strict";
import { it } from "node:test";
import { assertVaultUnavailableAgreement } from "./cockpit-citadel-vault-proof.mjs";
function fixture() { const before = { citadelId: "fixture", revision: "a".repeat(64), items: [] };
  return { before, owner: structuredClone(before), status: 503,
    request: { name: "ux-vault-desktop-123", value: "synthetic-vault-proof-input", expectedRevision: before.revision },
    response: { error: "Vault is unavailable — the secret store could not provide a key." } }; }
it("proves only the actual unavailable response and unchanged metadata", () => {
  assert.doesNotThrow(() => assertVaultUnavailableAgreement(fixture()));
});
it("rejects generic failure, wrong review/scope, successful writes and metadata secrets", () => {
  for (const patch of [{ status: 500 }, { status: 201 }, { response: { error: "Other failure" } },
    { owner: { ...fixture().owner, citadelId: "foreign" } }, { owner: { ...fixture().owner, revision: "b".repeat(64) } },
    { request: { ...fixture().request, expectedRevision: "b".repeat(64) } }, { request: { ...fixture().request, extra: true } },
    { request: { ...fixture().request, name: "Existing user secret" } }])
    assert.throws(() => assertVaultUnavailableAgreement({ ...fixture(), ...patch }));
  const value = fixture(); value.before.items.push({ secretId: "one", secretName: "Name", value: "plaintext" });
  value.owner = structuredClone(value.before); assert.throws(() => assertVaultUnavailableAgreement(value));
});
