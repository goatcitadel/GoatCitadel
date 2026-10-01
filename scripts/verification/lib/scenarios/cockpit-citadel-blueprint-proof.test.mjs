import assert from "node:assert/strict";
import { it } from "node:test";
import { assertBlueprintImportOwner } from "./cockpit-citadel-blueprint-proof.mjs";
const sample = () => {
  const before = { citadelId: "one", revision: "a".repeat(64), record: { name: "One" }, charter: null, chambers: [{ chamberId: "old", name: "Retained", sensitivity: "private", sealed: false }] };
  const blueprint = { charter: { purpose: "Reviewed" }, chambers: [{ name: "Added", sensitivity: "private", sealed: true }] };
  const receipt = { ...before, revision: "b".repeat(64), charter: { ...blueprint.charter }, chambers: [...before.chambers, { chamberId: "new", ...blueprint.chambers[0] }] };
  return { before, blueprint, receipt, owner: structuredClone(receipt), request: { blueprint, expectedRevision: before.revision } };
};
it("binds exact source, revision, retained chambers, added chambers and independent owner", () => { assert.doesNotThrow(() => assertBlueprintImportOwner(sample())); });
it("rejects foreign identity/revision/readback/metadata and unreviewed or lost chambers", () => {
  for (const change of [value => { value.receipt.citadelId = "foreign"; }, value => { value.request.expectedRevision = "foreign"; },
    value => { value.receipt.record.name = "Other"; }, value => { value.receipt.charter.purpose = "Other"; },
    value => { value.receipt.chambers.shift(); }, value => { value.receipt.chambers.push({ chamberId: "extra", name: "Extra" }); },
    value => { value.owner.revision = "different"; }]) { const value = sample(); change(value); assert.throws(() => assertBlueprintImportOwner(value)); }
});
