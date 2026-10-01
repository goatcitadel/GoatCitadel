import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertIntegrationEnabledSaved({ before, after, response, request, enabled }) {
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  assert.match(after.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(request, { expectedRevision: before.revision, enabled });
  assert.equal(after.enabled, enabled);
  for (const field of ["connectionId", "catalogId", "kind", "key", "label", "workspaceId", "status", "createdAt", "pluginId", "pluginVersion", "pluginEnabled"]) {
    assert.deepEqual(after[field], before[field], `Enabled control changed ${field}.`);
  }
  assert.deepEqual(after.config, before.config, "Enabled control changed saved configuration.");
  assert.deepEqual(response, after, "Mutation receipt disagrees with canonical owner readback.");
}

export function assertIntegrationDialogBounds({ viewport, dialog, buttons }) {
  for (const [name, box] of [["dialog", dialog], ...Object.entries(buttons)]) {
    assert.ok(box && box.width > 0 && box.height > 0, `${name} has no visible bounds.`);
    assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1, `${name} extends outside the viewport.`);
  }
}

export async function checkReviewBounds(dialog, viewport, confirmLabel) {
  // Opening a review first reads the canonical owner; a click does not await that read.
  await dialog.waitFor({ state: "visible" });
  const buttons = {};
  for (const name of [confirmLabel, "Keep current state"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    await button.waitFor({ state: "visible" });
    assert.equal(await button.isVisible(), true, `${name} is not visible.`);
    buttons[name] = await button.boundingBox();
  }
  assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons });
}

/** Only a disposable connection's saved enabled flag changes; no integration action is invoked. */
export async function runCockpitIntegrationConnectionsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Integration proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "integration enabled proof owner request"); return response.body;
  };
  const catalog = await api("/api/v1/integrations/catalog");
  const github = catalog.items.find((item) => item.key === "github" && item.kind !== "channel" && item.kind !== "external_connector");
  assert.ok(github, "A saved GitHub integration catalog fixture is required.");
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-integration-connections.${variant}`, lane: "ux-budgets",
      title: `Cockpit reviewed integration enabled state ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const label = `UX integration ${variant}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const initial = await api("/api/v1/integrations/connections", { method: "POST", body: {
        catalogId: github.catalogId, label, enabled: false, status: "paused", config: { owner: "synthetic-cockpit-owner" },
      } });
      const route = `/api/v1/integrations/connections/${encodeURIComponent(initial.connectionId)}`;
      const read = () => api(route);
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [];
      const writes = [];
      let page;
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) {
            writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#integration-connections"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        const panel = page.getByRole("region", { name: "Integration connections", exact: true });
        await panel.getByRole("searchbox", { name: "Search saved integrations", exact: true }).fill(label);
        await panel.getByText("Connection details", { exact: true }).click();
        const details = panel.locator("details[open]");
        assert.ok((await details.innerText()).includes(initial.connectionId));
        assert.ok((await details.innerText()).includes(initial.revision));
        await panel.getByText("Connection details", { exact: true }).click();
        await panel.getByRole("button", { name: `Review enable ${label}`, exact: true }).click();
        const enableDialog = page.getByRole("dialog", { name: "Enable integration?", exact: true });
        await enableDialog.waitFor();
        assert.ok((await enableDialog.innerText()).includes(label));
        assert.ok(!(await enableDialog.innerText()).includes(initial.revision));
        assert.ok((await enableDialog.innerText()).includes("runtime synchronization"));
        await checkReviewBounds(enableDialog, viewport, "Enable reviewed integration");
        assert.deepEqual(writes, [], "Opening integration review mutated the owner.");
        assert.deepEqual(await read(), initial);
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (stage) => {
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(blocking.length, 0, `Integration ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          assert.ok(overflow <= 1, `Integration ${stage} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-integration-connections-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          return overflow;
        };
        await audit("review");
        await enableDialog.getByRole("button", { name: "Keep current state", exact: true }).click();
        await enableDialog.waitFor({ state: "hidden" });
        assert.deepEqual(writes, [], "Cancelling integration review mutated the owner.");
        await panel.getByRole("button", { name: `Review enable ${label}`, exact: true }).click();
        await checkReviewBounds(enableDialog, viewport, "Enable reviewed integration");
        const waitPatch = () => page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === route);
        const enabledResponse = waitPatch();
        await enableDialog.getByRole("button", { name: "Enable reviewed integration", exact: true }).click();
        const enabledReply = await enabledResponse; assert.equal(enabledReply.status(), 200);
        await enableDialog.waitFor({ state: "hidden" });
        await panel.getByRole("button", { name: `Review disable ${label}`, exact: true }).waitFor();
        const enabled = await read();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].pathname, route); assert.equal(writes[0].method, "PATCH");
        assertIntegrationEnabledSaved({ before: initial, after: enabled, response: await enabledReply.json(), request: writes[0].body, enabled: true });
        await panel.getByText(`Connection ${label} enabled. Saved state is confirmed; external connectivity has not been tested.`, { exact: true }).waitFor();
        await panel.scrollIntoViewIfNeeded(); await audit("enabled");
        await panel.getByRole("button", { name: `Review disable ${label}`, exact: true }).click();
        const disableDialog = page.getByRole("dialog", { name: "Disable integration?", exact: true });
        await disableDialog.waitFor();
        assert.ok((await disableDialog.innerText()).includes(label));
        await checkReviewBounds(disableDialog, viewport, "Disable reviewed integration");
        const disabledResponse = waitPatch();
        await disableDialog.getByRole("button", { name: "Disable reviewed integration", exact: true }).click();
        const disabledReply = await disabledResponse; assert.equal(disabledReply.status(), 200);
        await disableDialog.waitFor({ state: "hidden" });
        await panel.getByRole("button", { name: `Review enable ${label}`, exact: true }).waitFor();
        const disabled = await read();
        assert.equal(writes.length, 2, "Integration controls issued an unrelated or duplicate mutation.");
        assert.equal(writes[1].pathname, route); assert.equal(writes[1].method, "PATCH");
        assertIntegrationEnabledSaved({ before: enabled, after: disabled, response: await disabledReply.json(), request: writes[1].body, enabled: false });
        assert.equal(disabled.status, "paused", "The proof must not assert connectivity or alter saved status.");
        await panel.scrollIntoViewIfNeeded(); const overflow = await audit("disabled");
        return { status: "passed", metrics: { browserMutations: 2, cancelledReviewMutations: 0,
          exactRevisionsConfirmed: true, reviewDialogsAndActionsWithinViewport: true, configurationAndScopeUnchanged: true, enabledThenDisabled: true,
          integrationActionsInvoked: 0, externalConnectivityTested: false, blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-integration-connections-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Preserve original proof failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
