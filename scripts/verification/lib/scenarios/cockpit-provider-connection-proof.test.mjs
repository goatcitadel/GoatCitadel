import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertProviderConnectionPreview, assertProviderConnectionSaved } from "./cockpit-provider-connection-proof.mjs";

const request = { kind: "provider_connection", providerId: "clone", profile: { baseUrl: "http://127.0.0.1:1234/./v1" } };
const config = () => ({ revision: 7, activeProviderId: "stub", activeModel: "stub-model",
  providers: [{ providerId: "clone", baseUrl: "http://127.0.0.1:1234/v1", apiKeySource: "env", apiKeyRef: "STUB_KEY" }] });
function preview() {
  return { before: config(), after: config(), request,
    plan: { kind: "provider_connection", status: "awaiting_confirmation", request,
      origin: { workspaceId: "default", surface: "settings" },
      target: { ownerId: "provider_connection", resourceId: "clone", expectedRevision: 7 } } };
}
function saved() {
  return { ...preview(), after: { ...config(), revision: 8, providers: [{ ...config().providers[0], baseUrl: request.profile.baseUrl }] },
    plan: { ...preview().plan, status: "completed" } };
}
function credential() {
  return { ...saved(), request: { kind: "provider_connection", providerId: "clone", credentialAction: "replace_api_key", credentialStorage: "env", credentialEnvVar: "OWNED_KEY" },
    after: { ...config(), revision: 8, providers: [{ ...config().providers[0], apiKeyRef: "OWNED_KEY" }] },
    secretStatus: { providerId: "clone", hasSecret: true, source: "env" } };
}

describe("provider connection browser proof assertions", () => {
  it("accepts an exact revision-bound preview without a settings mutation", () => assert.doesNotThrow(() => assertProviderConnectionPreview(preview())));
  it("rejects preview writes and different owner bindings", () => {
    assert.throws(() => assertProviderConnectionPreview({ ...preview(), after: { ...config(), revision: 8 } }), /before confirmation/);
    for (const target of [{ expectedRevision: 8 }, { resourceId: "other" }, { ownerId: "other" }]) {
      const input = preview();
      assert.throws(() => assertProviderConnectionPreview({ ...input, plan: { ...input.plan, target: { ...input.plan.target, ...target } } }));
    }
  });
  it("accepts exact saved endpoint and rejects substituted endpoint/default route", () => {
    assert.doesNotThrow(() => assertProviderConnectionSaved(saved()));
    for (const after of [config(), { ...saved().after, activeProviderId: "clone" }, { ...saved().after, providers: config().providers }]) {
      assert.throws(() => assertProviderConnectionSaved({ ...saved(), after }));
    }
  });
  it("requires the exact configured environment reference and credential owner source", () => {
    assert.doesNotThrow(() => assertProviderConnectionSaved(credential()));
    const input = credential();
    for (const secretStatus of [{ ...input.secretStatus, source: "keychain" }, { ...input.secretStatus, hasSecret: false }, { ...input.secretStatus, providerId: "other" }]) {
      assert.throws(() => assertProviderConnectionSaved({ ...input, secretStatus }));
    }
    assert.throws(() => assertProviderConnectionSaved({ ...input, after: { ...input.after, providers: config().providers } }), /environment target/);
  });
  it("rejects a pending plan despite apparent owner settings", () => {
    assert.throws(() => assertProviderConnectionSaved({ ...saved(), plan: { status: "awaiting_confirmation" } }), /did not complete/);
  });
  it("uses a meaningfully different custom endpoint with the same normalized stub transport", () => {
    assert.notEqual(request.profile.baseUrl, config().providers[0].baseUrl);
    assert.equal(new URL(`${request.profile.baseUrl}/models`).toString(), "http://127.0.0.1:1234/v1/models");
  });
});
