import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCitadelMetadataAgreement, assertCitadelLifecycleAgreement, assertCitadelClassicRetention, assertCitadelPresenceHeartbeat, assertCitadelNativeGovernanceHref, navigateCitadelProofSettingsPage } from "./cockpit-citadel-directory-proof.mjs";
const before = { citadelId: "fixture", name: "Original", slug: "fixture", kind: "team", description: "Before", defaultWorkspaceId: "workspace",
  revision: "a".repeat(64), lifecycleStatus: "active", createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z" };

it("requires the exact native same-origin governance destination and carried scope/query/hash", () => {
  const input = { sourceUrl: "http://127.0.0.1:1234/settings/citadel?keep=yes&citadelId=stale&workspaceId=stale&shell=cockpit&shellScope=visit#workspaces",
    citadelId: "fixture", workspaceId: "workspace", href: "/library/citadel-overview?keep=yes&citadelId=fixture&workspaceId=workspace&shell=cockpit#workspaces" };
  assert.equal(assertCitadelNativeGovernanceHref(input), new URL(input.href, input.sourceUrl).href);
  for (const href of [input.href.replace("fixture", "foreign"), input.href.replace("workspaceId=workspace", "workspaceId=foreign"),
    input.href.replace("shell=cockpit", "shell=classic"), input.href.replace("keep=yes&", ""), input.href.replace("#workspaces", "#other"),
    "http://external.invalid" + input.href, input.href.replace("citadel-overview", "other")])
    assert.throws(() => assertCitadelNativeGovernanceHref({ ...input, href }));
});

it("uses exact mobile Settings section values and desktop links for the remount", async () => {
  for (const variant of ["mobile", "desktop"]) for (const section of ["general", "citadel"]) {
    const seen = [];
    const page = { getByRole: (role, options) => {
      if (role === "dialog") {
        assert.deepEqual(options, { name: "Unsaved changes", exact: true });
        return { waitFor: () => new Promise(() => {}) };
      }
      assert.equal(role, "navigation"); assert.deepEqual(options, { name: "Settings pages", exact: true });
      return { getByRole: (control, target) => {
        seen.push({ control, target });
        return { selectOption: async value => seen.push(value), getAttribute: async () => `/settings/${section}`, click: async () => seen.push("clicked") };
      } };
    }, waitForURL: async predicate => assert.equal(predicate(new URL(`http://127.0.0.1/settings/${section}`)), true) };
    await navigateCitadelProofSettingsPage(page, variant, section);
    assert.deepEqual(seen, variant === "mobile"
      ? [{ control: "combobox", target: { name: "Settings pages: choose a section", exact: true } }, `/settings/${section}`]
      : [{ control: "link", target: { name: section === "general" ? "General" : "Citadel", exact: true } }, "clicked"]);
  }
});

it("keeps the retained draft through an actual Settings leave review without save or discard", async () => {
  const seen = []; let reviewed = false, navigated = false, releaseNavigation;
  const page = { getByRole: (role, options) => {
    if (role === "navigation") return { getByRole: () => ({ selectOption: async () => { reviewed = true; } }) };
    assert.equal(role, "dialog"); assert.deepEqual(options, { name: "Unsaved changes", exact: true });
    return { waitFor: async ({ state }) => assert.equal(reviewed, state === "visible"),
      getByRole: (button, target) => {
        assert.equal(button, "button"); assert.deepEqual(target, { name: "Keep draft and close", exact: true });
        return { waitFor: async () => {}, isEnabled: async () => true,
          click: async () => { seen.push(target.name); reviewed = false; navigated = true; releaseNavigation?.(); } };
      } };
  }, waitForURL: async predicate => {
    if (!navigated) await new Promise(resolve => { releaseNavigation = resolve; });
    assert.equal(predicate(new URL("http://127.0.0.1/settings/general")), true);
  } };
  await navigateCitadelProofSettingsPage(page, "mobile", "general");
  assert.deepEqual(seen, ["Keep draft and close"]);
});
const edit = () => { const receipt = { ...before, name: "Renamed", revision: "b".repeat(64), updatedAt: "2026-09-30T00:00:01Z" };
  return { before, receipt, owner: { ...receipt, hasCharter: true }, request: { expectedRevision: before.revision, name: receipt.name, description: receipt.description, slug: receipt.slug, kind: receipt.kind } }; };
const lifecycle = () => { const receipt = { ...before, revision: "b".repeat(64), lifecycleStatus: "archived", archivedAt: "2026-09-30T00:00:01Z", updatedAt: "2026-09-30T00:00:01Z" };
  return { action: "archive", before, receipt, owner: { ...receipt, hasCharter: false }, request: { expectedRevision: before.revision } }; };
it("binds metadata and archive/restore receipts while allowing only the independent charter projection", () => {
  assert.doesNotThrow(() => assertCitadelMetadataAgreement(edit())); assert.doesNotThrow(() => assertCitadelLifecycleAgreement(lifecycle()));
  const value = lifecycle(), receipt = { ...value.receipt, lifecycleStatus: "active", archivedAt: undefined, revision: "c".repeat(64), updatedAt: "2026-09-30T00:00:02Z" };
  assert.doesNotThrow(() => assertCitadelLifecycleAgreement({ before: value.receipt, receipt, owner: receipt, action: "restore", request: { expectedRevision: value.receipt.revision } }));
});
it("rejects scope/identity/default-workspace drift, unreviewed fields and contradictory readback", () => {
  for (const patch of [{ citadelId: "foreign" }, { defaultWorkspaceId: "foreign" }, { createdAt: "wrong" }, { revision: before.revision }, { lifecycleStatus: "archived" }, { name: "Other" }]) {
    const value = edit(); assert.throws(() => assertCitadelMetadataAgreement({ ...value, receipt: { ...value.receipt, ...patch }, owner: { ...value.receipt, ...patch } }));
  }
  const value = edit(); assert.throws(() => assertCitadelMetadataAgreement({ ...value, request: { ...value.request, expectedRevision: "foreign" } }));
  assert.throws(() => assertCitadelMetadataAgreement({ ...value, owner: { ...value.owner, name: "Peer" } }));
  assert.throws(() => assertCitadelMetadataAgreement({ ...value, request: { ...value.request, defaultWorkspaceId: "foreign" } }));
});
it("rejects lifecycle result substitution and wrong action/revision/timestamp", () => {
  for (const patch of [{ citadelId: "foreign" }, { name: "Other" }, { description: "Changed" }, { kind: "custom" }, { defaultWorkspaceId: undefined }, { archivedAt: "wrong" }, { updatedAt: before.updatedAt }, { lifecycleStatus: "active" }]) {
    const value = lifecycle(); assert.throws(() => assertCitadelLifecycleAgreement({ ...value, receipt: { ...value.receipt, ...patch }, owner: { ...value.receipt, ...patch } }));
  }
  assert.throws(() => assertCitadelLifecycleAgreement({ ...lifecycle(), request: { expectedRevision: "foreign" } }));
  assert.throws(() => assertCitadelLifecycleAgreement({ ...lifecycle(), action: "restore" }));
});
it("requires a new create identity with no fabricated workspace or lifecycle state", () => {
  const receipt = { ...before, defaultWorkspaceId: undefined }, request = { name: before.name, description: before.description, slug: before.slug, kind: before.kind };
  assert.doesNotThrow(() => assertCitadelMetadataAgreement({ request, receipt, owner: receipt }));
  assert.throws(() => assertCitadelMetadataAgreement({ request, receipt, owner: receipt, existingIds: [receipt.citadelId] }));
  assert.throws(() => assertCitadelMetadataAgreement({ request, receipt: before, owner: before }));
});

function classicRetention() {
  const value = edit();
  const selection = { citadel: "original", workspace: "default" };
  return { before: { documentNavigations: 1, browserMutations: 5, selection },
    after: { documentNavigations: 1, browserMutations: 5, selection, sameDocument: true, sameRoot: true,
      shell: "classic", unsaved: true, saveDisabled: true, notice: "Citadel save outcome is unconfirmed. Inspect the owner." },
    submitted: value.request, displayed: { name: "Renamed", slug: "fixture", kind: "team", description: "Before" },
    owner: value.owner, receipt: value.receipt };
}
it("requires the same document/root, retained dirty input and unknown lock in the actual classic owner", () => {
  assert.doesNotThrow(() => assertCitadelClassicRetention(classicRetention()));
  for (const patch of [{ documentNavigations: 2 }, { browserMutations: 6 }, { sameDocument: false }, { sameRoot: false },
    { shell: "cockpit" }, { unsaved: false }, { saveDisabled: false }, { notice: "Saved" },
    { selection: { citadel: "replacement", workspace: "default" } }]) {
    const value = classicRetention();
    assert.throws(() => assertCitadelClassicRetention({ ...value, after: { ...value.after, ...patch } }));
  }
});
it("rejects a recreated canonical form or a record changed while opening the classic owner", () => {
  for (const field of ["name", "slug", "kind", "description"]) {
    const value = classicRetention();
    assert.throws(() => assertCitadelClassicRetention({ ...value, displayed: { ...value.displayed, [field]: "different" } }));
  }
  const value = classicRetention();
  assert.throws(() => assertCitadelClassicRetention({ ...value, owner: { ...value.owner, revision: "c".repeat(64) } }));
});
it("classifies only the actual scoped classic presence lease and its accepted receipt", () => {
  const expected = { workspaceId: "default", clientId: "client", leaseId: "lease" };
  const value = { method: "PUT", pathname: "/api/v1/notifications/presence", status: 200,
    body: { ...expected, focused: true, visible: true, ttlMs: 90_000 },
    receipt: { ...expected, focused: true, visible: true, updatedAt: "2026-09-30T00:00:00Z", expiresAt: "2026-09-30T00:01:30Z" } };
  assert.doesNotThrow(() => assertCitadelPresenceHeartbeat(value, expected));
  for (const patch of [{ method: "POST" }, { pathname: "/api/v1/notifications/requests" }, { status: 400 },
    { body: { ...value.body, workspaceId: "foreign" } }, { body: { ...value.body, sessionId: "session" } },
    { body: { ...value.body, targetIds: ["target"] } }, { body: { ...value.body, ttlMs: 80_000 } },
    { body: { ...value.body, clientId: "other" } }, { receipt: { ...value.receipt, leaseId: "other" } },
    { receipt: { ...value.receipt, expiresAt: "2026-09-30T00:02:00Z" } }])
    assert.throws(() => assertCitadelPresenceHeartbeat({ ...value, ...patch }, expected));
});
