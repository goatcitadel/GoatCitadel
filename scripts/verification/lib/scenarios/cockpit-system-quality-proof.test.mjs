import assert from "node:assert/strict";
import { it } from "node:test";
import { assertQualityExportReceipt, assertFirstBuiltinImport } from "./cockpit-system-quality-proof.mjs";

function receipt(kind) {
  const payload = { version: kind === "evaluations" ? "llm.eval_proof_export.v1" : "ops.quality_export.otel_json.v1",
    generatedAt: "2026-09-30T14:00:00.000Z", runs: [{ runId: "exact-run" }],
    posture: { readOnly: true, sideEffectPosture: "audit_only" } };
  return { ...payload, content: JSON.stringify(payload) };
}
it("matches clipboard content with the exact evaluation and transport response", () => {
  for (const kind of ["evaluations", "quality"]) {
    const value = receipt(kind);
    assert.doesNotThrow(() => assertQualityExportReceipt(kind, value, value.content));
    assert.throws(() => assertQualityExportReceipt(kind, value, "copied different content"));
  }
});
it("allows Windows CRLF clipboard conversion without accepting altered content or lone CR", () => {
  const value = receipt("evaluations");
  value.content = JSON.stringify(JSON.parse(value.content), null, 2);
  const windowsText = value.content.replaceAll("\n", "\r\n");
  assert.doesNotThrow(() => assertQualityExportReceipt("evaluations", value, windowsText));
  assert.throws(() => assertQualityExportReceipt("evaluations", value, windowsText.replace("exact-run", "foreign-run")));
  assert.throws(() => assertQualityExportReceipt("evaluations", value, value.content.replaceAll("\n", "\r")));
  assert.throws(() => assertQualityExportReceipt("evaluations", value, `${windowsText} `));
});

const importEvidence = () => {
  const definition = { packKey: "defensive", testCount: 2, importCapability: { packId: "defensive", definitionRevision: "reviewed-revision", contentSha256: "reviewed-hash" } };
  const pack = { packId: "defensive", testCount: 2, contentSha256: "reviewed-hash" };
  const tests = [{ testId: "a", packId: "defensive", prompt: "First stored definition" }, { testId: "b", packId: "defensive", prompt: "Second stored definition" }];
  return { definition, result: { pack, tests, importReceipt: { version: "prompt_pack.builtin_import_receipt.v1", operation: "created",
    packKey: "defensive", definitionRevision: "reviewed-revision", contentSha256: "reviewed-hash" } }, owner: { pack: { ...pack }, tests: structuredClone(tests) } };
};
it("binds first import receipt and independent current tests to the reviewed definition", () => {
  const { definition, result, owner } = importEvidence();
  assert.doesNotThrow(() => assertFirstBuiltinImport(definition, result, owner));
});
it("rejects wrong revision, key, hash, duplicate owner rows or substituted content", () => {
  for (const mutate of [
    (value) => { value.result.importReceipt.definitionRevision = "old"; },
    (value) => { value.owner.pack.packId = "foreign"; },
    (value) => { value.owner.pack.contentSha256 = "different"; },
    (value) => { value.owner.tests[1] = value.owner.tests[0]; },
    (value) => { value.owner.tests[0].prompt = "Replaced content"; },
  ]) { const value = importEvidence(); mutate(value); assert.throws(() => assertFirstBuiltinImport(value.definition, value.result, value.owner)); }
});
it("rejects changed generated time, owner rows, version and mutation posture", () => {
  const value = receipt("evaluations");
  for (const changed of [{ ...value, generatedAt: "different" }, { ...value, runs: [] },
    { ...value, version: "different" }, { ...value, posture: { readOnly: false, sideEffectPosture: "audit_only" } }]) {
    assert.throws(() => assertQualityExportReceipt("evaluations", changed, value.content));
  }
});
