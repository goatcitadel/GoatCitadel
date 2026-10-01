import assert from "node:assert/strict";
import test from "node:test";
import { assertMasonAccessPreserved, assertMasonSessionOwner, assertMasonStagingOwner } from "./cockpit-citadel-mason-proof.mjs";
const before = { citadelId: "one", revision: "old", record: { citadelId: "one", name: "One", hasCharter: false }, chambers: [{ chamberId: "old", name: "Old", sensitivity: "private", sealed: false }] };
const blueprint = { charter: { purpose: "Reviewed" }, chambers: [{ name: "New", sensitivity: "restricted", sealed: true }] }, summary = { name: "Reviewed" };
const owner = { ...before, revision: "new", record: { ...before.record, hasCharter: true }, charter: blueprint.charter, chambers: [...before.chambers, { chamberId: "new", ...blueprint.chambers[0] }] };
const input = { before, blueprint, summary, request: { blueprint, expectedRevision: "old" }, receipt: { citadel: owner, review: summary }, owner };
test("binds exact revisioned stage, preserves prior Chambers and directory metadata", () => assertMasonStagingOwner(input));
test("rejects stale request, foreign owner, altered review or deleted Chambers", () => {
  for (const patch of [{ request: { ...input.request, expectedRevision: "stale" } }, { owner: { ...owner, citadelId: "other" } }, { receipt: { ...input.receipt, review: { name: "Other" } } }, { owner: { ...owner, chambers: [owner.chambers[1]] } }]) assert.throws(() => assertMasonStagingOwner({ ...input, ...patch }));
});
test("binds global session answer receipt/readback without fabricating a Citadel or CAS", () => {
  const before = { sessionId: "session", answers: {}, status: "collecting", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" }, patch = { purpose: "Reviewed" };
  const owner = { ...before, answers: patch }; assertMasonSessionOwner({ before, patch, owner, receipt: owner });
  assert.throws(() => assertMasonSessionOwner({ before, patch, owner: { ...owner, sessionId: "foreign" }, receipt: owner }));
});
test("staging advances structure truth while preserving every separate access record family", () => {
  const beforeAccess = { citadelId: "one", revision: "before", structure: before, wards: [{ wardId: "one" }], council: [], passages: [], members: [], integrations: [] };
  const after = { ...beforeAccess, revision: "after", structure: owner };
  assertMasonAccessPreserved({ before: beforeAccess, after, structure: owner });
  assert.throws(() => assertMasonAccessPreserved({ before: beforeAccess, after: { ...after, wards: [] }, structure: owner }));
  assert.throws(() => assertMasonAccessPreserved({ before: beforeAccess, after, structure: before }));
});
