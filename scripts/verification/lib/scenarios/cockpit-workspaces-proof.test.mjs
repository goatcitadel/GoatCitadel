import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertWorkspaceLifecycleSaved, assertWorkspaceMetadataSaved } from "./cockpit-workspaces-proof.mjs";

const proof = () => {
  const before = { workspaceId: "ws-one", citadelId: "personal", revision: 2, name: "Original", description: "Before",
    slug: "original", lifecycleStatus: "active", workspacePrefs: { hooks: { allowMutatingHooks: false } }, createdAt: "today" };
  const after = { ...before, name: "Renamed", description: "After", revision: 3 };
  return { before, after, response: after, citadelId: "personal", name: "Renamed", description: "After",
    request: { expectedRevision: 2, name: "Renamed", description: "After", slug: "original" } };
};
describe("native workspace browser owner assertions", () => {
  it("accepts exact metadata-only owner acknowledgement", () => {
    assert.doesNotThrow(() => assertWorkspaceMetadataSaved(proof()));
  });
  it("rejects changed scope, identity, lifecycle, slug, preferences, and wrong revisions", () => {
    for (const patch of [{ citadelId: "company" }, { workspaceId: "ws-other" }, { lifecycleStatus: "archived" },
      { slug: "renamed" }, { workspacePrefs: {} }, { revision: 2 }, { revision: 4 }]) {
      const value = proof();
      assert.throws(() => assertWorkspaceMetadataSaved({ ...value, after: { ...value.after, ...patch } }));
    }
  });
  it("rejects unreviewed request fields and substituted mutation replies", () => {
    const value = proof();
    assert.throws(() => assertWorkspaceMetadataSaved({ ...value, request: { ...value.request, citadelId: "company" } }));
    assert.throws(() => assertWorkspaceMetadataSaved({ ...value, request: { ...value.request, expectedRevision: 1 } }));
    assert.throws(() => assertWorkspaceMetadataSaved({ ...value, response: { ...value.response, workspaceId: "other" } }));
  });
});

const lifecycleProof = (action = "archive") => {
  const before = { ...proof().before, lifecycleStatus: action === "archive" ? "active" : "archived",
    updatedAt: "2026-09-30T00:00:00.000Z", ...(action === "restore" ? { archivedAt: "2026-09-30T00:00:00.000Z" } : {}) };
  const after = { ...before, revision: before.revision + 1, lifecycleStatus: action === "archive" ? "archived" : "active",
    updatedAt: "2026-09-30T00:00:01.000Z", archivedAt: action === "archive" ? "2026-09-30T00:00:01.000Z" : undefined };
  return { action, before, after, response: after, request: { expectedRevision: before.revision } };
};
describe("workspace lifecycle browser owner assertions", () => {
  it("accepts exact archive and restore receipts with independent owner agreement", () => {
    for (const action of ["archive", "restore"]) assert.doesNotThrow(() => assertWorkspaceLifecycleSaved(lifecycleProof(action)));
  });
  it("rejects different identity, scope, metadata, preferences and skipped revisions", () => {
    const value = lifecycleProof();
    for (const patch of [{ workspaceId: "foreign" }, { citadelId: "foreign" }, { name: "Changed" }, { description: "Changed" },
      { slug: "changed" }, { createdAt: "changed" }, { workspacePrefs: {} }, { revision: 2 }, { revision: 4 }]) {
      assert.throws(() => assertWorkspaceLifecycleSaved({ ...value, after: { ...value.after, ...patch } }));
    }
  });
  it("rejects invalid lifecycle receipts and writes not bound to the reviewed revision", () => {
    const value = lifecycleProof();
    for (const patch of [{ lifecycleStatus: "active" }, { archivedAt: undefined }, { archivedAt: "earlier" }, { updatedAt: "invalid" }]) {
      assert.throws(() => assertWorkspaceLifecycleSaved({ ...value, after: { ...value.after, ...patch } }));
    }
    assert.throws(() => assertWorkspaceLifecycleSaved({ ...value, request: { expectedRevision: 1 } }));
    assert.throws(() => assertWorkspaceLifecycleSaved({ ...value, request: { expectedRevision: 2, name: "unreviewed" } }));
    assert.throws(() => assertWorkspaceLifecycleSaved({ ...value, response: { ...value.response, workspaceId: "substituted" } }));
    const restore = lifecycleProof("restore");
    assert.throws(() => assertWorkspaceLifecycleSaved({ ...restore, after: { ...restore.after, archivedAt: restore.before.archivedAt } }));
  });
});
