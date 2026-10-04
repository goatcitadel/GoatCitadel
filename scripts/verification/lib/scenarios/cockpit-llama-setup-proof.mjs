import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { startDeterministicLlmStub } from "./deterministic-llm-stub.mjs";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";
import { buildClassicOwnerUrl } from "./classic-owner-navigation.mjs";

export function assertLlamaPrepared({ plan, request, settings, workspaceId }) {
  assert.equal(plan.origin?.surface, "settings"); assert.equal(plan.origin?.workspaceId, workspaceId);
  assert.equal(plan.origin.sessionId, undefined); assert.equal(plan.origin.turnId, undefined);
  assert.deepEqual(plan.adapter, { adapterId: "runtime-configuration", version: 2 });
  assert.equal(plan.scope, "runtime"); assert.equal(plan.target?.ownerId, "runtime_settings");
  assert.equal(plan.target.resourceId, "llama_cpp_setup"); assert.equal(plan.target.expectedRevision, settings.revision);
  assert.deepEqual(plan.request, request.request); assert.equal(plan.status, "awaiting_confirmation");
  assert.equal(plan.requiredAction?.kind, "confirmation"); assert.ok(plan.requiredAction.actionNonce);
  assert.equal(request.workspaceId, workspaceId); assert.equal(request.surface, "settings");
  assert.equal(request.request.change.managementMode, "external");
  assert.equal(request.request.change.selectionId, undefined); assert.equal(request.request.change.commandPath, undefined);
}
export function assertLlamaAwaitingApproval({ before, after, request, readback }) {
  for (const field of ["planId", "origin", "adapter", "scope", "request", "target", "intentHash", "createdAt"]) assert.deepEqual(after[field], before[field], `Confirmation changed ${field}.`);
  assert.deepEqual(request, { workspaceId: before.origin.workspaceId, expectedRevision: before.revision, actionNonce: before.requiredAction.actionNonce });
  assert.ok(after.revision > before.revision); assert.equal(after.status, "awaiting_approval");
  assert.equal(after.requiredAction?.kind, "approval"); assert.ok(after.requiredAction.approvalId);
  assert.ok(after.approvalRefs.includes(after.requiredAction.approvalId)); assert.deepEqual(readback, after);
}
export function assertLlamaApprovalDestination({ plan, href, replay, approvalWrites }) {
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(plan.requiredAction?.kind, "approval");
  const id = plan.requiredAction.approvalId;
  assert.ok(id && plan.approvalRefs.includes(id));
  assert.equal(href, buildClassicOwnerUrl(`/ops/approvals?approvalId=${encodeURIComponent(id)}&shell=classic`));
  assert.equal(replay.approval.approvalId, id);
  assert.equal(replay.approval.kind, "change_plan_effect");
  assert.equal(replay.approval.status, "pending");
  assert.equal(replay.approval.linkage.workspaceId, plan.origin.workspaceId);
  for (const [key, value] of Object.entries({ planId: plan.planId, kind: plan.kind, scope: plan.scope,
    intentHash: plan.intentHash, targetOwnerId: plan.target.ownerId, targetResourceId: plan.target.resourceId,
    targetRevision: plan.target.expectedRevision, targetHash: plan.target.expectedHash,
    adapterId: plan.adapter.adapterId, adapterVersion: plan.adapter.version })) assert.deepEqual(replay.approval.payload[key], value);
  assert.deepEqual(approvalWrites, [], "Inspection mutated an approval.");
}
export function assertLlamaOwnerUnchanged(before, after) {
  assert.equal(after.revision, before.revision, "Setup review changed runtime configuration.");
  for (const field of ["enabled", "autoStart", "managementMode", "baseUrl", "alias", "command", "modelPath", "modelsRootPath"]) assert.deepEqual(after.llamaCpp[field], before.llamaCpp[field], `Review changed llama.cpp ${field}.`);
  assert.equal(after.llm.activeProviderId, before.llm.activeProviderId); assert.equal(after.llm.activeModel, before.llm.activeModel);
  assert.equal(after.llm.defaultThinkingLevel, before.llm.defaultThinkingLevel);
}

/** Try every exact plan created by this proof even if an earlier cleanup fails. */
export async function cleanupLlamaPlans(planIds, cancel) {
  const errors = [];
  for (const id of new Set(planIds)) {
    try { await cancel(id); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Llama proof plan cleanup failed.");
}

/** Actual loopback catalog and plan owners. No approval is granted, process started, or Chat diagnostic sent. */
export async function runCockpitLlamaSetupProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Llama proof requires a disposable verification runtime.");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, `llama setup owner ${route}`); return response.body; };
  const workspaceId = "default";
  const readPlan = id => api(`/api/v1/change-plans/${encodeURIComponent(id)}?workspaceId=${workspaceId}`);
  const cancel = async id => {
    const current = await readPlan(id);
    if (["awaiting_confirmation", "awaiting_approval"].includes(current.status)) {
      const result = await api(`/api/v1/change-plans/${encodeURIComponent(id)}/cancellations`, { method: "POST", body: { workspaceId, expectedRevision: current.revision, actionNonce: current.requiredAction.actionNonce } });
      assert.equal(result.planId, id); assert.equal(result.status, "cancelled");
    }
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-llama-setup.${variant}`, lane: "ux-budgets",
      title: `Native llama.cpp plan review, stale owner and retained uncertainty ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await api("/api/v1/settings");
      assert.equal(before.llamaCpp.enabled, false, "This plan-only proof requires disabled local inference.");
      assert.equal(before.llamaCpp.autoStart, false, "This plan-only proof cannot own an autostart process.");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [], diagnostics = [], plans = [], writes = [], approvalWrites = [];
      let page, stub, abortCreate = false, intercepted = 0;
      try {
        stub = await startDeterministicLlmStub({ model: `llama-review-${variant}` });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /^\/api\/v1\/approvals(\/|$)/.test(pathname))
            approvalWrites.push({ pathname, method: request.method(), body: request.postDataJSON() });
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && /^\/api\/v1\/(change-plans|llamacpp)(\/|$)/.test(pathname)) writes.push({ pathname, body: request.postDataJSON() });
        });
        await page.route("**/api/v1/change-plans", async route => {
          if (abortCreate && route.request().method() === "POST") { intercepted++; await route.abort("failed"); }
          else await route.continue();
        });
        // An accidental diagnostic is always stopped before forwarding and fails the proof below.
        await page.route("**/api/v1/llamacpp/setup/chat-test", route => route.abort("failed"));
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/advanced?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.locator("#llamacpp-setup");
        const url = panel.getByRole("textbox", { name: "Server URL", exact: true });
        await url.waitFor(); await panel.getByRole("radio", { name: "Use a running server", exact: true }).check();
        await url.fill(stub.baseUrl);
        const check = panel.getByRole("button", { name: "Check server", exact: true });
        await check.waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll("#llamacpp-setup button")].some(button => button.textContent.trim() === "Check server" && !button.disabled));
        await check.click();
        const model = `llama-review-${variant}`;
        await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).selectOption(model);
        const finish = panel.getByRole("button", { name: "Finish setup", exact: true });
        const prepareDialog = page.getByRole("dialog", { name: "Prepare llama.cpp setup?", exact: true });
        const confirmDialog = page.getByRole("dialog", { name: "Confirm the recorded llama.cpp setup?", exact: true });
        await finish.click(); await prepareDialog.waitFor();
        assert.ok((await prepareDialog.innerText()).includes(model)); assert.ok((await prepareDialog.innerText()).includes(stub.baseUrl));
        assert.deepEqual(writes, []);
        await page.addScriptTag({ path: axeSourcePath });
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const capture = async (stage, dialog, confirmLabel) => {
          if (dialog) { const buttons = {}; for (const label of [confirmLabel, "Keep current llama.cpp setup"]) buttons[label] = await dialog.getByRole("button", { name: label, exact: true }).boundingBox();
            assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons }); }
          const audit = await auditPageAccessibility(page); const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Llama ${stage} accessibility: ${blocking.map(item => item.id).join(", ")}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-llama-setup-${variant}-${stage}.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await capture("review", prepareDialog, "Prepare reviewed setup");
        await prepareDialog.getByRole("button", { name: "Keep current llama.cpp setup", exact: true }).click();
        assert.deepEqual(writes, []);
        const prepare = async () => {
          await finish.click();
          const [response] = await Promise.all([
            page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans"),
            prepareDialog.getByRole("button", { name: "Prepare reviewed setup", exact: true }).click(),
          ]);
          assert.ok(response.ok()); const plan = await response.json(); plans.push(plan.planId);
          assertLlamaPrepared({ plan, request: response.request().postDataJSON(), settings: before, workspaceId });
          assert.deepEqual(await readPlan(plan.planId), plan);
          await panel.getByRole("button", { name: "Review recorded setup", exact: true }).waitFor();
          return plan;
        };
        const stale = await prepare(); await panel.getByRole("button", { name: "Review recorded setup", exact: true }).click(); await confirmDialog.waitFor();
        await cancel(stale.planId);
        await confirmDialog.getByRole("button", { name: "Confirm reviewed setup plan", exact: true }).click();
        await panel.getByText("The setup plan or settings revision changed. Refresh and review again.", { exact: true }).waitFor();
        assert.equal(writes.filter(item => item.pathname.endsWith("/confirmations")).length, 0, "Stale review dispatched confirmation.");
        await panel.getByRole("button", { name: "Refresh setup evidence", exact: true }).click();
        await panel.getByRole("heading", { name: "Cancelled", exact: true }).waitFor();
        const prepared = await prepare(); await panel.getByRole("button", { name: "Review recorded setup", exact: true }).click(); await confirmDialog.waitFor();
        await capture("canonical-review", confirmDialog, "Confirm reviewed setup plan");
        const [response] = await Promise.all([
          page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/change-plans/${prepared.planId}/confirmations`),
          confirmDialog.getByRole("button", { name: "Confirm reviewed setup plan", exact: true }).click(),
        ]);
        assert.ok(response.ok()); const waiting = await response.json();
        assertLlamaAwaitingApproval({ before: prepared, after: waiting, request: response.request().postDataJSON(), readback: await readPlan(prepared.planId) });
        await panel.getByRole("heading", { name: "Awaiting approval", exact: true }).waitFor();
        await panel.getByRole("button", { name: "Continue approved setup", exact: true }).click();
        await panel.getByText("The approval is not approved yet. Review the required approval first.", { exact: true }).waitFor();
        assert.equal(writes.filter(item => item.pathname.endsWith("/responses")).length, 0, "Pending approval was bypassed.");
        await panel.scrollIntoViewIfNeeded(); await capture("awaiting-approval");
        const exactApproval = waiting.requiredAction.approvalId;
        const approvalLink = panel.getByRole("link", { name: "Open approval details", exact: true });
        const href = await approvalLink.getAttribute("href");
        const replayPath = `/api/v1/approvals/${encodeURIComponent(exactApproval)}/replay`;
        assertLlamaApprovalDestination({ plan: waiting, href, replay: await api(replayPath), approvalWrites });
        const documentMarker = `llama-approval-${variant}-${prepared.planId}`;
        await page.evaluate(value => { window.__llamaApprovalDocument = value; }, documentMarker);
        const sourceUrl = page.url();
        const beforeOwnerHandoff = writes.length;
        const reviewSetupNavigation = async (trigger, decision) => {
          const priorUrl = page.url(), priorWrites = writes.length;
          await trigger();
          const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
          await leave.waitFor();
          assert.equal(await leave.count(), 1);
          assert.equal(page.url(), priorUrl, "Setup navigation preceded the draft decision.");
          await leave.getByText("You have unsaved changes in llama.cpp setup.", { exact: true }).waitFor();
          await leave.getByRole("button", { name: decision, exact: true }).click();
          await leave.waitFor({ state: "hidden" });
          if (decision === "Cancel") assert.equal(page.url(), priorUrl, "Canceled setup navigation changed its URL.");
          assert.equal(writes.length, priorWrites, "Setup navigation dispatched an extra owner mutation.");
        };
        await reviewSetupNavigation(() => approvalLink.click(), "Cancel");
        assert.equal(await url.inputValue(), stub.baseUrl);
        assert.equal(await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).inputValue(), model);
        await reviewSetupNavigation(() => approvalLink.click(), "Keep draft and close");
        await page.waitForURL(value => value.pathname === "/ops/approvals"
          && value.searchParams.get("approvalId") === exactApproval && value.searchParams.get("shell") === "classic");
        await page.getByRole("heading", { name: "Approvals", exact: true }).waitFor();
        await page.getByText("Replay trail and pending action", { exact: true }).click();
        const replayWait = page.waitForResponse(result => result.request().method() === "GET" && new URL(result.url()).pathname === replayPath);
        void replayWait.catch(() => {});
        await page.getByRole("button", { name: "Load replay trail", exact: true }).click();
        const replayHttp = await replayWait;
        assert.equal(replayHttp.status(), 200);
        assertLlamaApprovalDestination({ plan: waiting, href, replay: await replayHttp.json(), approvalWrites });
        assert.equal(await page.evaluate(() => window.__llamaApprovalDocument), documentMarker, "Approval handoff reloaded the document.");
        assert.equal(writes.length, beforeOwnerHandoff, "Approval inspection changed the setup owner.");
        const approvalScreenshot = path.join(screenshotDir, `ux-budgets-cockpit-llama-setup-${variant}-exact-approval-owner.png`);
        await page.screenshot({ path: approvalScreenshot, fullPage: false }); screenshots.push(relativeToRun(context, approvalScreenshot));
        // Shell switches deliberately replace the history entry. Return through the actual UI;
        // native within-shell Back behavior is proved separately by the navigation journeys.
        const approvalDetails = page.locator('[data-inspector-owner="feature"]').filter({
          has: page.getByRole("heading", { name: "change_plan_effect", exact: true }),
        });
        assert.equal(await approvalDetails.count(), 1, "Return must close the exact inspected approval pane.");
        await approvalDetails.getByRole("button", { name: "Close details", exact: true }).click();
        await approvalDetails.waitFor({ state: "hidden" });
        assert.deepEqual(approvalWrites, [], "Closing approval details changed an approval.");
        if (variant === "mobile") await page.getByRole("button", { name: "Open navigation", exact: true }).click();
        await page.getByRole("navigation", { name: "Primary mission areas", exact: true })
          .getByRole("button", { name: "Settings", exact: true }).click();
        await page.waitForURL(value => value.pathname === "/settings/general");
        const navigation = page.getByRole("dialog", { name: "Navigation", exact: true });
        if (await navigation.isVisible()) await navigation.getByRole("button", { name: "Close navigation", exact: true }).click();
        await navigation.waitFor({ state: "hidden" });
        // This Classic button is inside a wrapping SettingsField label; its accessible name includes that field.
        const returnToCockpit = page.locator("label.mc-next-settings-field").filter({
          has: page.getByText("New Mission Control (preview)", { exact: true }),
        }).getByRole("button").filter({ hasText: /^Try the new Mission Control$/u });
        await returnToCockpit.waitFor();
        assert.equal(await returnToCockpit.count(), 1, "Return requires the exact visible interface-switch control.");
        await returnToCockpit.click();
        await page.waitForFunction(() => document.documentElement.dataset.shell === "cockpit");
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await page.getByRole("navigation", { name: "Settings pages", exact: true })
          .getByRole("link", { name: "Advanced", exact: true }).click();
        await page.waitForURL(sourceUrl);
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        assert.equal(await page.evaluate(() => window.__llamaApprovalDocument), documentMarker, "Return from approval owner reloaded the document.");
        assert.equal(await url.inputValue(), stub.baseUrl, "Approval return lost the exact setup endpoint draft.");
        assert.equal(await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).inputValue(), model);
        assert.equal(writes.length, beforeOwnerHandoff, "Approval inspection or explicit return dispatched an extra owner mutation.");
        assert.deepEqual(await readPlan(waiting.planId), waiting, "Approval inspection changed the pending plan.");
        assert.deepEqual(approvalWrites, []);
        // The returned editor must finish its current owner read before this deliberate cancellation.
        await panel.getByText("Loading setup evidence…", { exact: true }).waitFor({ state: "hidden" });
        await cancel(prepared.planId);
        const cancelled = await readPlan(prepared.planId);
        const setupWait = page.waitForResponse(result => result.request().method() === "GET"
          && new URL(result.url()).pathname === "/api/v1/llamacpp/setup"
          && new URL(result.url()).searchParams.get("workspaceId") === workspaceId);
        void setupWait.catch(() => {});
        await panel.getByRole("button", { name: "Refresh setup evidence", exact: true }).click();
        const setupResponse = await setupWait, setupProjection = await setupResponse.json();
        const setupDiagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-llama-setup-${variant}-cancellation-projection.json`);
        await mkdir(path.dirname(setupDiagnostic), { recursive: true });
        await writeFile(setupDiagnostic, JSON.stringify({ request: { method: setupResponse.request().method(), url: setupResponse.url() },
          status: setupResponse.status(), projection: setupProjection, cancelledPlan: { planId: cancelled.planId, revision: cancelled.revision, status: cancelled.status } }, null, 2));
        diagnostics.push(relativeToRun(context, setupDiagnostic));
        assert.equal(setupResponse.status(), 200);
        assert.equal(setupProjection.pendingPlan, undefined, "Fresh setup projection still reports pending work.");
        assert.equal(setupProjection.recentPlan?.planId, cancelled.planId);
        assert.equal(setupProjection.recentPlan?.revision, cancelled.revision);
        assert.equal(setupProjection.recentPlan?.status, "cancelled");
        await panel.getByText("Loading setup evidence…", { exact: true }).waitFor({ state: "hidden" });
        await panel.getByRole("heading", { name: "Cancelled", exact: true }).waitFor();
        // The retained choice is input, not fresh catalog authority after the shell remount.
        // Recheck the same endpoint explicitly before preparing a new plan; never reselect the model.
        assert.equal(await finish.isDisabled(), true, "A retained model became callable without current catalog evidence.");
        const beforeCatalogRecheck = writes.length;
        await check.click();
        await page.waitForFunction(() => [...document.querySelectorAll("#llamacpp-setup button")]
          .some(button => button.textContent.trim() === "Finish setup" && !button.disabled));
        assert.equal(await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).inputValue(), model);
        assert.equal(writes.length, beforeCatalogRecheck, "Catalog revalidation dispatched a setup mutation.");
        assert.deepEqual(approvalWrites, []);
        abortCreate = true; await finish.click(); await prepareDialog.getByRole("button", { name: "Prepare reviewed setup", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        const pages = page.getByRole("navigation", { name: "Settings pages", exact: true });
        const beforeUncertainNavigation = writes.length;
        const openGeneral = () => pages.getByRole("link", { name: "General", exact: true }).click();
        await reviewSetupNavigation(openGeneral, "Cancel");
        assert.equal(await url.inputValue(), stub.baseUrl);
        assert.equal(await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).inputValue(), model);
        await reviewSetupNavigation(openGeneral, "Keep draft and close");
        await page.waitForURL(value => value.pathname === "/settings/general");
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await pages.getByRole("link", { name: "Advanced", exact: true }).click();
        await page.waitForURL(value => value.pathname === "/settings/advanced");
        await panel.getByRole("alert").filter({ hasText: "outcome is uncertain" }).waitFor();
        assert.equal(await url.inputValue(), stub.baseUrl);
        assert.equal(await panel.getByRole("combobox", { name: "Model for Chat", exact: true }).inputValue(), model);
        assert.equal(await page.evaluate(() => window.__llamaApprovalDocument), documentMarker, "Uncertain setup navigation reloaded the document.");
        assert.equal(writes.length, beforeUncertainNavigation, "Uncertain setup navigation retried a mutation.");
        assert.equal(await panel.getByRole("button", { name: "Finish setup", exact: true }).isDisabled(), true);
        await panel.scrollIntoViewIfNeeded(); await capture("uncertain");
        assert.equal(intercepted, 1); assert.equal(writes.filter(item => item.pathname === "/api/v1/change-plans").length, 3);
        assert.equal(writes.filter(item => item.pathname.startsWith("/api/v1/llamacpp")).length, 0, "A model or diagnostic action was dispatched.");
        assert.equal(stub.completionDispatches(), 0, "Setup review invoked model inference."); assert.equal(stub.imageGenerationDispatches(), 0);
        assertLlamaOwnerUnchanged(before, await api("/api/v1/settings"));
        return { status: "passed", metrics: { actualLoopbackCatalog: true, actualPreparedPlans: 2, actualConfirmations: 1,
          staleConfirmationWrites: 0, exactApprovalOwnerHandoff: true, sameDocumentApprovalReturn: true, retainedModelDisplayedBeforeRevalidation: true, explicitCatalogRevalidation: true, approvalReturnMethod: "explicit UI shell switch", crossShellBrowserBackExercised: false, approvalWrites: approvalWrites.length, approvalGranted: false, pendingApprovalResumeWithheld: true, configurationChanged: false,
          managedSelectionExercised: false, modelProcessStarted: false, chatDiagnosticDispatched: false,
          interceptedCreates: intercepted, uncertaintyRetainedAcrossRemount: true, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true }); const screenshot = path.join(directory, `ux-budgets-cockpit-llama-setup-${variant}-failure.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve original error. */ } }
        return { status: "failed", error: String(error?.stack ?? error), artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally {
        try { await browserContext.close(); }
        finally {
          try { await cleanupLlamaPlans(plans, cancel); }
          finally { await stub?.close(); }
        }
      }
    });
  }
}
