import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCapabilityScopeAgreement } from "./cockpit-capability-scopes-proof.mjs";

function fixture(kind = "workspace", reset = false) {
  const review = { version: "capability_scope_selection.v1", revision: "a".repeat(64), scopeKind: kind, scopeId: kind,
    resourceType: "mcp_server", citadelId: "citadel", scopeLifecycleStatus: "active", citadelLifecycleStatus: "active",
    assignments: [{ resourceRef: "fixture", enabled: true }], ...(kind === "workspace" ? { parentAssignments: [] } : {}) };
  const before = { scopeKind: kind, scopeId: kind, resourceType: "mcp_server", selectionReview: review, mode: "curated" };
  const expectedAssignments = reset ? [] : [{ resourceRef: "fixture", enabled: false }];
  const saved = { ...review, revision: "b".repeat(64), assignments: expectedAssignments };
  return { before, method: reset ? "DELETE" : "PATCH", expectedAssignments,
    request: { resourceType: "mcp_server", expectedRevision: review.revision, ...(!reset ? { assignments: expectedAssignments } : {}) },
    receipt: { version: "capability_scope_receipt.v1", previousRevision: review.revision, selectionReview: saved },
    owner: { ...before, selectionReview: structuredClone(saved), mode: reset ? "inherit" : "curated" } };
}

it("accepts exact Citadel and workspace curation and inheritance receipts independently confirmed by owner", () => {
  for (const kind of ["citadel", "workspace"]) for (const reset of [false, true])
    assert.doesNotThrow(() => assertCapabilityScopeAgreement(fixture(kind, reset)));
});

it("rejects foreign scope, resource, parent, lifecycle, stale revision and receipt/readback drift", () => {
  for (const mutate of [
    value => { value.request.expectedRevision = "c".repeat(64); },
    value => { value.request.extra = true; },
    value => { value.request.resourceType = "skill"; },
    value => { value.receipt.previousRevision = "c".repeat(64); },
    value => { value.receipt.selectionReview.revision = value.before.selectionReview.revision; },
    value => { value.receipt.selectionReview.scopeId = "foreign"; },
    value => { value.receipt.selectionReview.citadelId = "foreign"; },
    value => { value.receipt.selectionReview.scopeLifecycleStatus = "archived"; },
    value => { value.receipt.selectionReview.parentAssignments = [{ resourceRef: "peer", enabled: true }]; },
    value => { value.receipt.selectionReview.assignments = [{ resourceRef: "fixture", enabled: true }]; },
    value => { value.owner.selectionReview.revision = "c".repeat(64); },
    value => { value.owner.scopeId = "foreign"; },
    value => { value.owner.mode = "inherit"; },
    value => { value.before.selectionReview.scopeId = "foreign"; },
    value => { value.before.selectionReview.scopeLifecycleStatus = "archived"; },
  ]) {
    const value = structuredClone(fixture()); mutate(value); assert.throws(() => assertCapabilityScopeAgreement(value));
  }
});

it("rejects delete-as-curated, extra delete assignments, duplicate or noncanonical ordering", () => {
  for (const mutate of [
    value => { value.owner.mode = "curated"; },
    value => { value.request.assignments = []; },
    value => { value.expectedAssignments = [{ resourceRef: "one", enabled: true }]; },
  ]) { const value = fixture("workspace", true); mutate(value); assert.throws(() => assertCapabilityScopeAgreement(value)); }
  for (const refs of [["a", "a"], ["z", "A"]]) {
    const value = fixture(); value.expectedAssignments = refs.map(resourceRef => ({ resourceRef, enabled: false }));
    value.request.assignments = value.expectedAssignments; value.receipt.selectionReview.assignments = value.expectedAssignments;
    value.owner.selectionReview.assignments = value.expectedAssignments;
    assert.throws(() => assertCapabilityScopeAgreement(value));
  }
});

it("does not treat live registry availability as frozen selection authority", () => {
  const value = fixture(); value.before.items = [{ resourceRef: "fixture", enabled: true, available: true }];
  value.owner.items = [{ resourceRef: "fixture", enabled: false, available: false }];
  value.owner.effectiveRefs = [];
  assert.doesNotThrow(() => assertCapabilityScopeAgreement(value));
});
