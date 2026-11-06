import assert from "node:assert/strict";

/** Navigate only through the native Settings owner while retaining document and selected scope. */
export async function selectCockpitSettingsPage(page, { label, href }) {
  const before = await page.evaluate(() => {
    document.documentElement.dataset.settingsNavigationProof = "retained";
    return { timeOrigin: performance.timeOrigin, sentinel: document.documentElement.dataset.settingsNavigationProof,
      workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"), citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1") };
  });
  assert.ok(typeof before.workspace === "string" && before.workspace.length > 0 && typeof before.citadel === "string" && before.citadel.length > 0, "Selected Settings scope must be available");
  await requestCockpitSettingsPage(page, { label, href });
  await page.waitForURL(url => url.pathname === href && url.search === "?shell=cockpit" && url.hash === "");
  const after = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, sentinel: document.documentElement.dataset.settingsNavigationProof,
    workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"), citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1") }));
  assert.deepEqual(after, before, "Settings page navigation replaced the document or selected scope");
}

/** Trigger navigation so callers can resolve any unsaved-changes dialog before waiting for the URL. */
export async function requestCockpitSettingsPage(page, { label, href }) {
  assert.equal(({ General: "/settings/general", Safety: "/settings/safety", Citadel: "/settings/citadel" })[label], href);
  const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
  assert.equal(await nav.count(), 1);
  const picker = nav.getByRole("combobox", { name: "Settings pages: choose a section", exact: true });
  const link = nav.getByRole("link", { name: label, exact: true });
  const pickerCount = await picker.count(), linkCount = await link.count();
  assert.ok(pickerCount <= 1 && linkCount <= 1, "Ambiguous Settings page controls");
  const pickerVisible = pickerCount === 1 && await picker.isVisible(), linkVisible = linkCount === 1 && await link.isVisible();
  assert.equal(Number(pickerVisible) + Number(linkVisible), 1, "Expected one visible native Settings page control");
  if (pickerVisible) {
    const option = picker.getByRole("option", { name: label, exact: true });
    assert.equal(await option.count(), 1);assert.equal(await option.getAttribute("value"), href);
    await picker.selectOption(href);
  } else { assert.equal(await link.getAttribute("href"), href);await link.click(); }
}
