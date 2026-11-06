import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertProviderConnectionPreview, assertProviderConnectionSaved, openAdvancedProviderProfiles, selectFixtureProviderSettings } from "./cockpit-provider-connection-proof.mjs";

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

// Locator contract fixture: two distinct canonical IDs deliberately share a display label.
// This checks identity/disclosure behavior without a provider request or browser process.
function providerControls(initiallyOpen = false) {
  const providers = ["verification-connection-aaaa", "verification-profile-bbbb"].map(providerId => ({ providerId, label: "Same label" }));
  const state = { open: initiallyOpen, disclosureClicks: 0, selected: providers[0].providerId, checks: [] };
  const radios = items => ({
    items, waitFor: async () => assert.equal(items.length, 1), count: async () => items.length,
    and: other => radios(items.filter(item => other.items.includes(item))),
    check: async () => { assert.equal(items.length, 1); state.selected = items[0].providerId; state.checks.push(state.selected); },
    isChecked: async () => items.length === 1 && state.selected === items[0].providerId,
  });
  const fieldset = {
    locator: selector => {
      const match = /^input\[type="radio"\]\[value=("[^"]+")\]$/u.exec(selector);
      assert.ok(match); return radios(providers.filter(item => item.providerId === JSON.parse(match[1])));
    },
    getByRole: (role, options) => { assert.equal(role, "radio"); assert.equal(options.exact, true); return radios(providers.filter(item => item.label === options.name)); },
  };
  const profiles = {
    waitFor: async () => assert.equal(state.open, true), count: async () => state.open ? 1 : 0,
    getByRole: (role, options) => {
      assert.equal(role, "group"); assert.equal(options.exact, true);
      if (options.name === "Provider") return fieldset;
      assert.equal(options.name, "Same label settings");
      return { waitFor: async () => assert.ok(state.selected), count: async () => 1 };
    },
  };
  const disclosure = { waitFor: async () => {}, getAttribute: async name => { assert.equal(name, "aria-expanded"); return String(state.open); },
    click: async () => { state.open = !state.open; state.disclosureClicks++; } };
  const advanced = { getByRole: (role, options) => {
    assert.equal(options.exact, true);
    if (role === "button") { assert.equal(options.name, "Advanced provider configuration"); return disclosure; }
    assert.equal(role, "region"); assert.equal(options.name, "Provider profiles"); return profiles;
  } };
  const page = { getByRole: (role, options) => { assert.equal(role, "region"); assert.deepEqual(options, { name: "Advanced providers", exact: true }); return advanced; } };
  return { page, profiles, state };
}

describe("current provider collector controls", () => {
  it("opens collapsed simple-mode provider controls before selecting the exact ID despite duplicate labels", async () => {
    const fixture = providerControls();
    const profiles = await openAdvancedProviderProfiles(fixture.page);
    await selectFixtureProviderSettings(profiles, "verification-profile-bbbb", "Same label");
    assert.equal(fixture.state.disclosureClicks, 1);
    assert.deepEqual(fixture.state.checks, ["verification-profile-bbbb"]);
  });
  it("does not collapse an already expanded owner", async () => {
    const fixture = providerControls(true);
    await openAdvancedProviderProfiles(fixture.page);
    assert.equal(fixture.state.disclosureClicks, 0);
  });
  it("rejects a label that disagrees with the canonical fixture ID before selection", async () => {
    const fixture = providerControls(true);
    await assert.rejects(selectFixtureProviderSettings(fixture.profiles, "verification-profile-bbbb", "Wrong provider"));
    assert.deepEqual(fixture.state.checks, []);
  });
  it("rejects missing or non-fixture IDs instead of choosing another provider", async () => {
    const fixture = providerControls(true);
    for (const id of ["verification-profile-cccc", "operator-provider", 'verification-profile-bbbb"]'])
      await assert.rejects(selectFixtureProviderSettings(fixture.profiles, id, "Same label"));
    assert.deepEqual(fixture.state.checks, []);
  });
});
