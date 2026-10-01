import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

export function assertRuntimeControlsBaseline({ before, after, request, modelId, writes, daemonBefore, daemonAfter }) {
  assert.deepEqual(after, before, "The intercepted fixture changed the actual voice runtime.");
  assert.deepEqual(request, { modelId, activate: true }, "The request changed the reviewed voice model or action.");
  assert.equal(writes, 1, "Exactly one voice mutation must be intercepted before forwarding.");
  assert.equal(daemonAfter.pid, daemonBefore.pid, "The Gateway process changed during read-only controls proof.");
  assert.equal(daemonAfter.lastCommandAt, daemonBefore.lastCommandAt, "A daemon command was recorded during diagnostics review.");
}

/** Actual owner reads; one voice POST is intercepted before any installation or activation. */
export async function runCockpitRuntimeControlsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Runtime proof requires an isolated verification runtime.");
  const read = async route => { const result = await requestJson(stack.gatewayUrl, route); assertOk(result, `read ${route}`); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-runtime-controls.${variant}`, lane: "ux-budgets",
      title: `Native runtime diagnostics and voice review with intercepted unknown outcome ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await read("/api/v1/voice/runtime"), daemonBefore = await read("/api/v1/daemon/status");
      assert.equal(daemonBefore.controllable, false, "This fixture expects the shipped external daemon owner.");
      assert.notEqual(before.source, "env_override", "Voice runtime uses host overrides; this review fixture cannot exercise managed installation.");
      const model = before.catalog.find(item => item.defaultInstall) ?? before.catalog[0];
      assert.ok(model?.id && model.sizeBytes > 0, "The actual voice catalog must supply the reviewed starter model.");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [], writes = [];
      let page, navigations = 0, intercepted = 0;
      try {
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /^\/api\/v1\/(voice|daemon)(\/|$)/.test(pathname)) writes.push({ pathname, method: request.method(), body: request.postDataJSON() });
        });
        await page.route("**/api/v1/voice/runtime/install", async route => {
          if (route.request().method() !== "POST") return route.continue();
          intercepted++; await route.abort("failed");
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/advanced?shell=cockpit#gateway-daemon"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const navigationBaseline = navigations;
        const daemon = page.locator("#gateway-daemon"), voice = page.locator("#voice-runtime");
        await daemon.getByText("Start, stop and restart remain with the external process owner.", { exact: false }).waitFor();
        assert.equal(await daemon.getByRole("button").count(), 1, "Daemon diagnostics exposed unsupported process actions.");
        assert.deepEqual(writes, []);
        await voice.getByRole("button", { name: "Install starter model", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Change the local voice runtime?", exact: true });
        await review.waitFor();
        const reviewText = await review.innerText();
        assert.ok(reviewText.includes(model.label) && reviewText.includes(model.approxSizeLabel));
        assert.ok(reviewText.includes("entire Gateway installation") && reviewText.includes("no atomic revision guard"));
        assert.deepEqual(writes, [], "Voice review dispatched an installation request.");
        await page.addScriptTag({ path: axeSourcePath });
        const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const capture = async (stage, dialog) => {
          if (dialog) {
            const buttons = {};
            for (const label of ["Apply reviewed voice action", "Keep current voice runtime"]) buttons[label] = await dialog.getByRole("button", { name: label, exact: true }).boundingBox();
            assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons });
          }
          const audit = await auditPageAccessibility(page);
          const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Runtime ${stage} accessibility: ${blocking.map(item => item.id).join(", ")}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
          const screenshot = path.join(directory, `ux-budgets-cockpit-runtime-controls-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await capture("review", review);
        await review.getByRole("button", { name: "Keep current voice runtime", exact: true }).click();
        await review.waitFor({ state: "hidden" }); assert.deepEqual(writes, []);
        await voice.getByRole("button", { name: "Install starter model", exact: true }).click();
        await review.getByRole("button", { name: "Apply reviewed voice action", exact: true }).click();
        await voice.getByRole("alert").filter({ hasText: "voice runtime outcome is uncertain" }).waitFor();
        assert.equal(await voice.getByRole("button", { name: "Install starter model", exact: true }).isDisabled(), true);
        await voice.scrollIntoViewIfNeeded(); await capture("uncertain");
        const pages = page.getByRole("navigation", { name: "Settings pages", exact: true });
        await pages.getByRole("link", { name: "General", exact: true }).click();
        await pages.getByRole("link", { name: "Advanced", exact: true }).click();
        await voice.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        assert.equal(await voice.getByRole("button", { name: "Install starter model", exact: true }).isDisabled(), true);
        await page.getByRole("link", { name: "Voice and runtime diagnostics", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.shell === "classic");
        await page.getByRole("button", { name: "Voice setup", exact: true }).click();
        const classic = page.getByRole("region", { name: "Local voice runtime controls", exact: true });
        await classic.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        assert.equal(await classic.getByRole("button", { name: "Install starter model", exact: true }).isDisabled(), true);
        assert.equal(navigations, navigationBaseline, "Navigation discarded the shared runtime lock.");
        const after = await read("/api/v1/voice/runtime"), daemonAfter = await read("/api/v1/daemon/status");
        assert.equal(writes.length, 1); assert.equal(writes[0].pathname, "/api/v1/voice/runtime/install");
        assertRuntimeControlsBaseline({ before, after, request: writes[0].body, modelId: model.id, writes: intercepted, daemonBefore, daemonAfter });
        return { status: "passed", metrics: { realOwnerReads: true, unsupportedDaemonActionsWithheld: true, explicitCancelNoWrite: true,
          interceptedVoiceWrites: intercepted, forwardedVoiceWrites: 0, liveInstallSettlementExercised: false, microphoneSessionStarted: false,
          nativeAndClassicUnknownLockRetained: true, ownerBaselinePreserved: true, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `ux-budgets-cockpit-runtime-controls-${variant}-failure.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve failure. */ } }
        return { status: "failed", error: String(error?.stack ?? error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
