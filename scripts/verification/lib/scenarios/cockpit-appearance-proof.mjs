import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/** Browser preferences and real Chromium permission state; does not assert installed OS delivery. */
export async function runCockpitAppearanceProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    path, relativeToRun, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-appearance.${variant}`, lane: "ux-budgets",
      title: `Cockpit appearance, saved attention preferences and host permission ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const browserContext = await browser.newContext({ viewport, colorScheme: "light" });
      const screenshots = [];
      const writes = [];
      let nativeTestRequested = false;
      let grantedPermissionSupported = false;
      let page;
      try {
        await browserContext.addInitScript((activeCitadelId) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", "default");
          window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", activeCitadelId);
          window.__cockpitPermissionRequests = 0;
          if ("Notification" in window) {
            const request = window.Notification.requestPermission.bind(window.Notification);
            window.Notification.requestPermission = (...args) => {
              window.__cockpitPermissionRequests += 1;
              return request(...args);
            };
          }
        }, citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/")) {
            writes.push({ method: request.method(), pathname: new URL(request.url()).pathname });
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Appearance and attention", exact: true });
        await panel.waitFor();
        assert.equal(await page.evaluate(() => window.__cockpitPermissionRequests), 0, "Opening Settings requested notification permission.");
        const test = panel.getByRole("button", { name: "Send test notification", exact: true });
        assert.equal(await test.isEnabled(), false, "A clean browser context already enabled the test.");
        const checks = [
          ["Show technical details", true], ["Show attention notices", false],
          ["Use system notifications when allowed", true], ["Only notify when Mission Control is unfocused", true],
        ];
        for (const [name, checked] of checks) await panel.getByRole("checkbox", { name, exact: true }).setChecked(checked);
        await panel.getByRole("combobox", { name: "Color theme", exact: true }).selectOption("dark");
        await panel.getByRole("combobox", { name: "Density", exact: true }).selectOption("compact");
        await panel.getByRole("combobox", { name: "Sound for decisions and problems", exact: true }).selectOption("subtle");
        assert.equal(await page.evaluate(() => window.__cockpitPermissionRequests), 0, "Saved attention preferences prompted the host.");
        await page.reload({ waitUntil: "domcontentloaded" });
        await panel.waitFor();
        for (const [name, checked] of checks) assert.equal(await panel.getByRole("checkbox", { name, exact: true }).isChecked(), checked);
        assert.equal(await panel.getByRole("combobox", { name: "Density", exact: true }).inputValue(), "compact");
        assert.equal(await panel.getByRole("combobox", { name: "Sound for decisions and problems", exact: true }).inputValue(), "subtle");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        assert.equal(await page.evaluate(() => window.__cockpitPermissionRequests), 0, "Reload requested host permission.");

        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const audit = async (stage) => {
          await panel.scrollIntoViewIfNeeded();
          await page.evaluate(async () => {
            await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
            await Promise.allSettled(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished));
          });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Appearance accessibility ${stage}: ${JSON.stringify(blocking.map((item) => ({ id: item.id,
            nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary, html: node.html })) })))}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `Appearance overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-appearance-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("saved-dark");
        await browserContext.grantPermissions(["notifications"], { origin: new URL(page.url()).origin });
        const permission = await page.evaluate(() => window.Notification.permission);
        await panel.getByRole("button", { name: /^(Allow notifications|Re-check permission)$/ }).click();
        if (permission === "granted") {
          grantedPermissionSupported = true;
          await panel.getByText("Allowed by your browser or host.", { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => window.__cockpitPermissionRequests), 0, "Granted permission was requested again.");
          await test.click();
          await panel.getByText("Test notification requested. Check your host's notification area.", { exact: true }).waitFor();
          nativeTestRequested = true;
        } else {
          // Headless Chromium on this host keeps Notification.permission denied
          // even when navigator.permissions reports the driver's grant. Keep the
          // actual notification API authority; never fabricate an enabled host.
          assert.equal(permission, "denied");
          await panel.getByText("System notifications are blocked by the browser or host.", { exact: true }).waitFor();
          assert.equal(await test.isEnabled(), false);
          assert.equal(await page.evaluate(() => window.__cockpitPermissionRequests), 0, "Denied permission was requested again.");
        }
        await browserContext.clearPermissions();
        await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
        await page.waitForFunction(() => window.Notification.permission !== "granted");
        assert.equal(await test.isEnabled(), false, "Revoked permission remained usable after focus.");
        assert.equal(await panel.getByRole("checkbox", { name: "Use system notifications when allowed", exact: true }).isChecked(), true,
          "Host permission changed the separately saved preference.");
        await panel.getByRole("combobox", { name: "Color theme", exact: true }).selectOption("light");
        await panel.getByRole("combobox", { name: "Density", exact: true }).selectOption("comfortable");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
        await audit("light-permission-cleared");
        assert.deepEqual(writes, [], "Browser preferences mutated Gateway runtime state.");
        return { status: "passed", metrics: { savedPreferencesSurviveReload: true, unsolicitedPermissionRequests: 0,
          hostPermissionRefresh: true, grantedPermissionSupported, nativeTestRequested, installedOsDeliveryVerified: false,
          runtimeMutations: writes.length, blockingAxe: 0 },
          notes: grantedPermissionSupported ? [] : ["Native notification permission remained denied in headless Chromium; the real blocked UI was verified. Granted/test behavior has focused unit coverage, not installed-host delivery proof."],
          artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-appearance-${variant}-failure.png`);
          try { await page.screenshot({ path: screenshot }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Keep original failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
