import assert from "node:assert/strict";
import { it } from "node:test";
import { selectTrustProofCapability, assertTrustProofOwnerLink } from "./cockpit-trust-policy-proof.mjs";

function ownerDialog({ label = "Open Library / Candidates and mesh", href = "/library?shell=cockpit#trust-policy", count = 1 } = {}) {
  return { getByRole(role, options) {
    assert.equal(role, "link");
    const matches = options.name instanceof RegExp ? options.name.test(label) : options.name === label;
    return { count: async () => matches ? count : 0, getAttribute: async () => {
      assert.equal(matches, true, "Expected exact current owner label"); assert.equal(count, 1); return href;
    } };
  } };
}
it("accepts the current exact capabilities.catalog Library owner", async () => {
  await assertTrustProofOwnerLink(ownerDialog(), { source: "capabilities.catalog" });
});
it("rejects obsolete and wrong-shell capability owner links", async () => {
  for (const options of [{ label: "Open Library / Capabilities" }, { label: "Open Library / Skills" },
    { href: "/library?shell=classic#trust-policy" }, { href: "/library?shell=cockpit" }, { count: 2 }])
    await assert.rejects(assertTrustProofOwnerLink(ownerDialog(options), { source: "capabilities.catalog" }));
});
it("binds the distinct skills lifecycle source to its own native Capabilities owner", async () => {
  await assertTrustProofOwnerLink(ownerDialog({ label: "Open Capabilities / Skills", href: "/capabilities/skills?shell=cockpit" }), { source: "skills.lifecycle" });
  await assert.rejects(assertTrustProofOwnerLink(ownerDialog(), { source: "skills.lifecycle" }));
  await assert.rejects(assertTrustProofOwnerLink(ownerDialog(), { source: "unknown" }));
});

it("selects an exact named record only from the supplied read-only owner snapshot", () => {
  const item = { capabilityId: "recorded-one", title: "Recorded capability" };
  const owner = { readOnly: true, mutationSemantics: "none", capabilities: { inspectable: [item], callable: [] } };
  assert.equal(selectTrustProofCapability(owner), item);
  assert.throws(() => selectTrustProofCapability({ ...owner, readOnly: false }));
  assert.throws(() => selectTrustProofCapability({ ...owner, mutationSemantics: "write" }));
  assert.throws(() => selectTrustProofCapability({ ...owner, capabilities: { inspectable: [], callable: [] } }));
});
