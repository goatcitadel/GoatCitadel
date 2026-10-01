import assert from "node:assert/strict";
import { it } from "node:test";
import { assertReviewedToolGrant } from "./cockpit-tool-grants-proof.mjs";
const evidence = () => {
  const input = { toolPattern: "session.status", decision: "deny", scope: "workspace", scopeRef: "exact-workspace", grantType: "persistent" };
  const receipt = { ...input, grantId: "exact-grant", createdBy: "operator", createdAt: "2026-09-30T15:00:00.000Z" };
  return { input, receipt, owner: { items: [structuredClone(receipt)] } };
};
it("binds the reviewed fields, exact receipt ID and independent current owner record", () => {
  const value = evidence(); assert.doesNotThrow(() => assertReviewedToolGrant(value.input, value.receipt, value.owner));
});
it("rejects foreign scopes, substituted records, duplicate IDs and altered lifetime", () => {
  for (const mutate of [(value) => { value.receipt.scopeRef = "foreign"; }, (value) => { value.owner.items[0].grantId = "different"; },
    (value) => { value.owner.items.push(value.owner.items[0]); }, (value) => { value.owner.items[0].decision = "allow"; },
    (value) => { value.receipt.expiresAt = "2027-01-01T00:00:00Z"; }]) {
    const value = evidence(); mutate(value); assert.throws(() => assertReviewedToolGrant(value.input, value.receipt, value.owner));
  }
});
