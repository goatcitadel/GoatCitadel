import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

export function assertAddonProofBoundary({ before, after, attempts, cancelled }) {
  assert.deepEqual(after, before, "The disposable Gateway add-on owner changed during blocked browser proof.");
  if (cancelled) assert.deepEqual(attempts, [], "Cancelling an install review dispatched a request.");
  else {
    assert.equal(attempts.length, 1, "Only one intercepted install request is expected.");
    assert.equal(attempts[0].method, "POST");
    assert.equal(attempts[0].pathname, `/api/v1/addons/${encodeURIComponent(before.addon.addonId)}/install`);
    assert.deepEqual(attempts[0].input, { confirmRepoDownload: true, actorId: "operator" });
    assert.equal(attempts[0].forwarded, false, "The proof must not contact the install owner.");
  }
}

/** Actual owner reads; every browser add-on mutation is aborted before reaching Gateway. */
export async function runCockpitAddonsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Requires disposable verification runtime.");
  const api = async route => { const result = await requestJson(stack.gatewayUrl, route);
    assert.ok(result.ok, `Add-on evidence request failed (${result.status}).`); return result.body; };
  const catalog = await api("/api/v1/addons/catalog");
  const addon = catalog.items.find(item => item.addonId === "arena");
  assert.ok(addon?.requiresSeparateRepoDownload && addon.installCommands.length, "Requires actual advertised Arena catalog entry.");
  const statusPath = `/api/v1/addons/${encodeURIComponent(addon.addonId)}/status`;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-addons.${variant}`, lane: "ux-budgets",
      title: `Native add-on owner review, cancellation and intercepted unknown-result lock ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let page, browserContext, stage = "read actual uninstalled owner";
      const screenshots = [], diagnostics = [], attempts = [];
      try {
        const before = await api(statusPath), installedBefore = await api("/api/v1/addons/installed");
        assert.equal(before.status, "not_installed"); assert.equal(before.installed, undefined);
        assert.deepEqual(before.addon, addon);
        assert.equal(installedBefore.items.some(item => item.addonId === addon.addonId), false);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        // This interception is installed before opening the UI and is never removed.
        // It exercises the UI's honest unknown state without allowing download/build/launch.
        await browserContext.route("**/api/v1/addons/**", async route => {
          const request = route.request();
          if (request.method() === "GET") { await route.continue(); return; }
          attempts.push({ method: request.method(), pathname: new URL(request.url()).pathname,
            input: request.postDataJSON(), forwarded: false });
          await route.abort("failed");
        });
        page = await browserContext.newPage();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#addons"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Add-on applications", exact: true });
        await panel.getByRole("button", { name: addon.label, exact: true }).click();
        const selected = panel.getByRole("region", { name: "Selected add-on", exact: true });
        await selected.getByText("not installed", { exact: true }).waitFor();
        const checks = selected.getByRole("region", { name: "Add-on health checks", exact: true });
        for (const check of before.healthChecks) await checks.getByText(`${check.key}: ${check.status} · ${check.message}`, { exact: true }).waitFor();
        await capture("owner-evidence");
        stage = "review full host-code consequences then cancel";
        await selected.getByRole("button", { name: "Review install", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: `Review install: ${addon.label}`, exact: true }); await dialog.waitFor();
        const description = await dialog.innerText();
        assert.ok(description.includes("download and build repository code on this computer") && description.includes("starts disabled"));
        assert.ok(description.includes(addon.repoUrl) && description.includes(addon.owner));
        const commands = dialog.getByRole("region", { name: "Repository and installation commands", exact: true });
        for (const command of addon.installCommands) {
          const expected = command.command + (command.args ?? []).map(arg => ` ${JSON.stringify(arg)}`).join("");
          await commands.locator("code").filter({ hasText: expected }).first().waitFor();
          assert.ok((await commands.locator("code").allTextContents()).includes(expected));
        }
        await capture("install-review");
        // The full command review may scroll vertically; both decisions must
        // remain reachable together inside the bounded dialog at either width.
        await dialog.getByRole("button", { name: "Cancel add-on action", exact: true }).scrollIntoViewIfNeeded();
        const buttons = {};
        for (const name of ["Apply reviewed add-on action", "Cancel add-on action"]) {
          buttons[name] = await dialog.getByRole("button", { name, exact: true }).boundingBox();
        }
        assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons });
        await capture("install-review-actions");
        await dialog.getByRole("button", { name: "Cancel add-on action", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assertAddonProofBoundary({ before, after: await api(statusPath), attempts, cancelled: true });
        stage = "intercept install before Gateway dispatch and retain unknown-result lock";
        await selected.getByRole("button", { name: "Review install", exact: true }).click();
        await dialog.getByRole("button", { name: "Apply reviewed add-on action", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        assertAddonProofBoundary({ before, after: await api(statusPath), attempts, cancelled: false });
        assert.deepEqual(await api("/api/v1/addons/installed"), installedBefore);
        assert.equal(await selected.getByRole("button", { name: "Review install", exact: true }).isDisabled(), true);
        await page.evaluate(() => { window.__addonProofDocument = "same-document"; });
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "Add-ons & packs", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        await panel.getByRole("button", { name: "Refresh add-on evidence", exact: true }).click();
        await selected.getByText("not installed", { exact: true }).waitFor();
        assert.equal(await selected.getByRole("button", { name: "Review install", exact: true }).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__addonProofDocument), "same-document");
        assertAddonProofBoundary({ before, after: await api(statusPath), attempts, cancelled: false });
        await capture("unknown-locked");
        return { status: "passed", metrics: { actualCatalogAndStatus: true, cancelledWrites: 0, interceptedInstallAttempts: attempts.length,
          forwardedMutations: 0, sameDocumentUnknownLock: true, installedOrLaunched: false, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await screenshot("failure"); } catch { /* Preserve first failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, attempts }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
      async function screenshot(name) { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const file = path.join(directory, `cockpit-addons-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); }
      async function capture(name) {
        await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-addons-${variant}-${name}-axe.json`); await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        await screenshot(name);
      }
    });
  }
}
