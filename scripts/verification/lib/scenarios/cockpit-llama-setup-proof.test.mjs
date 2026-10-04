import assert from "node:assert/strict";
import test from "node:test";
import { assertLlamaApprovalDestination, assertLlamaAwaitingApproval, assertLlamaOwnerUnchanged, assertLlamaPrepared, cleanupLlamaPlans } from "./cockpit-llama-setup-proof.mjs";
const settings = { revision: 8, llamaCpp: { enabled: false, autoStart: false, managementMode: "external", baseUrl: "http://127.0.0.1:8080/v1" }, llm: { activeProviderId: "fixture", activeModel: "old" } };
const request = { workspaceId: "default", surface: "settings", request: { kind: "runtime_configuration", change: { operation: "llama_cpp_setup", managementMode: "external", model: "fixture-model", baseUrl: "http://127.0.0.1:1234/v1" } } };
const plan = { kind: "runtime_configuration", planId: "plan", revision: 1, origin: { surface: "settings", workspaceId: "default" }, adapter: { adapterId: "runtime-configuration", version: 2 }, scope: "runtime", target: { ownerId: "runtime_settings", resourceId: "llama_cpp_setup", expectedRevision: 8 }, request: request.request, status: "awaiting_confirmation", requiredAction: { kind: "confirmation", actionNonce: "nonce" }, intentHash: "hash", createdAt: "2026-09-30T00:00:00Z" };
const waiting = { ...plan, revision: 3, status: "awaiting_approval", requiredAction: { kind: "approval", approvalId: "approval" }, approvalRefs: ["approval"] };
test("accepts actual scoped preparation and unchanged runtime owner", () => { assertLlamaPrepared({ plan, request, settings, workspaceId: "default" }); assertLlamaOwnerUnchanged(settings, structuredClone(settings)); });
test("rejects wrong plan scope, intent or settings revision", () => {
  for (const patch of [{ origin: { ...plan.origin, workspaceId: "foreign" } }, { request: { kind: "other" } }, { target: { ...plan.target, expectedRevision: 9 } }]) assert.throws(() => assertLlamaPrepared({ plan: { ...plan, ...patch }, request, settings, workspaceId: "default" }));
});
test("accepts exact confirmation into a pending approval with independent readback", () => assertLlamaAwaitingApproval({ before: plan, after: waiting, request: { workspaceId: "default", expectedRevision: 1, actionNonce: "nonce" }, readback: structuredClone(waiting) }));
test("rejects changed intent, stale confirmation and absent approval binding", () => {
  const input = { before: plan, after: waiting, request: { workspaceId: "default", expectedRevision: 1, actionNonce: "nonce" }, readback: waiting };
  for (const patch of [{ after: { ...waiting, intentHash: "foreign" } }, { request: { ...input.request, expectedRevision: 0 } }, { after: { ...waiting, approvalRefs: [] } }]) assert.throws(() => assertLlamaAwaitingApproval({ ...input, ...patch }));
});
test("rejects inference enablement or model changes hidden behind equal revision", () => {
  for (const patch of [{ llamaCpp: { ...settings.llamaCpp, enabled: true } }, { llm: { ...settings.llm, activeModel: "foreign" } }]) assert.throws(() => assertLlamaOwnerUnchanged(settings, { ...settings, ...patch }));
});
test("cleanup visits every exact prepared plan despite a failure and deduplicates identities", async () => {
  const seen = [];
  await assert.rejects(cleanupLlamaPlans(["one", "two", "one"], async id => {
    seen.push(id); if (id === "one") throw new Error("owner unavailable");
  }), AggregateError);
  assert.deepEqual(seen, ["one", "two"]);
});
test("rejects the obsolete runtime adapter identity", () => {
  assert.throws(() => assertLlamaPrepared({ plan: { ...plan, adapter: { adapterId: "runtime_configuration", version: 1 } }, request, settings, workspaceId: "default" }));
});

test("exact specialist inspection requires the same pending approval, scope, immutable intent and zero writes", () => {
  const replay = { approval: { approvalId: "approval", kind: "change_plan_effect", status: "pending",
    linkage: { workspaceId: "default" }, payload: { planId: waiting.planId, kind: waiting.kind,
      scope: waiting.scope, intentHash: waiting.intentHash, targetOwnerId: waiting.target.ownerId,
      targetResourceId: waiting.target.resourceId, targetRevision: waiting.target.expectedRevision,
      adapterId: waiting.adapter.adapterId, adapterVersion: waiting.adapter.version } } };
  const input = { plan: waiting, href: "/ops/approvals?approvalId=approval&shell=classic&shellScope=visit", replay, approvalWrites: [] };
  assertLlamaApprovalDestination(input);
  for (const patch of [
    { href: "/inbox?approvalId=approval" },
    { href: "/ops/approvals?approvalId=approval&shell=classic" },
    { replay: { approval: { ...replay.approval, approvalId: "other" } } },
    { replay: { approval: { ...replay.approval, status: "approved" } } },
    { replay: { approval: { ...replay.approval, linkage: { workspaceId: "foreign" } } } },
    { replay: { approval: { ...replay.approval, payload: { ...replay.approval.payload, targetRevision: 9 } } } },
    { approvalWrites: [{ pathname: "/api/v1/approvals/approval/resolve", method: "POST" }] },
  ]) assert.throws(() => assertLlamaApprovalDestination({ ...input, ...patch }));
});
