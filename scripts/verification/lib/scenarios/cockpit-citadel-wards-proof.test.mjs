import assert from "node:assert/strict";
import test from "node:test";
import { assertWardMutationOwner, assertWardProbe } from "./cockpit-citadel-wards-proof.mjs";

const prior = { wardId: "peer", citadelId: "one", name: "Peer deny", actionPattern: "ux.*", effect: "deny" };
const before = { citadelId: "one", revision: "old", structure: { revision: "structure" }, council: [], wards: [prior] };
const added = { name: "Reviewed", actionPattern: "ux.action", effect: "allow" };
const ward = { wardId: "new", citadelId: "one", ...added };
const owner = { ...before, revision: "new", wards: [prior, ward] };
const input = { before, added, request: { ...added, expectedRevision: "old" }, receipt: owner, owner };

test("binds exact reviewed Ward and unchanged neighboring access owners", () => {
  assert.deepEqual(assertWardMutationOwner(input), ward);
  const removed = { ...owner, revision: "removed", wards: [prior] };
  assertWardMutationOwner({ before: owner, removedId: ward.wardId, request: { expectedRevision: "new" }, receipt: removed, owner: removed });
});
test("rejects stale revision, foreign record, altered consequence or collateral access changes", () => {
  for (const patch of [
    { request: { ...input.request, expectedRevision: "stale" } },
    { owner: { ...owner, citadelId: "other" } },
    { owner: { ...owner, wards: [prior, { ...ward, effect: "deny" }] } },
    { owner: { ...owner, council: [{ agentId: "unexpected" }] } },
    { owner: { ...owner, wards: [ward] } },
  ]) assert.throws(() => assertWardMutationOwner({ ...input, ...patch, receipt: patch.owner ?? input.receipt }));
});
test("a deny-wins probe binds the requested action and proves the access owner unchanged", () => {
  const input = { action: "ux.action", request: { action: "ux.action" }, receipt: { action: "ux.action", effect: "deny" }, before: owner, after: owner };
  assertWardProbe(input);
  assert.throws(() => assertWardProbe({ ...input, receipt: { action: "other", effect: "deny" } }));
  assert.throws(() => assertWardProbe({ ...input, receipt: { action: "ux.action", effect: "allow" } }));
  assert.throws(() => assertWardProbe({ ...input, after: { ...owner, revision: "changed" } }));
});
