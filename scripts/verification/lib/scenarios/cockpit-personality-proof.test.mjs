import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPersonalityDefaultSaved } from "./cockpit-personality-proof.mjs";

const proof = () => ({ before: { revision: "a".repeat(64) },
  after: { revision: "b".repeat(64), defaultPersonalityId: "operator", items: [{ id: "operator" }] },
  selectedId: "operator", request: { personalityId: "operator", expectedRevision: "a".repeat(64) },
  response: { revision: "b".repeat(64), defaultPersonalityId: "operator" } });
describe("personality default browser owner assertions", () => {
  it("accepts exact reviewed revision and committed owner agreement", () => {
    assert.doesNotThrow(() => assertPersonalityDefaultSaved(proof()));
  });
  it("rejects stale or substituted mutation bindings", () => {
    for (const change of [{ personalityId: "teacher" }, { expectedRevision: "c".repeat(64) }]) {
      const value = proof(); assert.throws(() => assertPersonalityDefaultSaved({ ...value, request: { ...value.request, ...change } }));
    }
  });
  it("rejects unchanged owner revisions and missing or different selected personalities", () => {
    for (const change of [{ revision: "a".repeat(64) }, { defaultPersonalityId: "teacher" }, { items: [] }]) {
      const value = proof(); assert.throws(() => assertPersonalityDefaultSaved({ ...value, after: { ...value.after, ...change } }));
    }
  });
  it("rejects an acknowledgement that differs from owner readback", () => {
    for (const change of [{ revision: "c".repeat(64) }, { defaultPersonalityId: "teacher" }]) {
      const value = proof(); assert.throws(() => assertPersonalityDefaultSaved({ ...value, response: { ...value.response, ...change } }));
    }
  });
});
