import assert from "node:assert/strict";
import test from "node:test";
import { assertCouncilMutationOwner } from "./cockpit-citadel-council-proof.mjs";

const prior = { assignmentId: "peer", citadelId: "one", agentId: "existing" };
const before = { citadelId: "one", revision: "old", structure: { revision: "structure" }, wards: [], council: [prior] };
const seat = { assignmentId: "new", citadelId: "one", agentId: "reviewed", createdAt: "2026-09-30T00:00:00Z" };
const owner = { ...before, revision: "new", council: [prior, seat] };
const input = { before, agentId: "reviewed", request: { agentId: "reviewed", expectedRevision: "old" }, receipt: owner, owner };
test("binds the exact profile reference and preserves neighboring Council and access records", () => {
  assertCouncilMutationOwner(input);
  const removed = { ...owner, revision: "removed", council: [prior] };
  assertCouncilMutationOwner({ before: owner, agentId: "reviewed", remove: true, request: { expectedRevision: "new" }, receipt: removed, owner: removed });
});
test("rejects stale revision, foreign agent or Citadel, duplicate seats and collateral access changes", () => {
  for (const patch of [
    { request: { ...input.request, expectedRevision: "stale" } },
    { owner: { ...owner, citadelId: "other" } },
    { owner: { ...owner, council: [prior, { ...seat, agentId: "foreign" }] } },
    { owner: { ...owner, council: [prior, seat, { ...seat, assignmentId: "extra" }] } },
    { owner: { ...owner, council: [seat] } },
    { owner: { ...owner, wards: [{ wardId: "unexpected" }] } },
  ]) assert.throws(() => assertCouncilMutationOwner({ ...input, ...patch, receipt: patch.owner ?? input.receipt }));
});
test("removal must target a seated agent and cannot remove another reference", () => {
  const removed = { ...owner, revision: "removed", council: [prior] };
  assert.throws(() => assertCouncilMutationOwner({ before: owner, agentId: "absent", remove: true, request: { expectedRevision: "new" }, receipt: removed, owner: removed }));
  const wrong = { ...removed, council: [seat] };
  assert.throws(() => assertCouncilMutationOwner({ before: owner, agentId: "reviewed", remove: true, request: { expectedRevision: "new" }, receipt: wrong, owner: wrong }));
});
