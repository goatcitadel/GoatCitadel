import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { assertProviderManagementSaved, assertProviderProfileReceipt, assertProviderTransportSaved, assertProviderRemovalApproval, observeProviderResponse } from "./cockpit-provider-management-proof.mjs";
const submitted = { providerId: "fixture", label: "Fixture", baseUrl: "http://127.0.0.1:9999/v1", apiStyle: "openai-chat-completions", defaultModel: "fixture-model" };
const before = { revision: 1, activeProviderId: "default", activeModel: "current", providerConfigs: [] };
const after = { ...before, revision: 2, providerConfigs: [submitted] };
const { providerId, ...profile } = submitted;
const plan = { kind: "provider_connection", status: "completed", origin: { workspaceId: "default", surface: "settings" }, target: { ownerId: "provider_connection", resourceId: providerId, expectedRevision: 1 }, request: { kind: "provider_connection", providerId, profile } };
describe("native provider management browser owner assertions", () => {
  it("requires the exact removal approval, original revision, provider and custody scope", () => {
    const remove = { ...plan, planId: "plan-remove", scope: "provider_connection", intentHash: "intent", status: "awaiting_approval",
      origin: { ...plan.origin, actorId: "operator", requestId: "gateway-issued-request" },
      request: { kind: "provider_connection", providerId, credentialAction: "remove_api_key", credentialDeleteScope: "all" },
      adapter: { adapterId: "provider", version: 1 }, approvalRefs: ["approval"], requiredAction: { kind: "approval", approvalId: "approval" } };
    const approval = { approvalId: "approval", kind: "change_plan_effect", status: "pending", linkage: { workspaceId: "default" },
      payload: { planId: remove.planId, kind: remove.kind, scope: remove.scope, intentHash: remove.intentHash, targetOwnerId: remove.target.ownerId,
        targetResourceId: providerId, targetRevision: 1, adapterId: "provider", adapterVersion: 1 } };
    const input = { plan: remove, replay: { approval }, providerId, settingsRevision: 1, status: "pending" };
    assert.doesNotThrow(() => assertProviderRemovalApproval(input));
    for (const changed of [{ ...approval, approvalId: "foreign" }, { ...approval, status: "approved" },
      { ...approval, payload: { ...approval.payload, targetRevision: 2 } }, { ...approval, payload: { ...approval.payload, intentHash: "other" } }]) {
      assert.throws(() => assertProviderRemovalApproval({ ...input, replay: { approval: changed } }));
    }
    assert.throws(() => assertProviderRemovalApproval({ ...input, plan: { ...remove, request: { ...remove.request, credentialDeleteScope: "env" } } }));
  });
  it("requires exact owner transport attestation and public revision readback while values stay hidden", () => {
    const input = { ...submitted, request: { headers: { "X-Fixture": "hidden-value" } } };
    const receipt = { version: "llm.provider_transport_receipt.v1", providerId: submitted.providerId,
      expectedRevision: 1, appliedRevision: 2, acceptedHeaderNames: ["X-Fixture"] };
    const args = { before, after, submitted: input, response: { ...after, providerTransportReceipt: receipt } };
    assert.doesNotThrow(() => assertProviderTransportSaved(args));
    for (const changed of [undefined, { ...receipt, providerId: "other" }, { ...receipt, expectedRevision: 0 },
      { ...receipt, appliedRevision: 3 }, { ...receipt, acceptedHeaderNames: ["X-Other"] }]) {
      assert.throws(() => assertProviderTransportSaved({ ...args, response: { ...after, providerTransportReceipt: changed } }));
    }
    assert.throws(() => assertProviderTransportSaved({ ...args, after: { ...after, revision: 3 } }));
    assert.throws(() => assertProviderTransportSaved({ ...args, after: { ...after, providerConfigs: [input] } }));
  });
  it("observes a pending wait immediately without hiding its later awaited failure", async () => {
    const original = Promise.reject(new Error("Exact owner response was not observed"));
    const response = observeProviderResponse(original);
    assert.equal(response, original);
    await setImmediate();
    await assert.rejects(response, /Exact owner response was not observed/);
    assert.equal(await observeProviderResponse(Promise.resolve("canonical receipt")), "canonical receipt");
  });
  it("requires exact intent and the settled plan after the reviewed Settings Apply", () => {
    assert.doesNotThrow(() => assertProviderProfileReceipt({ before, after, submitted, plan }));
    assert.throws(() => assertProviderProfileReceipt({ before, after: before, submitted, plan }));
    assert.throws(() => assertProviderProfileReceipt({ before, after, submitted, plan: { ...plan, status: "awaiting_confirmation" } }));
    assert.throws(() => assertProviderProfileReceipt({ before, after, submitted, plan: { ...plan, target: { ...plan.target, expectedRevision: 2 } } }));
    assert.throws(() => assertProviderProfileReceipt({ before, after, submitted, plan: { ...plan, request: { ...plan.request, profile: { ...profile, label: "Other" } } } }));
  });
  it("requires canonical saved fields and unchanged installation routing", () => {
    assert.doesNotThrow(() => assertProviderManagementSaved({ before, after, submitted }));
    for (const changed of [{ ...after, activeProviderId: "fixture" }, { ...after, revision: 1 }, { ...after, providerConfigs: [{ ...submitted, label: "Other" }] }])
      assert.throws(() => assertProviderManagementSaved({ before, after: changed, submitted }));
  });
  it("requires the same explicit custody intent and immutable profile checkpoint through completion", () => {
    const envInput = { ...submitted, apiKeyEnv: "FIXTURE_KEY" };
    const { providerId: id, ...envProfile } = envInput;
    const continued = { ...plan, intentHash: "a".repeat(64), target: { ...plan.target, expectedRevision: 2 },
      request: { kind: "provider_connection", providerId: id, profile: envProfile, credentialStorage: "env", credentialEnvVar: "FIXTURE_KEY" },
      result: { providerProfileCheckpoint: { version: "provider_profile_checkpoint.v1", providerId: id, originalRevision: 1, appliedRevision: 2, intentHash: "a".repeat(64) } },
      evidenceRefs: [`provider_profile:${id}:settings_revision:2`] };
    const args = { before, after: { ...after, revision: 3, providerConfigs: [envInput] }, submitted: envInput, plan: continued, credentialStorage: "env" };
    assert.doesNotThrow(() => assertProviderProfileReceipt(args));
    assert.throws(() => assertProviderProfileReceipt({ ...args, plan: { ...continued, status: "awaiting_input" } }));
    assert.throws(() => assertProviderProfileReceipt({ ...args, plan: { ...continued, evidenceRefs: [] } }));
    assert.throws(() => assertProviderProfileReceipt({ ...args, plan: { ...continued, request: { ...continued.request, credentialStorage: "keychain" } } }));
  });
});
