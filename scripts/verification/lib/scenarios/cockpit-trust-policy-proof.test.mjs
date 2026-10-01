import assert from "node:assert/strict";
import { it } from "node:test";
import { selectTrustProofCapability } from "./cockpit-trust-policy-proof.mjs";

it("selects an exact named record only from the supplied read-only owner snapshot", () => {
  const item = { capabilityId: "recorded-one", title: "Recorded capability" };
  const owner = { readOnly: true, mutationSemantics: "none", capabilities: { inspectable: [item], callable: [] } };
  assert.equal(selectTrustProofCapability(owner), item);
  assert.throws(() => selectTrustProofCapability({ ...owner, readOnly: false }));
  assert.throws(() => selectTrustProofCapability({ ...owner, mutationSemantics: "write" }));
  assert.throws(() => selectTrustProofCapability({ ...owner, capabilities: { inspectable: [], callable: [] } }));
});
