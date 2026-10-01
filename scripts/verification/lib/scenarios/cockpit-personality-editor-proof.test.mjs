import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPersonalityEditorReceipt } from "./cockpit-personality-editor-proof.mjs";

const proof = () => {
  const after = { revision: "b".repeat(64), defaultPersonalityId: "default", items: [{ id: "voice", label: "Exact voice", builtin: false }] };
  return { before: { revision: "a".repeat(64), defaultPersonalityId: "default" }, after, response: structuredClone(after),
    request: { expectedRevision: "a".repeat(64) }, id: "voice", fields: { label: "Exact voice", builtin: false } };
};
describe("native personality editor browser evidence", () => {
  it("accepts exact revision, definition and owner receipt agreement", () => { assert.doesNotThrow(() => assertPersonalityEditorReceipt(proof())); });
  it("rejects stale revision, changed default and substituted saved fields", () => {
    for (const mutate of [
      (value) => { value.request.expectedRevision = "c".repeat(64); },
      (value) => { value.after.defaultPersonalityId = "voice"; },
      (value) => { value.after.items[0].label = "Different"; value.response = structuredClone(value.after); },
      (value) => { value.response.revision = "c".repeat(64); },
    ]) { const value = proof(); mutate(value); assert.throws(() => assertPersonalityEditorReceipt(value)); }
  });
  it("proves removal only when the exact ID is absent from receipt and owner", () => {
    const value = proof(); assert.throws(() => assertPersonalityEditorReceipt({ ...value, removed: true }));
    value.after.items = []; value.response = structuredClone(value.after);
    assert.doesNotThrow(() => assertPersonalityEditorReceipt({ ...value, removed: true }));
  });
});
