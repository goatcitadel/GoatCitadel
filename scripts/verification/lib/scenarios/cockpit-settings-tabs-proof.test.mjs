import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCitadelCapabilityBoundary, assertCitadelLastTabIdentity, assertSettingsCapabilityOwnerUnchanged, assertSettingsTabsOwnerUnchanged, waitForSettingsTabFocus, finishSettingsCapabilityBoundary } from "./cockpit-settings-tabs-proof.mjs";

function hiddenFixture({ visibleHiddenControl = false, replaceDocument = false, foreignScope = false } = {}) {
  let href = "http://fixture.invalid/settings/citadel?shell=cockpit#citadel-blueprint", snapshots = 0;
  const actions = [];
  const page = {
    evaluate: async (_fn, hash) => {
      if (hash !== undefined) { href = "http://fixture.invalid/settings/citadel?shell=cockpit" + hash;actions.push(hash);return; }
      if (snapshots === 1 && actions.length === 0) { href = "http://fixture.invalid/settings/citadel?shell=cockpit#citadel-capabilities";actions.push("#citadel-capabilities");return; }
      snapshots++;return { href, timeOrigin: snapshots > 1 && replaceDocument ? 99 : 1, workspace: snapshots > 1 && foreignScope ? "foreign" : "workspace-a", citadel: "citadel-a" };
    },
    waitForURL: async predicate => assert.equal(predicate(new URL(href)), true),
    getByRole: (role, { name, exact }) => { assert.equal(exact, true);assert.ok(["tab", "region"].includes(role));
      return { count: async () => visibleHiddenControl && name === "Skills selection" ? 1 : 0,
        waitFor: async () => { assert.equal(name, "Citadel Blueprint");assert.ok(href.endsWith("#citadel-blueprint")); } };
    },
    getByText: (text, options) => { assert.equal(text, "This capability is hidden from the current release. Technical display preferences do not enable it.");assert.deepEqual(options, { exact: true });
      return { waitFor: async () => assert.ok(href.endsWith("#citadel-capabilities")) }; },
  };return { page, actions };
}
it("records intentional hidden controls through an actual same-document deep link and retained three-owner comparison", async () => {
  const f = hiddenFixture(), reads = [], writes = [];
  const readCapabilities = async () => ["skill", "integration", "mcp_server"].map(resourceType => { reads.push(resourceType);return {
    resourceType, scopeKind: "citadel", scopeId: "citadel-a", selectionReview: { resourceType, scopeKind: "citadel", scopeId: "citadel-a", revision: "a".repeat(64) },
  }; });
  const before = await readCapabilities();
  const result = await assertCitadelCapabilityBoundary(f.page);
  await finishSettingsCapabilityBoundary({ citadelId: "citadel-a", before, readCapabilities, writes, boundary: result });
  assert.deepEqual(result, { intentionalHiddenCitadelCapabilityControls: 3 });
  assert.deepEqual(f.actions, ["#citadel-capabilities", "#citadel-blueprint"]);
  assert.deepEqual(reads, ["skill", "integration", "mcp_server", "skill", "integration", "mcp_server"]);assert.deepEqual(writes, []);
});
for (const options of [{ visibleHiddenControl: true }, { replaceDocument: true }, { foreignScope: true }])
  it("rejects visible hidden controls or lost hidden-route custody " + JSON.stringify(options), async () => {
    await assert.rejects(assertCitadelCapabilityBoundary(hiddenFixture(options).page));
  });

it("uses current discoverable Blueprint as the Citadel End-key endpoint", async () => {
  await assertCitadelLastTabIdentity({ innerText: async () => "Export/import · Blueprint" });
});
it("does not certify a hidden capability selector as the last visible tab", async () => {
  await assert.rejects(assertCitadelLastTabIdentity({ innerText: async () => "Citadel capabilities" }));
});

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
