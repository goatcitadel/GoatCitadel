import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

export function assertFirstRunPreserved({ before, after, writes, forwarded }) {
  assert.equal(before.completed, false, "First-run negative proof must begin with an incomplete real owner.");
  assert.equal(after.completed, false, "The negative fixture changed the actual setup marker.");
  assert.equal(after.completedAt, before.completedAt);
  assert.equal(after.completedBy, before.completedBy);
  assert.deepEqual(after.settings, before.settings, "The negative fixture changed actual installation settings.");
  assert.equal(after.firstTask?.status, before.firstTask?.status, "Negative setup proof created inference evidence.");
  assert.deepEqual(writes, [{ method: "POST", path: "/api/v1/onboarding/complete", body: { completedBy: "operator" } }]);
  assert.equal(forwarded, 0, "A negative completion request reached the Gateway.");
}

/** Real incomplete owner reads; stale-read and lost-response fixtures never change the owner. */
export async function runCockpitFirstRunGuardProof({ context, stack, requestJson, runScenario }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const read = async () => {
    const response = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
    assert.ok(response.ok, "The actual onboarding owner is unavailable.");
    return response.body;
  };
  try {
    for (const { variant, viewport } of [
      { variant: "desktop", viewport: { width: 1280, height: 900 } },
      { variant: "mobile", viewport: { width: 390, height: 844 } },
    ]) {
      await runScenario(context, { id: `install.ui.first-run-guards.${variant}`, lane: "install-smoke",
        title: `Native first-run review, stale preflight and retained uncertainty ${variant}`, subsystem: "mission-control" }, async () => {
        const before = await read();
        assert.equal(before.completed, false);
        assert.notEqual(before.firstTask?.status, "verified");
        assert.equal(before.setupReadiness?.items.find(item => item.id === "provider")?.status, "ready");
        const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
        let page, staleRead = false, staleReads = 0, intercepted = 0, navigations = 0;
        const writes = [], screenshots = [];
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          page = await browserContext.newPage();
          page.on("request", request => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
            const pathname = new URL(request.url()).pathname;
            if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && pathname.startsWith("/api/"))
              writes.push({ method: request.method(), path: pathname, body: request.postDataJSON() });
          });
          await page.route("**/api/v1/onboarding/state", async route => {
            if (!staleRead || route.request().method() !== "GET") return route.continue();
            staleRead = false; staleReads++;
            const actual = await route.fetch(), body = await actual.json();
            // An explicit contradictory response fixture, not a mutation or claimed canonical owner revision.
            await route.fulfill({ response: actual, json: { ...body, settings: { ...body.settings, revision: body.settings.revision + 1 } } });
          });
          await page.route("**/api/v1/onboarding/complete", async route => {
            if (route.request().method() !== "POST") return route.continue();
            intercepted++; await route.abort("failed");
          });
          await page.goto(`${stack.uiUrl}/settings/first-run?shell=cockpit`, { waitUntil: "domcontentloaded" });
          const area = page.getByRole("region", { name: "First-run setup", exact: true });
          await area.getByRole("heading", { name: "Your first answer", exact: true }).waitFor({ timeout: 30_000 });
          const navigationBaseline = navigations;
          assert.equal(await area.getByRole("button", { name: "Finish setup and open Chat", exact: true }).isDisabled(), true);
          await area.getByRole("button", { name: /Step 2.*Set your safety posture/u }).click();
          const approval = area.getByRole("combobox", { name: "Approval rule", exact: true });
          await approval.selectOption("approve_risky");
          await area.getByRole("button", { name: "Exit setup", exact: true }).click();
          const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
          await leave.waitFor();
          const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
          const capture = async name => {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.ok(overflow <= 1, `First-run view overflowed by ${overflow}px.`);
            const file = path.join(directory, `install-first-run-${variant}-${name}.png`);
            await page.screenshot({ path: file, fullPage: false }); screenshots.push(`screenshots/${path.basename(file)}`);
          };
          const buttons = {};
          for (const name of ["Keep draft and close", "Discard changes", "Cancel"])
            buttons[name] = await leave.getByRole("button", { name, exact: true }).boundingBox();
          assertIntegrationDialogBounds({ viewport, dialog: await leave.boundingBox(), buttons });
          await capture("cancel-review");
          await leave.getByRole("button", { name: "Cancel", exact: true }).click();
          assert.deepEqual(writes, [], "Leaving or cancelling review wrote settings.");
          await approval.selectOption("approve_all");
          await area.getByRole("button", { name: "Keep current rule", exact: true }).click();
          const finish = area.getByRole("button", { name: "Finish setup and open Chat", exact: true });
          await finish.waitFor(); staleRead = true;
          await finish.click();
          await area.getByRole("status").filter({ hasText: "Setup changed." }).waitFor();
          assert.equal(staleReads, 1); assert.deepEqual(writes, [], "A contradictory preflight dispatched completion.");
          await finish.click();
          await area.getByRole("alert").filter({ hasText: "Setup completion is uncertain" }).waitFor();
          assert.equal(await finish.isDisabled(), true); assert.equal(intercepted, 1);
          await capture("unknown");
          await area.getByRole("button", { name: "Exit setup", exact: true }).click();
          await page.getByRole("link", { name: "Open three-step first-run setup", exact: true }).click();
          await area.getByRole("alert").filter({ hasText: "Setup completion is uncertain" }).waitFor();
          assert.equal(await finish.isDisabled(), true);
          assert.equal(navigations, navigationBaseline, "First-run remount reloaded the document and lost the lock.");
          assertFirstRunPreserved({ before, after: await read(), writes, forwarded: 0 });
          return { status: "passed", metrics: { incompleteActualOwner: true, nativeDraftCancelNoWrite: true,
            injectedStaleReadResponses: staleReads, stalePreflightNoWrite: true, interceptedCompletionRequests: intercepted,
            forwardedCompletionRequests: 0, nativeUnknownLockRetained: true, documentReloads: 0, actualSettingsPreserved: true,
            providerInferenceExercised: false }, artifacts: { screenshots, diagnostics: [], traces: [], logs: [], perf: [], playwright: [] } };
        } catch (error) {
          if (page && !page.isClosed()) { try {
            const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
            const file = path.join(directory, `install-first-run-${variant}-failure.png`); await page.screenshot({ path: file });
            screenshots.push(`screenshots/${path.basename(file)}`);
          } catch { /* Preserve the original failure. */ } }
          return { status: "failed", error: String(error?.stack ?? error), artifacts: { screenshots, diagnostics: [], traces: [], logs: [], perf: [], playwright: [] } };
        } finally { await browserContext.close(); }
      });
    }
  } finally { await browser.close(); }
}
