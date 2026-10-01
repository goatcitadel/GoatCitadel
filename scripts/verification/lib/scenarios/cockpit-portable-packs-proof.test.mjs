import assert from "node:assert/strict";
import test from "node:test";
import { assertPortablePackStage, assertPortablePackReview, assertPortablePackSetup } from "./cockpit-portable-packs-proof.mjs";
function fixture() {
  const manifest = { packId: "pack", name: "Pack", version: "one", trustTier: "restricted", assets: [{ id: "one", binding: { owner: "mcp" } }], provenance: { source: "local_file", contentHash: "a".repeat(64) } };
  const preview = { manifest, installPlan: [{ assetId: "one", kind: "runtime_preset", outcome: "review_required" }], reviewRequired: true };
  const receipt = { packId: "pack", actorId: "operator", evidenceEnvelopeId: "envelope", installedAt: "2026-09-30T12:00:00Z", preview, stagedAssets: preview.installPlan };
  const source = { packId: "pack", name: "Pack", version: "one", trustTier: "restricted", source: "local_file", actorId: "operator", stagedAt: receipt.installedAt, status: "staged_for_review", reviewRequired: true, stagedAssets: preview.installPlan, evidenceEnvelopeId: "envelope", contentHash: manifest.provenance.contentHash };
  const envelope = { envelopeId: "envelope", eventKind: "capability_pack_install", createdAt: receipt.installedAt, metadata: { packId: "pack", actorId: "operator", trustTier: "restricted", name: "Pack", version: "one", manifest, reviewRequired: true, status: "staged_for_review", installPlan: preview.installPlan, provenance: manifest.provenance } };
  return { manifest, preview, receipt, source, staged: { items: [source] }, envelopes: { items: [envelope] } };
}
test("staging agrees with exact manifest, immutable evidence and bounded saved owner", () => {
  const value = fixture(); assert.deepEqual(assertPortablePackStage(value), value.source);
  for (const mutate of [v => { v.receipt.preview = { ...v.preview, reviewRequired: false }; }, v => { v.envelopes.items[0].workspaceId = "foreign"; }, v => { v.envelopes.items[0].publicProjection = { metadataRedacted: true }; }, v => { v.staged.items = []; }]) {
    const changed = fixture(); mutate(changed); assert.throws(() => assertPortablePackStage(changed));
  }
});
function reviewFixture() {
  const value = fixture(), receipt = { packId: "pack", actorId: "operator", sourceEvidenceEnvelopeId: "envelope", evidenceEnvelopeId: "review", materializedAt: "2026-09-30T12:01:00Z", status: "materialization_recorded", assets: [{ assetId: "one", kind: "runtime_preset", requested: true, outcome: "evidence_recorded", callableState: "unchanged", activationSemantics: "evidence_only" }], limitations: ["No activation"] };
  return { source: value.source, receipt, staged: { items: [{ ...value.source, latestMaterialization: { evidenceEnvelopeId: "review", materializedAt: receipt.materializedAt, actorId: "operator", status: receipt.status, assetCount: 1 } }] }, envelopes: { items: [{ envelopeId: "review", eventKind: "capability_pack_materialization", createdAt: receipt.materializedAt, metadata: { packId: "pack", sourceEvidenceEnvelopeId: "envelope", sourceContentHash: value.source.contentHash, actorId: "operator", status: receipt.status, assets: receipt.assets, limitations: receipt.limitations } }] } };
}
test("review evidence rejects activation, duplicate assets and wrong source", () => {
  assertPortablePackReview(reviewFixture());
  for (const mutate of [v => { v.receipt.assets[0].callableState = "active"; }, v => { v.receipt.assets[0].activationSemantics = "activated"; }, v => { v.receipt.sourceEvidenceEnvelopeId = "other"; }, v => { v.receipt.assets.push(v.receipt.assets[0]); }]) {
    const value = reviewFixture(); mutate(value); assert.throws(() => assertPortablePackReview(value));
  }
});
function setupFixture() {
  const { manifest } = fixture(); manifest.provenance.source = "bundled";
  const request = { workspaceId: "workspace", surface: "settings", request: { kind: "capability_pack", packId: "pack", manifestHash: manifest.provenance.contentHash, assetIds: ["one"] } };
  const receipt = { kind: "capability_pack", scope: "capability", origin: { workspaceId: "workspace", surface: "settings" }, request: request.request, status: "awaiting_confirmation", requiredAction: { kind: "confirmation", actionNonce: "nonce", actionId: "confirm" }, adapter: { adapterId: "capability-pack-execution", version: 1 }, target: { ownerId: "capability_pack", resourceId: "workspace:pack", expectedHash: "b".repeat(64) }, intentHash: "c".repeat(64), evidenceRefs: [] };
  return { manifest, workspaceId: "workspace", request, receipt, owner: structuredClone(receipt) };
}
test("setup proof requires exact untouched awaiting confirmation plan", () => {
  assertPortablePackSetup(setupFixture());
  for (const mutate of [v => { v.receipt.status = "completed"; }, v => { v.receipt.origin.workspaceId = "foreign"; }, v => { v.receipt.evidenceRefs = ["change_plan:executed-child"]; }, v => { v.request.request.assetIds = ["other"]; }, v => { v.owner.intentHash = "d".repeat(64); }]) {
    const value = setupFixture(); mutate(value); assert.throws(() => assertPortablePackSetup(value));
  }
});
