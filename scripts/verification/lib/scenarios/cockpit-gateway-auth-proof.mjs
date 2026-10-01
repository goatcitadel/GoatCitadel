import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

export function assertAuthBaselinePreserved({ before, after, request, expected, intercepted }) {
  assert.ok(Number.isSafeInteger(before.revision) && before.revision > 0);
  assert.equal(after.revision, before.revision, "Auth review fixtures changed the settings owner revision.");
  assert.deepEqual(after.auth, before.auth, "Auth review fixtures changed the Gateway transport posture.");
  assert.equal(after.toolApprovalMode, before.toolApprovalMode, "Auth review changed approval policy.");
  assert.deepEqual(request, expected, "The intercepted request does not match the exact reviewed public fields and transient credential.");
  assert.equal(intercepted, 1, "The unknown-response fixture must intercept exactly one auth write before forwarding.");
}

/** Reads the real isolated owner; auth PATCH is deliberately aborted before reaching it. */
export async function runCockpitGatewayAuthProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Auth proof requires an isolated verification runtime.");
  const read = async () => { const response = await requestJson(stack.gatewayUrl, "/api/v1/settings"); assertOk(response, "read real auth owner"); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-gateway-auth.${variant}`, lane: "ux-budgets",
      title: `Native Gateway auth review, unavailable preflight and retained uncertainty ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await read();
      assert.ok(["none", "token", "basic"].includes(before.auth?.mode));
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [], writes = [];
      let page, navigationRequests = 0, intercepted = 0, failedReads = 0;
      try {
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationRequests++;
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /^\/api\/v1\/(auth|change-plans)(\/|$)/.test(pathname)) {
            writes.push({ pathname, method: request.method(), body: request.postDataJSON() });
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/access?shell=cockpit#gateway-auth"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const navigationBaseline = navigationRequests;
        const panel = page.locator("#gateway-auth");
        await panel.getByRole("button", { name: "Configure access", exact: true }).click();
        const editor = panel.getByRole("region", { name: "Configure Gateway access", exact: true });
        await editor.getByRole("combobox", { name: "Auth mode", exact: true }).selectOption("token");
        await editor.getByRole("checkbox", { name: "Loopback bypass", exact: true }).setChecked(!before.auth.allowLoopbackBypass);
        const synthetic = `cockpit-auth-fixture-${variant}-${Date.now()}`;
        await editor.getByLabel("Token", { exact: true }).fill(synthetic);
        const expected = { expectedRevision: before.revision, mode: "token", allowLoopbackBypass: !before.auth.allowLoopbackBypass, token: synthetic };
        await editor.getByRole("button", { name: "Save access settings", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Apply Gateway authentication changes?", exact: true });
        await review.waitFor();
        const text = await review.innerText();
        assert.ok(text.includes(`settings revision ${before.revision}`));
        assert.ok(text.includes("every workspace") && text.includes("Gateway custody"));
        assert.ok(!text.includes(synthetic), "Authentication review exposed a credential value.");
        assert.deepEqual(writes, [], "Drafting or opening review mutated auth.");
        await page.addScriptTag({ path: axeSourcePath });
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const audit = async (stage, dialog) => {
          if (dialog) {
            const buttons = {};
            for (const label of ["Apply reviewed authentication", "Keep current authentication"]) {
              const action = dialog.getByRole("button", { name: label, exact: true }); await action.waitFor({ state: "visible" });
              buttons[label] = await action.boundingBox();
            }
            assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons });
          }
          const axe = await auditPageAccessibility(page), blocking = axe.violations.filter(item => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Auth ${stage} accessibility: ${blocking.map(item => item.id).join(", ")}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, `Auth ${stage} overflow`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-gateway-auth-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("review", review);
        await review.getByRole("button", { name: "Keep current authentication", exact: true }).click();
        await review.waitFor({ state: "hidden" }); assert.deepEqual(writes, []);
        const unavailable = async route => {
          if (route.request().method() !== "GET") return route.continue();
          failedReads++;
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Verification fixture: auth preflight unavailable" }) });
        };
        await page.route("**/api/v1/settings", unavailable);
        await editor.getByRole("button", { name: "Save access settings", exact: true }).click();
        await review.getByRole("button", { name: "Apply reviewed authentication", exact: true }).click();
        await panel.getByText("Current Gateway authentication could not be verified. No authentication write was sent.", { exact: true }).waitFor();
        assert.ok(failedReads > 0); assert.deepEqual(writes, [], "Unavailable preflight dispatched an auth write.");
        await page.unroute("**/api/v1/settings", unavailable);
        await page.route("**/api/v1/auth/settings", async route => {
          if (route.request().method() !== "PATCH") return route.continue();
          intercepted++; await route.abort("failed");
        });
        await editor.getByRole("button", { name: "Save access settings", exact: true }).click();
        await review.getByRole("button", { name: "Apply reviewed authentication", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "authentication change outcome is uncertain" }).waitFor();
        assert.equal(await editor.getByLabel("Token", { exact: true }).inputValue(), "", "Submitted credential remained in the editor.");
        assert.equal(await editor.getByRole("button", { name: "Save access settings", exact: true }).isDisabled(), true);
        await panel.scrollIntoViewIfNeeded(); await audit("unknown");
        const pages = page.getByRole("navigation", { name: "Settings pages", exact: true });
        const accessUrl = page.url();
        const navigationLeave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        assert.equal(writes.length, 1, "Unknown auth outcome did not retain exactly one intercepted write.");
        await pages.getByRole("link", { name: "General", exact: true }).click();
        await navigationLeave.waitFor();
        assert.equal(await navigationLeave.count(), 1);
        await navigationLeave.getByText("You have unsaved changes in Gateway authentication.", { exact: true }).waitFor();
        assert.equal(page.url(), accessUrl, "Auth navigation happened before its leave decision.");
        assert.equal(writes.length, 1, "Opening an auth leave review dispatched another write.");
        await navigationLeave.getByRole("button", { name: "Cancel", exact: true }).click();
        await navigationLeave.waitFor({ state: "hidden" });
        assert.equal(page.url(), accessUrl, "Canceled auth navigation changed its URL.");
        assert.equal(await editor.getByRole("button", { name: "Save access settings", exact: true }).isDisabled(), true);
        assert.equal(await editor.getByLabel("Token", { exact: true }).inputValue(), "");
        assert.equal(writes.length, 1, "Canceled auth navigation dispatched another write.");
        await pages.getByRole("link", { name: "General", exact: true }).click();
        await navigationLeave.waitFor();
        await navigationLeave.getByText("You have unsaved changes in Gateway authentication.", { exact: true }).waitFor();
        assert.equal(page.url(), accessUrl, "Auth leave review committed navigation before Keep.");
        await navigationLeave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await navigationLeave.waitFor({ state: "hidden" });
        await page.waitForURL(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit"));
        assert.equal(writes.length, 1, "Keeping the uncertain auth draft dispatched another write.");
        await pages.getByRole("link", { name: "Access", exact: true }).click();
        await page.waitForURL(buildVerificationUiUrl(stack.uiUrl, "/settings/access?shell=cockpit"));
        await panel.getByRole("button", { name: "Configure access · Unsaved", exact: true }).click();
        assert.equal(await editor.getByRole("button", { name: "Save access settings", exact: true }).isDisabled(), true);
        assert.equal(await editor.getByLabel("Token", { exact: true }).inputValue(), "");
        assert.equal(navigationRequests, navigationBaseline, "Native navigation reloaded the document.");
        await page.getByRole("link", { name: "Desktop and mobile continuity", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.shell === "classic");
        const classic = page.getByRole("region", { name: "Gateway authentication", exact: true });
        await classic.getByRole("button", { name: "Configure access · Unsaved", exact: true }).click();
        assert.equal(await classic.getByRole("button", { name: "Save access settings", exact: true }).isDisabled(), true);
        assert.equal(await classic.getByLabel("Token", { exact: true }).inputValue(), "");
        assert.ok((await classic.innerText()).includes("outcome is uncertain"));
        assert.equal(navigationRequests, navigationBaseline, "Detailed owner transition lost the app-session auth lock.");
        const after = await read();
        assert.equal(writes.length, 1); assert.equal(writes[0].pathname, "/api/v1/auth/settings"); assert.equal(writes[0].method, "PATCH");
        assertAuthBaselinePreserved({ before, after, request: writes[0].body, expected, intercepted });
        return { status: "passed", metrics: { realOwnerInspected: true, explicitCancelWithoutWrite: true, unavailablePreflightWithheld: true,
          interceptedAuthWrites: intercepted, actualAuthWrites: 0, actualAuthSettlementExercised: false, installTokenRequested: false,
          transientCredentialCleared: true, nativeRemountLockPreserved: true, sameDocumentClassicLockPreserved: true, authBaselinePreserved: true, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
            const screenshot = path.join(directory, `ux-budgets-cockpit-gateway-auth-${variant}-failure.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve original failure. */ }
        }
        return { status: "failed", error: String(error?.stack ?? error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
