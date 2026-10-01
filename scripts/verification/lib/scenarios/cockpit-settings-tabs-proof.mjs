import { proveRetainedSettingsTabDraft } from "./cockpit-navigation-draft-proof.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertSettingsTabsOwnerUnchanged(before, after, writes) {
  assert.deepEqual(writes, [], "Settings tab navigation dispatched a runtime mutation.");
  assert.deepEqual(after, before, "Read-only Settings tab navigation changed the personality catalog.");
}

export function assertSettingsCapabilityOwnerUnchanged(citadelId, before, after, writes) {
  assert.deepEqual(writes, [], "Settings tabs dispatched a runtime mutation.");
  assert.equal(before.length, 3, "Every Citadel capability resource owner must be read.");
  assert.equal(after.length, 3, "Every Citadel capability resource owner must be re-read.");
  const types = ["skill", "integration", "mcp_server"];
  for (const views of [before, after]) {
    assert.deepEqual(views.map(view => view.resourceType), types);
    for (const view of views) {
      assert.equal(view.scopeKind, "citadel");
      assert.equal(view.scopeId, citadelId);
      assert.equal(view.selectionReview.scopeKind, "citadel");
      assert.equal(view.selectionReview.scopeId, citadelId);
      assert.equal(view.selectionReview.resourceType, view.resourceType);
      assert.match(view.selectionReview.revision, /^[a-f0-9]{64}$/u);
    }
  }
  assert.deepEqual(after, before, "Read-only Settings tabs changed Citadel capability selections.");
}

/** Radix roving focus settles after the key event. Keep the exact target assertion bounded. */
export async function waitForSettingsTabFocus(page, tab) {
  const id = await tab.getAttribute("id");
  assert.ok(id, "Settings tab needs a stable focus target.");
  await page.waitForFunction((targetId) => document.activeElement?.id === targetId, id, { timeout: 5_000 });
  assert.equal(await tab.evaluate((element) => document.activeElement === element), true);
}

export async function runCockpitSettingsTabsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  const read = async () => {
    const response = await requestJson(stack.gatewayUrl, "/api/v1/personalities"); assertOk(response, "Settings tabs personality owner"); return response.body;
  };
  const readCapabilities = () => Promise.all(["skill", "integration", "mcp_server"].map(async type => {
    const route = `/api/v1/citadels/${encodeURIComponent(citadelId)}/capabilities?type=${type}`;
    const response = await requestJson(stack.gatewayUrl, route);
    assertOk(response, "Settings tabs Citadel capability owner");
    return response.body;
  }));
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-settings-tabs.${variant}`, lane: "ux-budgets",
      title: `Settings section keyboard, history and retained selection ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [], writes = [];
      let page;
      try {
        const before = await read();
        const capabilitiesBefore = await readCapabilities();
        const choice = before.items.find((item) => item.id !== before.defaultPersonalityId);
        assert.ok(choice, "Settings tab proof requires a second owner personality.");
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/")) writes.push({ method: request.method(), path: new URL(request.url()).pathname });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        const appearance = page.getByRole("tab", { name: "Appearance", exact: true });
        const personality = page.getByRole("tab", { name: "Personalities", exact: true });
        await appearance.waitFor();
        assert.equal(await appearance.getAttribute("aria-selected"), "true");
        await appearance.focus(); await page.keyboard.press("ArrowRight");
        await waitForSettingsTabFocus(page, personality);
        assert.equal(await appearance.getAttribute("aria-selected"), "true", "Focus movement implicitly activated a section.");
        await page.keyboard.press("Enter");
        await page.waitForURL(/#work-personality$/u);
        const panel = page.getByRole("region", { name: "Work personality", exact: true });
        const select = panel.getByRole("combobox", { name: "Saved personality", exact: true });
        await select.selectOption(choice.id);
        await appearance.click(); await page.waitForURL(/#appearance$/u);
        await panel.waitFor({ state: "hidden" });
        await personality.click(); await page.waitForURL(/#work-personality$/u);
        assert.equal(await select.inputValue(), choice.id, "Switching tabs reset the owner controller selection.");
        await page.goBack(); await page.waitForURL(/#appearance$/u);
        assert.equal(await appearance.getAttribute("aria-selected"), "true");
        await page.goForward(); await page.waitForURL(/#work-personality$/u);
        assert.equal(await select.inputValue(), choice.id);
        const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
        await search.fill("notifications");
        await page.getByRole("link", { name: /^General.*Opens cockpit controls$/u }).waitFor();
        await search.fill("");
        assert.equal(await select.inputValue(), choice.id, "Settings search remounted the selected controller.");
        assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, "Section changes replaced the browser document.");
        await page.addScriptTag({ path: axeSourcePath });
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const audit = async (name) => {
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Settings tabs accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `Settings tabs overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-settings-tabs-${variant}-${name}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("retained");
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Citadel", exact: true }).click();
        const tabs = page.getByRole("tablist", { name: "Citadel sections", exact: true });
        await tabs.waitFor();
        const last = tabs.getByRole("tab").last();
        assert.equal((await last.innerText()).trim(), "Citadel capabilities");
        await tabs.getByRole("tab").first().focus(); await page.keyboard.press("End");
        await waitForSettingsTabFocus(page, last);
        await page.keyboard.press("Enter");
        await page.waitForURL(url => url.pathname === "/settings/citadel" && url.hash === "#citadel-capabilities");
        assert.equal(await last.getAttribute("aria-selected"), "true");
        const capabilities = page.getByRole("region", { name: "Citadel capability selections", exact: true });
        await capabilities.waitFor();
        for (const label of ["Skills", "Plugins", "MCP servers"]) {
          const selection = capabilities.getByRole("region", { name: `${label} selection`, exact: true });
          await selection.waitFor();
          await selection.getByRole("heading", { name: label, exact: true }).waitFor();
          const refresh = selection.getByRole("button", { name: `Refresh ${label.toLowerCase()} scope`, exact: true });
          await refresh.waitFor();
          await page.waitForFunction(element => !element.disabled, await refresh.elementHandle(), { timeout: 30_000 });
        }
        assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, "Citadel tabs replaced the browser document.");
        await audit("narrow-tabs");
        const draftNavigation = await proveRetainedSettingsTabDraft({ page, readGrants: async () => {
          const response = await requestJson(stack.gatewayUrl, "/api/v1/tools/grants?limit=400"); assertOk(response, "Settings tabs grant owner"); return response.body;
        } });
        assertSettingsTabsOwnerUnchanged(before, await read(), writes);
        assertSettingsCapabilityOwnerUnchanged(citadelId, capabilitiesBefore, await readCapabilities(), writes);
        return { status: "passed", metrics: { keyboardManualActivation: true, historyRestored: true, selectionRetained: true,
          documentRetained: true, draftNavigation, nativeCitadelResourceOwners: 3, browserMutations: 0, blockingAxe: 0, overflow: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true });
            const screenshot = path.join(dir, `ux-budgets-cockpit-settings-tabs-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Keep the original assertion failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
