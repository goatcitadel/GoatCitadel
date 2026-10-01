import assert from "node:assert/strict";
import { it } from "node:test";
import { assertSettingsCapabilityOwnerUnchanged, assertSettingsTabsOwnerUnchanged, waitForSettingsTabFocus } from "./cockpit-settings-tabs-proof.mjs";

it("accepts tab proof only when the canonical catalog is unchanged and no mutation was dispatched", () => {
  const before = { revision: "a".repeat(64), defaultPersonalityId: "default", items: [{ id: "default" }] };
  assert.doesNotThrow(() => assertSettingsTabsOwnerUnchanged(before, structuredClone(before), []));
  assert.throws(() => assertSettingsTabsOwnerUnchanged(before, { ...before, revision: "b".repeat(64) }, []));
  assert.throws(() => assertSettingsTabsOwnerUnchanged(before, before, [{ method: "PATCH", path: "/api/v1/personalities/default" }]));
});

it("waits for asynchronous focus but still rejects the wrong focused tab", async () => {
  let focused = false;
  const tab = { getAttribute: async () => "personality-tab", evaluate: async () => focused };
  const page = { waitForFunction: async (_predicate, id, options) => {
    assert.equal(id, "personality-tab"); assert.equal(options.timeout, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1)); focused = true;
  } };
  await waitForSettingsTabFocus(page, tab);
  focused = false;
  await assert.rejects(waitForSettingsTabFocus({ waitForFunction: async () => {} }, tab));
});

it("requires unchanged exact Citadel owners for all three native capability controls", () => {
  const before = ["skill", "integration", "mcp_server"].map(resourceType => ({
    scopeKind: "citadel", scopeId: "citadel-a", resourceType, mode: "inherit", items: [],
    selectionReview: { scopeKind: "citadel", scopeId: "citadel-a", resourceType,
      revision: "a".repeat(64), assignments: [] },
  }));
  assert.doesNotThrow(() => assertSettingsCapabilityOwnerUnchanged("citadel-a", before, structuredClone(before), []));
  for (const after of [before.slice(1), [...before].reverse(),
    before.map(view => ({ ...view, scopeId: "citadel-b" })),
    before.map(view => ({ ...view, selectionReview: { ...view.selectionReview, scopeId: "citadel-b" } })),
    before.map(view => ({ ...view, selectionReview: { ...view.selectionReview, revision: "b".repeat(64) } })),
  ]) assert.throws(() => assertSettingsCapabilityOwnerUnchanged("citadel-a", before, after, []));
  assert.throws(() => assertSettingsCapabilityOwnerUnchanged("citadel-a", before, before,
    [{ method: "PATCH", path: "/api/v1/citadels/citadel-a/capabilities/reviewed" }]));
});
