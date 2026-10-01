import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPaletteBootstrapGrants, assertPaletteCreation, assertPaletteThreadScope } from "./cockpit-command-palette-proof.mjs";
function fixture() {
  return { request: { workspaceId: "a", citadelId: "c", mode: "chat", includeInHistory: true },
    receipt: { sessionId: "new", workspaceId: "a", scope: "mission", mode: "chat", includeInHistory: true, lifecycleStatus: "active", revision: 1 },
    canonical: { sessionId: "new", workspaceId: "a" }, workspaceId: "a", citadelId: "c", creates: 1, sends: 0 };
}
test("palette creation proof binds one explicit scoped request and independent canonical receipt without a send", () => {
  assertPaletteCreation(fixture());
  for (const changes of [{ creates: 2 }, { sends: 1 }, { canonical: { sessionId: "other", workspaceId: "a" } },
    { canonical: { sessionId: "new", workspaceId: "other" } }, { request: { ...fixture().request, projectId: "unreviewed" } }]) {
    assert.throws(() => assertPaletteCreation({ ...fixture(), ...changes }));
  }
});
test("palette search proof rejects absent exact owner identity or another workspace", () => {
  const input = { items: [{ session: { sessionId: "exact", workspaceId: "a" } }], expectedSessionId: "exact", foreignSessionId: "foreign", workspaceId: "a" };
  assertPaletteThreadScope(input);
  assert.throws(() => assertPaletteThreadScope({ ...input, items: [] }));
  assert.throws(() => assertPaletteThreadScope({ ...input, items: [...input.items, { session: { sessionId: "foreign", workspaceId: "b" } }] }));
});

function bootstrapFixture() {
  const sessionId = "new-session";
  const before = { items: [{ grantId: "original", createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: "operator", toolPattern: "fixture.unrelated", decision: "deny", scope: "workspace",
    scopeRef: "workspace-a", grantType: "persistent" }] };
  const added = ["runtime.configure", "browser.search", "browser.navigate", "browser.extract", "http.get",
    "session.search", "session.history", "local_business.research"].map((toolPattern, index) => ({
    grantId: `bootstrap-${index}`, createdAt: `2026-10-01T00:01:00.00${index}Z`, toolPattern,
    decision: "allow", scope: "session", scopeRef: sessionId, grantType: "persistent", createdBy: "system-chat-agent-bootstrap",
  }));
  return { before, after: { items: [...added, ...structuredClone(before.items)] },
    sessionGrants: { items: structuredClone(added).reverse() }, sessionId };
}
function matchIndependentAdditions(input) {
  input.sessionGrants.items = structuredClone(input.after.items.filter(item => item.grantId !== "original"));
  return input;
}
test("palette creation admits only the exact eight canonical bootstrap grants while preserving originals", () => {
  assert.equal(assertPaletteBootstrapGrants(bootstrapFixture()), 8);
  for (const patch of [{ createdBy: "system-other-bootstrap" }, { createdBy: "operator" },
    { scope: "workspace" }, { scopeRef: "another-session" }, { scopeRef: "workspace-a" },
    { toolPattern: "fs.write" }, { toolPattern: "browser.*" }, { decision: "deny" },
    { grantType: "one_time" }, { constraints: {} }, { expiresAt: "2026-10-02T00:00:00.000Z" },
    { revokedAt: "2026-10-01T00:02:00.000Z" }, { usesRemaining: 1 }, { createdAt: "invalid" }, { executed: true }]) {
    const input = bootstrapFixture(); Object.assign(input.after.items[0], patch);
    assert.throws(() => assertPaletteBootstrapGrants(matchIndependentAdditions(input)), JSON.stringify(patch));
  }
});
test("palette bootstrap proof rejects changed originals, missing or duplicate additions, and foreign readbacks", () => {
  const mutations = [
    input => { input.after.items.at(-1).decision = "allow"; },
    input => { input.after.items.pop(); },
    input => { input.after.items.shift(); },
    input => { input.after.items[1].grantId = input.after.items[0].grantId; },
    input => { input.after.items[1].toolPattern = input.after.items[0].toolPattern; },
    input => { input.after.items.unshift({ ...input.after.items[0], grantId: "unrequested-extra" }); },
    input => { input.after.items[0].grantId = "original"; },
    input => { input.before.items.push({ ...input.before.items[0] }); },
    input => { input.before.items[0].scope = "session"; input.before.items[0].scopeRef = input.sessionId; },
    input => { input.after.unexpectedEffect = true; },
    input => { input.sessionId = "foreign-created-session"; },
  ];
  for (const mutate of mutations) {
    const input = bootstrapFixture(); mutate(input);
    assert.throws(() => assertPaletteBootstrapGrants(matchIndependentAdditions(input)));
  }
  for (const mutate of [
    input => { input.sessionGrants.items[0].scopeRef = "foreign-session"; },
    input => { input.sessionGrants.items[0].createdAt = "2026-10-02T00:00:00.000Z"; },
    input => { input.sessionGrants.items.pop(); },
    input => { input.sessionGrants.items.push({ ...input.sessionGrants.items[0] }); },
    input => { input.sessionGrants.unexpectedEffect = true; },
  ]) {
    const input = bootstrapFixture(); mutate(input); assert.throws(() => assertPaletteBootstrapGrants(input));
  }
  const bounded = bootstrapFixture();
  bounded.before.items = Array.from({ length: 393 }, (_, index) => ({ ...bounded.before.items[0], grantId: `old-${index}` }));
  assert.throws(() => assertPaletteBootstrapGrants(bounded), /snapshot limit/);
});
