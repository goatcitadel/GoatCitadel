import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createReviewedMutationRecorder } from "./cockpit-reviewed-mutations.mjs";

const RULE_LABELS = { approve_all: "Ask every time", approve_risky: "Ask for risky work", bypass: "Skip normal prompts" };
export function assertApprovedDecisionReceipt({ approvalId, decision, rendered, recordHref }) {
  assert.ok(approvalId, "The expected canonical approval identity is required.");
  assert.equal(decision.approval?.approvalId, approvalId);
  assert.equal(decision.approval?.status, "approved");
  const followOnMessages = ["Follow-on action is blocked by policy.",
    "Follow-on work failed. Inspect the persisted outcome before retrying.", "Follow-on settlement is pending.",
    "Approval effects settled. Linked work has its own execution outcome.", "Follow-on execution needs separate verification."];
  assert.ok(followOnMessages.some(message => rendered === `Decision recorded: approved. ${message}`),
    "The native settlement must retain the approved decision and separate follow-on outcome.");
  // ApprovalSettlement and its compatibility adapter emit root-relative owner links.
  // Validate raw form before URL parsing can normalize authority, slashes or controls.
  assert.equal(typeof recordHref, "string");
  assert.match(recordHref, /^\/ops\/approvals(?:[?#]|$)/, "The settlement link must be a relative canonical owner destination.");
  assert.ok(!/[\u0000-\u0020\u007f\\]/.test(recordHref), "The settlement link must not contain ambiguous URL characters.");
  const owner = new URL(recordHref, "http://verification.invalid");
  assert.equal(owner.pathname, "/ops/approvals");
  assert.deepEqual(owner.searchParams.getAll("approvalId"), [approvalId], "The settlement link must identify exactly one canonical approval.");
}
export function assertApprovalModeBypassReview(rendered, revision) {
  for (const consequence of [`settings revision ${revision}`, "Allowed tools may run without normal prompts.",
    "Deny rules, Critical risk and risky-shell approvals, read boundaries, and tool grants remain in force."])
    assert.ok(rendered.includes(consequence), `Missing reviewed consequence: ${consequence}`);
}
export function assertApprovalModeInspection({ before, after, rendered, mutations }) {
  assert.ok(Object.hasOwn(RULE_LABELS, before?.toolApprovalMode), "The owner approval rule is unavailable.");
  assert.ok(Number.isSafeInteger(before.revision) && before.revision > 0, "The owner settings revision is unavailable.");
  assert.equal(rendered.current, `Current: ${RULE_LABELS[before.toolApprovalMode]} · settings revision ${before.revision}`);
  assert.equal(rendered.selection, before.toolApprovalMode, "The editor did not return to the saved owner rule.");
  assert.equal(after?.toolApprovalMode, before.toolApprovalMode, "Inspection changed the global approval rule.");
  assert.equal(after?.deploymentProfile, before.deploymentProfile, "Inspection changed the deployment profile.");
  assert.equal(after?.revision, before.revision, "Inspection changed the settings revision.");
  assert.deepEqual(mutations, [], "Review or cancellation issued a governed mutation.");
}

export function assertInboxToastOwnerBinding({ item, title, reads, signal }) {
  assert.equal(signal.afterReady, true);
  assert.equal(signal.links?.approvalId, item.source.approvalId);
  assert.ok(reads.some((read) => read.status === 200 && read.startedAt >= signal.observedAt
    && read.authority === "derived_projection" && read.workspaceId === item.source.workspaceId
    && read.approvals?.some((approval) => approval.id === item.id && approval.source.approvalId === item.source.approvalId
      && approval.source.workspaceId === item.source.workspaceId && approval.title === title)),
  "Toast title must come from a scoped current-owner read begun after its live signal.");
}

export function assertInboxChangeBinding({ source, derived }) {
  assert.equal(derived.afterReady, true);
  assert.equal(derived.eventType, "inbox.changed");
  assert.equal(derived.source, "operator_inbox");
  assert.equal(derived.eventClass, "operational_signal");
  assert.equal(derived.eventAuthority, "retained_stream");
  assert.deepEqual(derived.payload, { sourceEventId: source.eventId, deliveryId: `inbox.changed:${source.eventId}`, family: "approvals",
    scope: source.links?.workspaceId ? "workspace" : "all_workspaces" });
  assert.deepEqual(derived.links ?? {}, source.links?.workspaceId ? { workspaceId: source.links.workspaceId } : {});
  assert.equal(derived.timestamp, source.timestamp);
}

/** Real owner reads, a failed-read fixture, then one reviewed save through its canonical approval. */
export async function runCockpitApprovalModeProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Approval proof requires an isolated verification runtime.");
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-approval-mode.${variant}`, lane: "ux-budgets",
      title: `Cockpit approval rule review, failed-read guard, and approved save ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await requestJson(stack.gatewayUrl, "/api/v1/settings");
      assertOk(before, "read approval settings owner");
      assert.ok(["approve_all", "approve_risky"].includes(before.body?.toolApprovalMode), "The shipped fixture must begin with normal approval prompts enabled.");
      assert.ok(["local_dev", "trusted_local"].includes(before.body?.deploymentProfile), "Bypass cancellation proof requires the local verification profile.");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page, approvalPage;
      let releaseHeldInboxRead = () => {};
      const screenshots = [];
      const settingsTraffic = [];
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        const mutations = [], traffic = createReviewedMutationRecorder();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname === "/api/v1/settings") settingsTraffic.push({ at: Date.now(), kind: "request", method: request.method() });
          const beforeCount = traffic.writes.length;
          traffic.record(request);
          if (traffic.writes.length !== beforeCount) mutations.push(`${request.method()} ${pathname}`);
        });
        page.on("response", (response) => {
          if (new URL(response.url()).pathname === "/api/v1/settings") settingsTraffic.push({ at: Date.now(), kind: "response",
            method: response.request().method(), status: response.status() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#approval-mode"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        const panel = page.getByRole("region", { name: "Tool approval rule", exact: true });
        const select = panel.getByRole("combobox", { name: /^Approval rule(?:\s|$)/ });
        await select.waitFor();
        const ownerText = `Current: ${RULE_LABELS[before.body.toolApprovalMode]} · settings revision ${before.body.revision}`;
        await panel.getByText(ownerText, { exact: true }).waitFor();
        assert.equal(await select.inputValue(), before.body.toolApprovalMode);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (stage, target = page) => {
          const axe = await auditPageAccessibility(target);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(blocking.length, 0, `Approval ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          assert.ok(overflow <= 1, `Approval ${stage} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-approval-mode-${variant}-${stage}.png`);
          await target.screenshot({ path: screenshot, fullPage: false });
          screenshots.push(relativeToRun(context, screenshot));
          return overflow;
        };
        await select.selectOption("bypass");
        const reviewSkipping = panel.getByRole("button", { name: "Review prompt skipping", exact: true });
        await reviewSkipping.scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        assert.equal(await select.inputValue(), "bypass");
        await panel.getByText(ownerText, { exact: true }).waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll("#approval-mode button")]
          .some(button => button.textContent === "Review prompt skipping" && !button.disabled), undefined, { timeout: 30_000 });
        assert.equal(await reviewSkipping.isEnabled(), true, "The current approval draft must be ready before its reviewed click.");
        await reviewSkipping.click();
        const dialog = page.getByRole("dialog", { name: "Skip normal tool prompts?", exact: true });
        await dialog.waitFor();
        assertApprovalModeBypassReview(await dialog.innerText(), before.body.revision);
        assert.deepEqual(mutations, [], "Opening dangerous review mutated the owner.");
        await audit("bypass-review");
        await dialog.getByRole("button", { name: "Keep current rule", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await traffic.assertPageBackground(page, "default");
        assert.deepEqual(mutations, [], "Cancelling bypass mutated the owner.");

        const draftMode = before.body.toolApprovalMode === "approve_all" ? "approve_risky" : "approve_all";
        await select.selectOption(draftMode);
        let failedReads = 0;
        const failedRead = async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          failedReads += 1;
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Verification fixture: approval settings read unavailable" }) });
        };
        // Deliberately fail only this browser's read. The live Gateway owner remains unchanged.
        await page.route("**/api/v1/settings", failedRead);
        await panel.getByRole("button", { name: "Refresh approval settings", exact: true }).click();
        await panel.getByRole("alert").waitFor({ timeout: 30_000 });
        assert.equal(await select.count(), 0, "Cached owner data remained editable after refresh failed.");
        assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).count(), 0);
        assert.ok(failedReads > 0, "The unavailable-read fixture was not exercised.");
        assert.deepEqual(mutations, [], "A stale read initiated a settings mutation.");
        await panel.scrollIntoViewIfNeeded();
        await audit("owner-unavailable");
        await page.unroute("**/api/v1/settings", failedRead);
        const recovered = page.waitForResponse((response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === "/api/v1/settings" && response.status() === 200);
        await panel.getByRole("button", { name: "Refresh approval settings", exact: true }).click();
        await recovered; await select.waitFor();
        assert.equal(await select.inputValue(), draftMode, "Failed refresh discarded the unsaved rule draft.");
        await panel.getByText(ownerText, { exact: true }).waitFor();
        await select.selectOption(before.body.toolApprovalMode);
        assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).isDisabled(), true);
        const after = await requestJson(stack.gatewayUrl, "/api/v1/settings");
        assertOk(after, "read approval owner after review");
        assertApprovalModeInspection({ before: before.body, after: after.body, mutations,
          rendered: { current: await panel.getByText(/^Current:/).innerText(), selection: await select.inputValue() } });
        await panel.scrollIntoViewIfNeeded();
        const overflow = await audit("recovered");
        approvalPage = await browserContext.newPage();
        const approvalTraffic = createReviewedMutationRecorder();
        approvalPage.on("request", request => approvalTraffic.record(request));
        const stream = await browserContext.newCDPSession(approvalPage);
        await stream.send("Network.enable");
        let streamReady = false;
        const signals = [];
        const inboxReads = [];
        const requestStarts = new WeakMap();
        approvalPage.on("request", (request) => { requestStarts.set(request, Date.now()); });
        approvalPage.on("response", async (response) => {
          if (new URL(response.url()).pathname !== "/api/v1/inbox") return;
          try {
            const body = await response.json();
            inboxReads.push({ status: response.status(), startedAt: requestStarts.get(response.request()), completedAt: Date.now(),
              authority: body.authority, workspaceId: body.workspaceId,
              approvals: body.items?.filter((entry) => entry.kind === "approval").map((entry) => ({ id: entry.id, title: entry.title, source: entry.source })) });
          } catch { /* Diagnostic evidence must not affect the journey. */ }
        });
        stream.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
          if (eventName === "stream-ready") streamReady = true;
          if (eventName !== "message") return;
          try {
            const event = JSON.parse(data);
            if (event.eventType?.includes("approval") || event.eventType === "inbox.changed") signals.push({ observedAt: Date.now(), eventId: event.eventId,
              timestamp: event.timestamp, source: event.source, payload: event.payload, eventType: event.eventType, eventClass: event.eventClass,
              eventAuthority: event.eventAuthority, links: event.links, afterReady: streamReady });
          } catch { /* Ignore unrelated non-JSON stream frames. */ }
        });
        await approvalPage.addInitScript(() => {
          window.__cockpitNotificationObservations = [];
          let last = "";
          new window.MutationObserver(() => {
            const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((toast) => ({
              title: toast.querySelector("[data-title]")?.textContent, text: toast.textContent,
              visible: toast.getAttribute("data-visible"), removed: toast.getAttribute("data-removed"),
            }));
            const value = JSON.stringify(toasts);
            if (value === last) return;
            last = value;
            window.__cockpitNotificationObservations.push({ at: Date.now(), toasts });
            if (window.__cockpitNotificationObservations.length > 20) window.__cockpitNotificationObservations.shift();
          }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-visible", "data-removed"] });
        });
        // Hold one authentic owner snapshot captured before the approval. The live
        // notification must dispatch its own read, not share this pending HTTP GET.
        let heldInboxRead = false, heldInboxReady = false;
        const heldInboxGate = new Promise((resolve) => { releaseHeldInboxRead = resolve; });
        await approvalPage.route("**/api/v1/inbox?workspaceId=default", async (route) => {
          if (heldInboxRead || route.request().method() !== "GET") return route.continue();
          heldInboxRead = true;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          heldInboxReady = true;
          await heldInboxGate;
          if (!approvalPage.isClosed()) await route.fulfill({ response });
        });
        await approvalPage.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await approvalPage.waitForSelector('[data-cockpit-ready="true"]');
        for (let attempt = 0; (!streamReady || !heldInboxReady) && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(streamReady, true, "The notification observer must finish replay before the live approval is created.");
        assert.equal(heldInboxReady, true, "The pre-event owner snapshot must be captured before creating the approval.");
        await approvalPage.evaluate(() => { document.documentElement.dataset.inboxNavigationProof = "same-document"; });
        await page.bringToFront();
        await select.selectOption(draftMode);
        await panel.getByText("Unsaved approval rule draft", { exact: true }).waitFor();
        await page.waitForFunction((mode) => {
          const region = document.getElementById("approval-mode");
          const buttons = [...(region?.querySelectorAll("button") ?? [])];
          return region?.querySelector("select")?.value === mode
            && buttons.some((button) => button.textContent === "Save approval rule" && !button.disabled)
            && buttons.some((button) => button.textContent === "Refresh approval settings" && !button.disabled);
        }, draftMode);
        await page.evaluate(() => {
          window.__cockpitApprovalClicks = [];
          for (const type of ["pointerdown", "click"]) document.addEventListener(type, (event) => {
            const button = event.target instanceof window.Element ? event.target.closest("#approval-mode button") : null;
            if (button?.textContent !== "Save approval rule") return;
            window.__cockpitApprovalClicks.push({ at: Date.now(), type, disabled: button.disabled,
              focus: document.hasFocus(), visibility: document.visibilityState, value: document.querySelector("#approval-mode select")?.value });
          }, true);
        });
        const submittedResponse = page.waitForResponse((response) => response.request().method() === "PATCH"
          && new URL(response.url()).pathname === "/api/v1/settings").then((response) => ({ response }), (error) => ({ error }));
        await panel.getByRole("button", { name: "Save approval rule", exact: true }).click();
        const submission = await submittedResponse;
        if (submission.error) throw new Error(`Approval Save did not return a PATCH. Panel: ${await panel.innerText()}. Clicks: ${JSON.stringify(await page.evaluate(() => window.__cockpitApprovalClicks))}. Settings traffic: ${JSON.stringify(settingsTraffic)}. ${submission.error.message}`, { cause: submission.error });
        const submittedHttp = submission.response;
        releaseHeldInboxRead();
        assert.equal(submittedHttp.status(), 200);
        assert.deepEqual(submittedHttp.request().postDataJSON(), { expectedRevision: after.body.revision, toolApprovalMode: draftMode });
        const submitted = await submittedHttp.json();
        const receipt = submitted.changePlanReceipt;
        assert.equal(receipt?.status, "awaiting_approval", "A caution change must wait for its canonical approval.");
        assert.equal(receipt?.requiredAction?.kind, "approval");
        assert.ok(receipt.requiredAction.approvalId);
        assert.equal(submitted.toolApprovalMode, after.body.toolApprovalMode, "Unapproved save changed the default rule.");
        assert.equal(submitted.revision, after.body.revision);
        const approvalId = receipt.requiredAction.approvalId;
        const projection = await requestJson(stack.gatewayUrl, "/api/v1/inbox?workspaceId=default");
        assertOk(projection, "read pending rule approval Inbox");
        const item = projection.body.items.find((entry) => entry.kind === "approval" && entry.source.approvalId === approvalId);
        assert.equal(item?.source.workspaceId, "default");
        const approvalSignal = signals.find((signal) => signal.afterReady && signal.eventType === "approval_created" && signal.links?.approvalId === approvalId);
        assert.ok(approvalSignal,
          `No live approval signal matched the owner: ${JSON.stringify(signals)}`);
        let inboxChange;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          inboxChange = signals.find((signal) => signal.afterReady && signal.eventType === "inbox.changed" && signal.payload?.sourceEventId === approvalSignal.eventId);
          if (inboxChange) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(inboxChange, `No retained Inbox invalidation matched its approval source: ${JSON.stringify(signals)}`);
        assertInboxChangeBinding({ source: approvalSignal, derived: inboxChange });
        await approvalPage.bringToFront();
        const attention = approvalPage.locator("[data-sonner-toast]").filter({ has: approvalPage.getByRole("button", { name: "Open Inbox item", exact: true }) });
        try {
          await attention.waitFor({ timeout: 10_000 });
          const toastTitle = await attention.locator("[data-title]").innerText();
          assertInboxToastOwnerBinding({ item, title: toastTitle, reads: inboxReads, signal: approvalSignal });
          await attention.getByRole("button", { name: "Open Inbox item", exact: true }).click({ timeout: 10_000 });
        } catch (cause) {
          const observations = await approvalPage.evaluate(() => window.__cockpitNotificationObservations);
          throw new Error(`Current Inbox notification unavailable. Owner binding: ${JSON.stringify(item.source)}. Signals: ${JSON.stringify(signals)}. Inbox reads: ${JSON.stringify(inboxReads)}. Toast observations: ${JSON.stringify(observations)}. Cause: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        const linkedLocation = new URL(approvalPage.url());
        assert.equal(linkedLocation.pathname, "/inbox");
        assert.equal(linkedLocation.searchParams.get("workspaceId"), "default");
        assert.equal(linkedLocation.searchParams.get("item"), item.id);
        assert.equal(await approvalPage.evaluate(() => document.documentElement.dataset.inboxNavigationProof), "same-document");
        const inspector = approvalPage.getByLabel(`Inspector: ${item.title}`, { exact: true });
        await inspector.getByRole("button", { name: "Approve once", exact: true }).waitFor();
        // Follow the live toast before its normal six-second display expires.
        // The pending-plan review below must not consume that attention window.
        await panel.getByText("The draft remains unsaved until the Gateway confirms the change.", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
        const continueChange = panel.getByRole("button", { name: "Continue approved change", exact: true });
        await continueChange.click();
        await panel.getByText("The approval is not approved yet. Review the required approval first.", { exact: true }).waitFor();
        assert.deepEqual(mutations, ["PATCH /api/v1/settings"], "An unapproved change attempted to resume.");
        await audit("pending");
        await approvalPage.addScriptTag({ path: axeSourcePath });
        await audit("decision-review", approvalPage);
        const decisionResponse = approvalPage.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === `/api/v1/approvals/${approvalId}/resolve`);
        await inspector.getByRole("button", { name: "Approve once", exact: true }).click();
        const decisionHttp = await decisionResponse;
        assert.equal(decisionHttp.status(), 200);
        const decision = await decisionHttp.json();
        assert.equal(decision.approval?.approvalId, approvalId);
        assert.equal(decision.approval?.status, "approved");
        const settlement = inspector.getByRole("region", { name: "Decision and follow-on work", exact: true });
        const decisionStatus = settlement.getByRole("status").filter({ hasText: /^Decision recorded: approved\./ });
        await decisionStatus.waitFor();
        assertApprovedDecisionReceipt({ approvalId, decision, rendered: await decisionStatus.innerText(),
          recordHref: await settlement.getByRole("link", { name: "Inspect decision and execution record", exact: true }).getAttribute("href") });
        const ready = await requestJson(stack.gatewayUrl, `/api/v1/change-plans/${receipt.planId}?workspaceId=default`);
        assertOk(ready, "read approved change before explicit continuation");
        assert.equal(ready.body.status, "awaiting_approval", "This setting must retain explicit continuation after approval.");
        assert.equal(ready.body.requiredAction?.approvalId, approvalId);
        await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
        const resumedResponse = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === `/api/v1/change-plans/${receipt.planId}/responses`);
        await continueChange.click();
        const resumedHttp = await resumedResponse;
        assert.equal(resumedHttp.status(), 200);
        const resumeRequest = resumedHttp.request().postDataJSON();
        assert.equal(resumeRequest.workspaceId, "default");
        assert.equal(resumeRequest.expectedRevision, ready.body.revision);
        assert.equal(resumeRequest.actionId, ready.body.requiredAction.actionId);
        assert.equal(resumeRequest.actionNonce, ready.body.requiredAction.actionNonce);
        assert.deepEqual(resumeRequest.values, {});
        let completed;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const result = await requestJson(stack.gatewayUrl, `/api/v1/change-plans/${receipt.planId}?workspaceId=default`);
          assertOk(result, "read rule change settlement"); completed = result.body;
          if (["completed", "applied"].includes(completed.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.ok(["completed", "applied"].includes(completed?.status), "The approved rule plan did not complete.");
        assert.equal(completed.origin?.workspaceId, "default");
        assert.deepEqual(completed.request, { kind: "runtime_configuration", change: { operation: "tool_approval_mode", mode: draftMode } });
        assert.equal(completed.target?.expectedRevision, after.body.revision);
        const saved = await requestJson(stack.gatewayUrl, "/api/v1/settings");
        assertOk(saved, "read approved rule owner");
        assert.equal(saved.body.toolApprovalMode, draftMode);
        assert.equal(saved.body.deploymentProfile, before.body.deploymentProfile);
        assert.ok(saved.body.revision > after.body.revision);
        await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
        await panel.getByText("Change saved and confirmed.", { exact: false }).waitFor();
        await panel.getByText(`Current: ${RULE_LABELS[draftMode]} · settings revision ${saved.body.revision}`, { exact: true }).waitFor();
        assert.equal(await select.inputValue(), draftMode);
        assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).isDisabled(), true);
        assert.deepEqual(mutations, ["PATCH /api/v1/settings", `POST /api/v1/change-plans/${receipt.planId}/responses`]);
        await panel.scrollIntoViewIfNeeded(); await audit("saved");
        await traffic.assertPageBackground(page, "default");
        await approvalTraffic.assertPageBackground(approvalPage, "default");
        assert.deepEqual(approvalTraffic.writes.map(entry => `${entry.method} ${entry.pathname}`), [`POST /api/v1/approvals/${approvalId}/resolve`]);
        await approvalPage.close();
        return { status: "passed", metrics: { savedRevision: saved.body.revision, rule: saved.body.toolApprovalMode,
          bypassReviewCancelled: true, failedReadFixture: true, failedReads, preservedDraft: true,
          settingsMutations: mutations.length, browserMutations: traffic.total + approvalTraffic.total,
          presenceMutations: traffic.presence.length + approvalTraffic.presence.length,
          observerRequests: traffic.observers.length + approvalTraffic.observers.length,
          reviewOwnerUnchanged: true, canonicalApprovalResolved: true,
          unapprovedContinuationBlocked: true, explicitApprovedContinuation: true,
          scopedInboxDeepLink: true, currentOwnerNotification: true, notificationWithoutReload: true,
          retainedInboxInvalidationBound: true,
          preEventInboxReadHeld: true, freshOwnerReadAfterSignal: true,
          exactRuleSaveVerified: true, blockingAxe: 0, overflow },
        artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        for (const [target, suffix] of [[page, "failure"], [approvalPage, "approval-failure"]]) {
          if (!target || target.isClosed()) continue;
          try {
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-approval-mode-${variant}-${suffix}.png`);
            await target.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Keep the first failure when screenshot capture is unavailable. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          metrics: { settingsTraffic }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { releaseHeldInboxRead(); await browserContext.close(); }
    });
  }
}
