import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export const HEALTH_LOCAL_AI_HREF = "/settings/models?shell=cockpit#local-ai";

function stoppedRuntimeEvidence(status) {
  assert.ok(status, "The settings owner must expose canonical llama.cpp runtime status");
  assert.equal(status.enabled, false);
  assert.equal(status.desiredState, "stopped");
  assert.equal(status.processState, "stopped");
  assert.equal(status.healthy, false);
  assert.equal(status.pid, undefined);
  const diagnostics = status.leaseDiagnostics;
  assert.ok(diagnostics, "The owner must expose process ownership and startup demand");
  assert.equal(diagnostics.state, "idle");
  assert.equal(diagnostics.ownership, "none");
  assert.equal(diagnostics.activeLeaseCount, 0);
  assert.deepEqual(diagnostics.purposes, []);
  assert.deepEqual(diagnostics.persistentDemand, { manual: false, api: false, autostart: false });
  assert.equal(diagnostics.evidence?.lastProbe?.healthy, false);
  assert.ok(Number.isFinite(Date.parse(status.updatedAt)));
  assert.ok(Number.isFinite(Date.parse(diagnostics.evidence.lastProbe.at)));
  const comparable = structuredClone(status);
  // LlamaCppRuntimeService.refreshCoreTracked/readRemoteHealth update these
  // observation timestamps during reads. Every other runtime/evidence field remains exact.
  delete comparable.updatedAt;
  delete comparable.leaseDiagnostics.evidence.lastProbe.at;
  return comparable;
}

export function assertHealthNativeNavigation({ url, uiUrl, documentRequestsBefore, documentRequestsAfter,
  marker, expectedMarker, selection, citadelId, before, after, mutations }) {
  assert.equal(url, new URL(HEALTH_LOCAL_AI_HREF, uiUrl).href);
  assert.equal(documentRequestsAfter, documentRequestsBefore, "Local AI navigation must not request a new document");
  assert.equal(marker, expectedMarker, "Local AI navigation must retain the document realm");
  assert.deepEqual(selection, { workspaceId: "default", citadelId });
  assert.equal(after.revision, before.revision);
  assert.equal(before.llamaCpp.enabled, false);
  const { status: beforeStatus, ...beforeConfig } = before.llamaCpp;
  const { status: afterStatus, ...afterConfig } = after.llamaCpp;
  assert.deepEqual(afterConfig, beforeConfig, "Every saved llama.cpp configuration field must remain unchanged");
  assert.deepEqual(stoppedRuntimeEvidence(afterStatus), stoppedRuntimeEvidence(beforeStatus),
    "Runtime ownership, startup demand and all non-probe evidence must remain unchanged");
  assert.deepEqual(mutations, [], "Health review and Local AI navigation must not mutate the runtime");
}

/** Shipped disabled-runtime fixture: real owner reads, no process startup. */
export async function runCockpitHealthRuntimeProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-health-runtime.${variant}`, lane: "ux-budgets",
      title: `Cockpit local-runtime unavailable-start review ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await requestJson(stack.gatewayUrl, "/api/v1/settings");
      assertOk(before, "read disabled runtime owner");
      assert.equal(before.body?.llamaCpp?.enabled, false, "Health review requires the shipped disabled runtime fixture.");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      const screenshots = [];
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        const mutations = [];
        let documentRequests = 0;
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests += 1;
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) mutations.push(pathname);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/system?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Review local runtime start", exact: true }).click({ timeout: 30_000 });
        const dialog = page.getByRole("dialog", { name: "Start the managed local runtime?", exact: true });
        await dialog.getByText("The local runtime is disabled. Review its configuration in Local AI settings.", { exact: true }).waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Confirm host-wide start", exact: true }).isDisabled(), true);
        assert.equal(await dialog.getByRole("link", { name: "Open Local AI settings", exact: true }).getAttribute("href"), HEALTH_LOCAL_AI_HREF);
        const reviewed = await requestJson(stack.gatewayUrl, "/api/v1/settings");
        assertOk(reviewed, "reread unchanged runtime owner");
        assert.equal(reviewed.body.revision, before.body.revision);
        assert.equal(reviewed.body.llamaCpp.enabled, false);
        assert.deepEqual(mutations, [], "Health inspection requested a mutation.");
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((entry) => ["serious", "critical"].includes(entry.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(blocking.length, 0, `Health review accessibility: ${blocking.map((entry) => entry.id).join(", ")}`);
        assert.ok(overflow <= 1, `Health review overflow: ${overflow}px`);
        const directory = path.join(context.artifactRoot, "screenshots");
        await mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `ux-budgets-cockpit-health-runtime-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        screenshots.push(relativeToRun(context, screenshot));
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual(mutations, []);
        await page.getByRole("button", { name: "Review local runtime start", exact: true }).click();
        await dialog.getByText("The local runtime is disabled. Review its configuration in Local AI settings.", { exact: true }).waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Confirm host-wide start", exact: true }).isDisabled(), true);
        const marker = randomUUID(), documentRequestsBefore = documentRequests;
        await page.evaluate((value) => { window.__healthNavigationMarker = value; }, marker);
        await dialog.getByRole("link", { name: "Open Local AI settings", exact: true }).click();
        await page.waitForURL(new URL(HEALTH_LOCAL_AI_HREF, stack.uiUrl).href);
        await page.getByRole("region", { name: "Local AI readiness", exact: true }).waitFor();
        const after = await requestJson(stack.gatewayUrl, "/api/v1/settings");
        assertOk(after, "independently read runtime after native navigation");
        const navigated = await page.evaluate(() => ({ marker: window.__healthNavigationMarker,
          selection: { workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
            citadelId: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1") } }));
        assertHealthNativeNavigation({ url: page.url(), uiUrl: stack.uiUrl, ...navigated, citadelId,
          documentRequestsBefore, documentRequestsAfter: documentRequests, expectedMarker: marker,
          before: before.body, after: after.body, mutations });
        return { status: "passed", metrics: { actualRuntimeStarted: false, disabledOwnerPreserved: true,
          nativeLocalAiNavigation: true, documentReloads: documentRequests - documentRequestsBefore,
          mutationRequests: 0, blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page) {
          const directory = path.join(context.artifactRoot, "screenshots");
          await mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `ux-budgets-cockpit-health-runtime-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          screenshots.push(relativeToRun(context, screenshot));
        }
        return { status: "failed", error: String(error?.stack ?? error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
