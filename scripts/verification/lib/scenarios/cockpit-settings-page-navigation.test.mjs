import assert from "node:assert/strict";
import test from "node:test";
import { selectCockpitSettingsPage } from "./cockpit-settings-page-navigation.mjs";

function fixture({ mobile = false, href = "/settings/safety", duplicates = false, replaceDocument = false, foreignScope = false, noControl = false } = {}) {
  const actions = [];
  let snapshots = 0;
  const option = { count: async () => duplicates ? 2 : 1, getAttribute: async () => href, innerText: async () => "Safety" };
  const picker = { count: async () => mobile && !noControl ? 1 : 0, isVisible: async () => mobile,
    getByRole: () => option, selectOption: async value => { assert.equal(value, href); actions.push(["select", value]); } };
  const link = { count: async () => mobile || noControl ? 0 : duplicates ? 2 : 1, isVisible: async () => !mobile,
    getAttribute: async () => href, click: async () => { assert.equal(mobile, false, "Phone has only its native picker"); actions.push(["click", href]); } };
  const nav = { count: async () => 1, getByRole(role, options) {
    assert.equal(options.exact, true);
    if (role === "combobox") { assert.equal(options.name, "Settings pages: choose a section"); return picker; }
    assert.equal(role, "link"); assert.equal(options.name, "Safety"); return link;
  } };
  return { actions, page: {
    evaluate: async () => ({ timeOrigin: snapshots++ && replaceDocument ? 99 : 1, sentinel: "retained", workspace: snapshots > 1 && foreignScope ? "foreign" : "workspace-a", citadel: "citadel-a" }),
    waitForURL: async predicate => assert.equal(predicate(new URL("http://fixture.invalid" + href + "?shell=cockpit")), true),
    getByRole(role, options) { assert.equal(role, "navigation"); assert.deepEqual(options, { name: "Settings pages", exact: true }); return nav; } } };
}
for (const options of [{ mobile: true, duplicates: true }, { noControl: true }, { replaceDocument: true }, { foreignScope: true }]) {
  test("Settings native navigation refuses ambiguous or lost continuity " + JSON.stringify(options), async () => {
    const f = fixture(options);await assert.rejects(selectCockpitSettingsPage(f.page, { label: "Safety", href: "/settings/safety" }));
  });
}
test("current desktop Settings navigation uses its exact owner link", async () => {
  const f = fixture(); await selectCockpitSettingsPage(f.page, { label: "Safety", href: "/settings/safety" });
  assert.deepEqual(f.actions, [["click", "/settings/safety"]]);
});
test("current phone Settings navigation uses the native exact-value picker without hidden link clicks", async () => {
  const f = fixture({ mobile: true }); await selectCockpitSettingsPage(f.page, { label: "Safety", href: "/settings/safety" });
  assert.deepEqual(f.actions, [["select", "/settings/safety"]]);
});
for (const options of [{ href: "/settings/safety?shell=classic" }, { duplicates: true }]) {
  test("Settings navigation refuses wrong destination or ambiguous owner " + JSON.stringify(options), async () => {
    const f = fixture(options);
    await assert.rejects(selectCockpitSettingsPage(f.page, { label: "Safety", href: "/settings/safety" }));
    assert.deepEqual(f.actions, []);
  });
}
