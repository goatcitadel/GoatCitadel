import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

export const GUIDED_CHANNEL_CATALOG_IDS = [
  "channel.discord", "channel.google-chat", "channel.imessage", "channel.line", "channel.mattermost",
  "channel.nextcloud-talk", "channel.ntfy", "channel.signal", "channel.slack", "channel.teams",
  "channel.telegram", "channel.whatsapp", "channel.zalo", "channel.zalouser",
];
export function assertGuidedChannelCatalog(definitions) {
  assert.deepEqual(definitions.map(item => item.catalog.catalogId).sort(), GUIDED_CHANNEL_CATALOG_IDS);
  for (const definition of definitions) {
    assert.ok(definition.wizard.steps.length > 0, "Every shipped adapter requires guided steps.");
    assert.ok(definition.wizard.introSummary);
    assert.ok(definition.lifecycle.supportsDrafts);
  }
}
export function assertGuidedNarrowCoverage(records) {
  assert.deepEqual(records.map(item => item.catalogId).sort(), GUIDED_CHANNEL_CATALOG_IDS,
    "Every shipped guide requires an actual narrow-screen capture.");
  for (const record of records) {
    assert.equal(record.width, 390); assert.ok(record.stepId); assert.ok(record.title);
  }
}
export function assertExactChannelPlanHandoff({ plan, workspaceId, draftId, url }) {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/chat");
  assert.equal(parsed.searchParams.get("channelPlan"), plan.planId);
  assert.equal(parsed.searchParams.get("channelDraft"), draftId);
  assert.equal(Number(parsed.searchParams.get("channelRevision")), plan.revision);
  assert.equal(parsed.searchParams.get("channelWorkspace"), workspaceId);
  assert.equal(plan.origin.surface, "settings");
  assert.equal(plan.origin.workspaceId, workspaceId);
  assert.equal(plan.origin.sessionId, undefined);
  assert.equal(plan.request.kind, "channel_connection");
  assert.equal(plan.request.draftId, draftId);
  assert.equal(plan.target.ownerId, "channel_setup_draft");
  assert.equal(plan.target.resourceId, draftId);
}

export function assertResumedChannelDraftEvidence(response, { draftId, draftRevision, test }) {
  assert.equal(response.draftId, draftId); assert.equal(response.draftRevision, draftRevision);
  const current = response.currentTest;
  assert.ok(current, "Saved history alone must not restore a current reviewed test.");
  assert.equal(current.draftId, draftId); assert.equal(current.draftRevision, draftRevision);
  assert.ok(test.evidenceId); assert.equal(current.evidenceId, test.evidenceId);
  assert.equal(current.status, test.status); assert.equal(current.checkedAt, test.checkedAt);
  assert.deepEqual(current.probe, test.probe);
  assert.equal(current.finalizationEligibility?.allowed, true, "The matching unexpired test must remain eligible without another send.");
  const receipt = response.items.find(item => item.evidenceId === test.evidenceId);
  assert.ok(receipt); assert.equal(receipt.phase, "test"); assert.equal(receipt.draftId, draftId);
  assert.equal(receipt.draftRevision, test.draftRevision); assert.equal(receipt.status, test.status); assert.equal(receipt.checkedAt, test.checkedAt);
  assert.deepEqual(receipt.probe, test.probe);
}

const APPROVAL_CONFLICT_CONSOLE_TEXT = "Failed to load resource: the server responded with a status of 409 (Conflict)";

/** Acknowledges only the single browser resource error for the approval guard exercised by this lane. */
export function filterAssertedChannelApprovalConflict(snapshot, proof) {
  const retained = { snapshot, acknowledgedCount: 0 };
  if (proof?.guardAsserted !== true || proof.networkEvidenceTruncated !== false ||
      !/^\/api\/v1\/change-plans\/[A-Za-z0-9_-]{1,160}\/responses$/u.test(proof.requestPath ?? "")) return retained;
  const responses = (proof.networkRecords ?? []).filter(record => record.kind === "response" &&
    record.path === proof.requestPath && record.method === "POST" && record.status === 409);
  if (responses.length !== 1 || !Number.isFinite(Date.parse(responses[0].timestamp))) return retained;
  const matches = (snapshot.consoleMessages ?? []).filter(message => message.type === "error" &&
    message.text === APPROVAL_CONFLICT_CONSOLE_TEXT && message.location?.path === proof.requestPath &&
    Number.isFinite(Date.parse(message.timestamp)) && Date.parse(message.timestamp) >= Date.parse(responses[0].timestamp));
  if (matches.length !== 1) return retained;
  return { snapshot: { ...snapshot, consoleMessages: snapshot.consoleMessages.filter(message => message !== matches[0]) }, acknowledgedCount: 1 };
}

/** Real disposable Gateway + UI. Only the task's own loopback notification stub receives a test. */
export async function runChannelGuidedSetupLane(context, deps) {
  const { path, startDeterministicLlmStub, startVerificationStack, stopVerificationStack,
    forceVerificationUiPackage, NEXT_UI_PACKAGE, ensureOnboardingComplete, runScenario, requestJson,
    assertOk, chromium, installMissionControlNextBrowserState, attachBrowserLogging,
    buildVerificationUiUrl, captureBrowserArtifacts, assertBrowserConsoleHealthy, writeJson,
    relativeToRun, auditPageAccessibility, axeSourcePath } = deps;
  let stack, llm, runtimeRoot, receiver;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  const received = [];
  const topic = "guided-setup-fixture";
  try {
    llm = await startDeterministicLlmStub();
    runtimeRoot = await prepareUsabilityRuntime(context.runId + "-channel-guided", llm.baseUrl);
    receiver = createServer((request, response) => {
      let bytes = 0;
      request.on("data", chunk => { bytes += chunk.length; });
      request.on("end", () => {
        if (request.method !== "POST" || request.url !== "/" + topic) { response.writeHead(404); response.end(); return; }
        received.push({ method: request.method, path: request.url, bytes });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "guided-fixture-message", event: "message", topic, time: Math.floor(Date.now() / 1000) }));
      });
    });
    await new Promise((resolve, reject) => { receiver.once("error", reject); receiver.listen(0, "127.0.0.1", resolve); });
    const baseUrl = "http://127.0.0.1:" + receiver.address().port;
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data"; config.assistant.workspaceDir = "./workspace"; config.assistant.worktreesDir = "./.worktrees";
    // Exercise the real saved-connection diagnostics report in this disposable fixture.
    config.assistant.features.connectorDiagnosticsV1Enabled = true;
    config.toolPolicy.sandbox.networkAllowlist = [...new Set([...config.toolPolicy.sandbox.networkAllowlist, "127.0.0.1"])];
    delete config.generation;
    await writeJson(configPath, config);
    await writeJson(path.join(runtimeRoot, "config", "assistant.config.json"), config.assistant);
    await writeJson(path.join(runtimeRoot, "config", "tool-policy.json"), config.toolPolicy);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "guided-channel-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo",
        GOATCITADEL_SLACK_OAUTH_CLIENT_ID: "", GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET: "",
        GOATCITADEL_SLACK_OAUTH_STATE_SECRET: "", GOATCITADEL_SLACK_OAUTH_REDIRECT_URI: "" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-channel-guided");
    const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, "Disposable channel owner request"); return response.body; };
    await runScenario(context, { id: "channels.guided-setup", lane: "channel-guided-setup",
      title: "Fourteen guided adapters, destination cards, exact plan review and return", subsystem: "settings" }, async ({ correlationId }) => {
      const definitions = (await api("/api/v1/channels/setup-definitions")).items;
      assertGuidedChannelCatalog(definitions);
      const workspaces = await api("/api/v1/workspaces");
      const workspace = workspaces.items.find(item => item.workspaceId === "default") ?? workspaces.items[0];
      assert.ok(workspace);
      const drafts = new Map();
      for (const definition of definitions) {
        const created = await api("/api/v1/channels/drafts", { method: "POST", body: { catalogId: definition.catalog.catalogId } });
        const saved = await api("/api/v1/channels/drafts/" + created.draftId, { method: "PATCH",
          body: { expectedRevision: created.revision, label: "Guided proof " + definition.catalog.label, enabled: false } });
        drafts.set(definition.catalog.catalogId, saved);
      }
      const browser = await chromium.launch({ headless: true });
      let page, browserLog, logCursor;
      const artifacts = [], accessibilityArtifacts = [], locationArtifacts = [], rendered = [], focusProof = [], narrowProof = [], writes = [];
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) writes.push({ method: request.method(), pathname });
        });
        const settings = buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#channels");
        await page.goto(settings, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Channel setup", exact: true });
        await panel.getByRole("region", { name: "Saved channel drafts", exact: true }).waitFor();
        const captureActualLocation = async slug => {
          const locationPath = path.join(context.artifactRoot, "diagnostics", slug + "-location.json");
          const actual = await page.evaluate(() => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash,
            visibleRegions: [...document.querySelectorAll('[role="region"],section[aria-label]')]
              .filter(element => element.getClientRects().length > 0).map(element => element.getAttribute("aria-label")).filter(Boolean).slice(0, 30) }));
          await writeJson(locationPath, actual); locationArtifacts.push(relativeToRun(context, locationPath));
        };
        const capture = async slug => {
          await captureActualLocation(slug);
          await page.addScriptTag({ path: axeSourcePath });
          const audit = await auditPageAccessibility(page);
          const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
          const accessibilityPath = path.join(context.artifactRoot, "diagnostics", slug + "-accessibility.json");
          await writeJson(accessibilityPath, { slug, pathname: new URL(page.url()).pathname, viewport: page.viewportSize(),
            violations: audit.violations.map(item => ({ id: item.id, impact: item.impact, description: item.description, help: item.help,
              nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })) });
          accessibilityArtifacts.push(relativeToRun(context, accessibilityPath));
          assert.deepEqual(blocking.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })), [], "Guided setup has blocking accessibility violations.");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "Guided setup overflows the viewport.");
          artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        };
        for (const definition of definitions) {
          const draft = drafts.get(definition.catalog.catalogId);
          await panel.getByRole("button", { name: "Edit " + draft.label, exact: true }).click();
          const guide = panel.getByRole("region", { name: definition.catalog.label + " guided setup", exact: true });
          await guide.waitFor();
          assert.equal(await guide.getByLabel("Connection label", { exact: true }).inputValue(), draft.label);
          const nav = guide.getByRole("navigation", { name: "Setup steps", exact: true });
          const buttons = nav.getByRole("button");
          const stepCount = await buttons.count();
          assert.ok(stepCount > 0);
          const writesBeforeReview = writes.length;
          const headings = [];
          for (let index = 0; index < stepCount; index++) {
            // Keyboard activation must move focus to the selected heading, not leave it on a vanished control.
            const title = await buttons.nth(index).innerText();
            await buttons.nth(index).focus(); await page.keyboard.press("Enter");
            const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));
            // Selecting an already-current first step intentionally keeps the current control focused.
            if (index > 0) { assert.equal(focused.tag, "H4"); assert.ok(title.includes(focused.text)); }
            headings.push(title);
            assert.equal(await guide.locator('input[type="password"]').evaluateAll(inputs => inputs.every(input => input.value === "")), true);
          }
          for (const evidenceStep of definition.wizard.steps.filter(step => ["activation", "first_message"].includes(step.stage))) {
            const navigationLabel = await nav.getByRole("button").filter({ hasText: evidenceStep.title }).innerText();
            assert.equal(navigationLabel.includes("Complete"), false, "Preparation cannot mark activation or first-message evidence complete.");
          }
          assert.equal(writes.length, writesBeforeReview, "Reading setup instructions dispatched a mutation.");
          focusProof.push({ catalogId: definition.catalog.catalogId, headings });
          await capture("channel-guided-" + definition.catalog.catalogId.replace("channel.", ""));
          // Exercise each guide's largest visible account/configuration step at the narrow viewport.
          const narrowStep = definition.wizard.steps
            .filter(item => headings.some(label => label.includes(item.title)))
            .toSorted((left, right) => (right.fields?.length ?? 0) - (left.fields?.length ?? 0))[0];
          assert.ok(narrowStep);
          const narrowControl = nav.getByRole("button").filter({ hasText: narrowStep.title });
          await narrowControl.focus(); await page.keyboard.press("Enter");
          const narrowHeading = guide.getByRole("heading", { name: narrowStep.title, exact: true, level: 4 });
          await narrowHeading.waitFor();
          await page.setViewportSize({ width: 390, height: 844 });
          await narrowHeading.scrollIntoViewIfNeeded();
          assert.equal(await guide.locator('input[type="password"]').evaluateAll(inputs => inputs.every(input => input.value === "")), true);
          await capture("channel-guided-" + definition.catalog.catalogId.replace("channel.", "") + "-390");
          narrowProof.push({ catalogId: definition.catalog.catalogId, width: 390, stepId: narrowStep.id, title: narrowStep.title });
          assert.equal(writes.length, writesBeforeReview, "Desktop and narrow guide inspection must remain read-only.");
          await page.setViewportSize({ width: 1440, height: 1080 });
          rendered.push(definition.catalog.catalogId);
          await panel.getByRole("button", { name: "Back to channels", exact: true }).click();
        }
        assertGuidedNarrowCoverage(narrowProof);
        // Destination cards retain address and thread fields, with one explicit default.
        for (const catalogId of ["channel.telegram", "channel.slack"]) {
          const definition = definitions.find(item => item.catalog.catalogId === catalogId);
          const draft = drafts.get(catalogId);
          await panel.getByRole("button", { name: "Edit " + draft.label, exact: true }).click();
          const guide = panel.getByRole("region", { name: definition.catalog.label + " guided setup", exact: true });
          const targetsStep = definition.wizard.steps.find(step => step.fields?.some(field => field.key === "targets"));
          assert.ok(targetsStep);
          await guide.getByRole("navigation", { name: "Setup steps", exact: true }).getByRole("button").filter({ hasText: targetsStep.title }).click();
          await guide.getByRole("button", { name: "Add destination", exact: true }).click();
          const row = guide.getByRole("region", { name: "Destination 1", exact: true });
          await row.getByLabel("Destination name", { exact: true }).fill("Operations");
          await row.getByLabel(catalogId === "channel.slack" ? "Slack channel name or ID" : "Telegram chat ID or @channel", { exact: true }).fill(catalogId === "channel.slack" ? "C-FIXTURE" : "-1000123456");
          await row.getByText("Optional thread", { exact: true }).click();
          await row.getByLabel(catalogId === "channel.slack" ? "Thread timestamp" : "Forum topic ID", { exact: true }).fill(catalogId === "channel.slack" ? "1712109984.123456" : "42");
          assert.equal(await row.getByRole("radio", { name: "Default destination", exact: true }).isChecked(), true);
          const response = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/v1/channels/drafts/" + draft.draftId);
          await guide.getByRole("button", { name: "Save draft", exact: true }).click();
          const saved = await response; assert.equal(saved.status(), 200);
          const owner = await api("/api/v1/channels/drafts/" + draft.draftId);
          assert.equal(owner.draft.targets.length, 1);
          assert.equal(owner.draft.targets[0].label, "Operations");
          assert.equal(owner.draft.targets[0].default, true);
          assert.equal(owner.draft.targets[0][catalogId === "channel.slack" ? "threadTs" : "threadId"], catalogId === "channel.slack" ? "1712109984.123456" : "42");
          await page.setViewportSize({ width: 390, height: 844 });
          await row.scrollIntoViewIfNeeded();
          await capture("channel-target-cards-" + catalogId.replace("channel.", "") + "-390");
          await page.setViewportSize({ width: 1440, height: 1080 });
          await panel.getByRole("button", { name: "Back to channels", exact: true }).click();
        }
        // Use the existing outbound ntfy adapter and this task's own notification receiver.
        const draft = drafts.get("channel.ntfy");
        await panel.getByRole("button", { name: "Edit " + draft.label, exact: true }).click();
        const guide = panel.getByRole("region", { name: "ntfy guided setup", exact: true });
        const ntfy = definitions.find(item => item.catalog.catalogId === "channel.ntfy");
        const selectNtfyStage = async kind => {
          const step = ntfy.wizard.steps.find(item => item.kind === kind);
          assert.ok(step, "The shipped ntfy guide requires an explicit " + kind + " stage.");
          await guide.getByRole("navigation", { name: "Setup steps", exact: true }).getByRole("button").filter({ hasText: step.title }).click();
        };
        const fieldsStep = ntfy.wizard.steps.find(step => step.fields?.some(field => field.key === "baseUrl"));
        await guide.getByRole("navigation", { name: "Setup steps", exact: true }).getByRole("button").filter({ hasText: fieldsStep.title }).click();
        await guide.getByLabel("Base URL (required)", { exact: true }).fill(baseUrl);
        const topicStep = ntfy.wizard.steps.find(step => step.fields?.some(field => field.key === "topic"));
        assert.ok(topicStep);
        if (topicStep.id !== fieldsStep.id) await guide.getByRole("navigation", { name: "Setup steps", exact: true }).getByRole("button").filter({ hasText: topicStep.title }).click();
        await guide.getByLabel("Topic (required)", { exact: true }).fill(topic);
        const ntfySave = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/v1/channels/drafts/" + draft.draftId);
        await guide.getByRole("button", { name: "Save draft", exact: true }).click();
        assert.equal((await ntfySave).status(), 200);
        await panel.getByText("Channel draft saved.", { exact: true }).waitFor();
        await selectNtfyStage("test");
        await guide.getByRole("button", { name: "Review live test", exact: true }).click();
        const testReview = page.getByRole("dialog", { name: "Run a live channel test?", exact: true });
        const beforeCancel = writes.length;
        await testReview.getByRole("button", { name: "Cancel test", exact: true }).click();
        assert.equal(writes.length, beforeCancel); assert.equal(received.length, 0);
        await selectNtfyStage("test");
        await guide.getByRole("button", { name: "Review live test", exact: true }).click();
        const testResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/" + draft.draftId + "/test"));
        await testReview.getByRole("button", { name: "Run reviewed live test", exact: true }).click();
        const testedHttp = await testResponse;
        assert.equal(testedHttp.status(), 200);
        const tested = await testedHttp.json(); assert.ok(tested.evidenceId);
        assert.equal(received.length, 1);
        const savedTestDraft = await api("/api/v1/channels/drafts/" + draft.draftId);
        const testsBeforeResume = writes.filter(write => write.method === "POST" && write.pathname === "/api/v1/channels/drafts/" + draft.draftId + "/test").length;
        const writesBeforeResume = writes.length;
        // A full reload clears app-session feedback. Reopening must recover authority from the exact owner.
        await page.reload({ waitUntil: "domcontentloaded" });
        await panel.getByRole("region", { name: "Saved channel drafts", exact: true }).waitFor();
        const evidenceRead = page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === "/api/v1/channels/drafts/" + draft.draftId + "/evidence" &&
            url.searchParams.get("expectedRevision") === String(savedTestDraft.revision);
        }).then(async response => {
          assert.equal(response.status(), 200);
          return await response.json();
        });
        await panel.getByRole("button", { name: "Edit " + draft.label, exact: true }).click();
        await guide.waitFor();
        const restoredEvidence = await evidenceRead;
        assertResumedChannelDraftEvidence(restoredEvidence, { draftId: draft.draftId, draftRevision: savedTestDraft.revision, test: tested });
        await selectNtfyStage("test");
        const restoredResult = guide.getByRole("region", { name: "Channel check result", exact: true });
        await restoredResult.getByText("The Gateway permits preparing the activation plan for this reviewed evidence.", { exact: true }).waitFor();
        await restoredResult.getByText("Restored current proof for this saved draft revision. Review its warnings and receipts before preparing a plan.", { exact: true }).waitFor();
        await restoredResult.getByRole("region", { name: "Live connection probe", exact: true }).waitFor();
        await restoredResult.getByText("Provider receipt: guided-fixture-message", { exact: true }).waitFor();
        const restoredHistory = guide.getByRole("region", { name: "Channel check history", exact: true });
        await restoredHistory.getByRole("heading", { name: "Saved check evidence", exact: true }).waitFor();
        await restoredHistory.locator("summary").filter({ hasText: /^Review \d+ saved check receipts?$/u }).click();
        await restoredHistory.getByText("Receipt " + tested.evidenceId, { exact: true }).waitFor();
        await restoredHistory.getByRole("region", { name: "Saved connection probe", exact: true }).getByText("Provider receipt: guided-fixture-message", { exact: true }).waitFor();
        assert.equal(received.length, 1, "Resuming saved proof must not dispatch another provider message.");
        assert.equal(writes.length, writesBeforeResume, "Reloading and inspecting saved proof must remain read-only.");
        await capture("channel-test-resumed-from-evidence-desktop");
        const planResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans");
        await selectNtfyStage("confirm");
        await guide.getByRole("button", { name: "Prepare finalization plan", exact: true }).click();
        const plan = await (await planResponse).json();
        assert.equal(received.length, 1, "Preparing a plan from restored proof must not resend the live test.");
        assert.equal(writes.filter(write => write.method === "POST" && write.pathname === "/api/v1/channels/drafts/" + draft.draftId + "/test").length, testsBeforeResume);
        await page.waitForURL(url => url.pathname === "/chat" && url.searchParams.get("channelPlan") === plan.planId);
        assertExactChannelPlanHandoff({ plan, workspaceId: workspace.workspaceId, draftId: draft.draftId, url: page.url() });
        const review = page.getByRole("region", { name: "Channel setup Change Plan review", exact: true });
        const planDialog = page.getByRole("dialog", { name: plan.requiredAction.title, exact: true });
        await planDialog.waitFor();
        await capture("channel-exact-plan-desktop");
        await planDialog.getByRole("button", { name: "Cancel", exact: true }).click(); // Dismissal is not cancellation.
        await page.reload({ waitUntil: "domcontentloaded" }); await planDialog.waitFor();
        assertExactChannelPlanHandoff({ plan, workspaceId: workspace.workspaceId, draftId: draft.draftId, url: page.url() });
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("channel-exact-plan-reload-390");
        await planDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await review.getByRole("button", { name: "Return to Channels", exact: true }).click();
        await page.waitForURL(url => url.pathname.startsWith("/settings/") && url.searchParams.get("channelDraft") === draft.draftId);
        await panel.getByRole("region", { name: "ntfy guided setup", exact: true }).waitFor();
        await capture("channel-plan-return-390");
        const handoffUrl = buildVerificationUiUrl(stack.uiUrl, "/chat?channelPlan=" + plan.planId + "&channelDraft=" + draft.draftId + "&channelRevision=" + plan.revision + "&channelWorkspace=" + workspace.workspaceId + "&shell=cockpit");
        await page.goto(handoffUrl, { waitUntil: "domcontentloaded" }); await planDialog.waitFor();
        await planDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        const cancellation = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans/" + plan.planId + "/cancellations");
        await review.getByRole("button", { name: "Cancel setup plan and discard its draft", exact: true }).click();
        assert.equal((await cancellation).status(), 200);
        const cancelled = await api("/api/v1/change-plans/" + plan.planId + "?workspaceId=" + encodeURIComponent(workspace.workspaceId));
        assert.equal(cancelled.status, "cancelled");
        const deleted = await requestJson(stack.gatewayUrl, "/api/v1/channels/drafts/" + draft.draftId);
        assert.equal(deleted.status, 404);
        assert.deepEqual((await api("/api/v1/integrations/connections?kind=channel")).items, []);
        await review.getByRole("button", { name: "Return to Channels", exact: true }).click();
        await page.waitForURL(url => url.pathname.startsWith("/settings/") && url.searchParams.get("channelDraft") === draft.draftId);
        await panel.getByText("The channel setup plan was cancelled. No activation receipt was recorded. The current channels list is being refreshed.", { exact: true }).waitFor();
        await panel.getByRole("region", { name: "Saved channel drafts", exact: true }).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Edit " + draft.label, exact: true }).count(), 0);
        await capture("channel-plan-cancelled-return-390");

        // A separate disposable draft proves actual canonical approval and completion.
        // This installed connection remains disabled; only this task's loopback receiver is used.
        const completionCreated = await api("/api/v1/channels/drafts", { method: "POST", body: { catalogId: "channel.ntfy" } });
        const completionDraft = await api("/api/v1/channels/drafts/" + completionCreated.draftId, { method: "PATCH", body: {
          expectedRevision: completionCreated.revision, label: "Guided completion ntfy", enabled: false,
          draft: { baseUrl, topic, dryRun: false },
        } });
        await page.goto(settings, { waitUntil: "domcontentloaded" });
        await panel.getByRole("button", { name: "Edit " + completionDraft.label, exact: true }).click();
        await guide.waitFor();
        await selectNtfyStage("test");
        await guide.getByRole("button", { name: "Review live test", exact: true }).click();
        const completionTest = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/" + completionDraft.draftId + "/test"));
        await testReview.getByRole("button", { name: "Run reviewed live test", exact: true }).click();
        assert.equal((await completionTest).status(), 200);
        const completionPrepare = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans");
        await selectNtfyStage("confirm");
        await guide.getByRole("button", { name: "Prepare finalization plan", exact: true }).click();
        const completionPlan = await (await completionPrepare).json();
        assert.equal(completionPlan.requiredAction?.kind, "confirmation");
        await page.waitForURL(url => url.pathname === "/chat" && url.searchParams.get("channelPlan") === completionPlan.planId);
        assertExactChannelPlanHandoff({ plan: completionPlan, workspaceId: workspace.workspaceId, draftId: completionDraft.draftId, url: page.url() });
        const completionDialog = page.getByRole("dialog", { name: completionPlan.requiredAction.title, exact: true });
        await completionDialog.waitFor();
        const confirmation = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans/" + completionPlan.planId + "/confirmations");
        await completionDialog.getByRole("button", { name: "Apply exact change", exact: true }).click();
        const waitingHttp = await confirmation; assert.equal(waitingHttp.status(), 200);
        const waiting = await waitingHttp.json();
        assert.equal(waiting.status, "awaiting_approval"); assert.equal(waiting.requiredAction?.kind, "approval");
        const approvalId = waiting.requiredAction.approvalId; assert.ok(approvalId);
        assert.deepEqual((await api("/api/v1/integrations/connections?kind=channel")).items, []);
        const approvalDialog = page.getByRole("dialog", { name: waiting.requiredAction.title, exact: true });
        await approvalDialog.waitFor();
        const approvalProbeCursor = browserLog.mark();
        const prematurePath = "/api/v1/change-plans/" + completionPlan.planId + "/responses";
        const premature = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === prematurePath);
        await approvalDialog.getByRole("button", { name: "Continue after approval", exact: true }).click();
        const prematureHttp = await premature;
        assert.equal(prematureHttp.status(), 409, "An unresolved canonical approval must prevent activation.");
        await prematureHttp.finished();
        await approvalDialog.getByRole("alert").filter({ hasText: "not resolved as approved" }).waitFor();
        assert.deepEqual((await api("/api/v1/integrations/connections?kind=channel")).items, []);
        const approvalProbeSnapshot = browserLog.getSnapshot(approvalProbeCursor);
        assert.equal(approvalProbeSnapshot.networkEvidenceTruncated, false);
        assert.equal(approvalProbeSnapshot.networkRecords.filter(record => record.kind === "response" &&
          record.method === "POST" && record.path === prematurePath && record.status === 409).length, 1);
        const approvalConflictProof = { guardAsserted: true, requestPath: prematurePath,
          networkRecords: approvalProbeSnapshot.networkRecords, networkEvidenceTruncated: false };
        const inbox = await api("/api/v1/inbox?workspaceId=" + encodeURIComponent(workspace.workspaceId));
        const approvalItem = inbox.items.find(item => item.kind === "approval" && item.source.approvalId === approvalId);
        assert.ok(approvalItem); assert.equal(approvalItem.source.workspaceId, workspace.workspaceId);
        const approvalPage = await browserContext.newPage();
        try {
          await approvalPage.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox?shell=cockpit&workspaceId=" + encodeURIComponent(workspace.workspaceId) + "&item=" + encodeURIComponent(approvalItem.id)), { waitUntil: "domcontentloaded" });
          const inspector = approvalPage.getByLabel("Inspector: " + approvalItem.title, { exact: true });
          await inspector.getByRole("button", { name: "Approve once", exact: true }).waitFor();
          const approvalResponse = approvalPage.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/approvals/" + approvalId + "/resolve");
          await inspector.getByRole("button", { name: "Approve once", exact: true }).click();
          const approvedHttp = await approvalResponse; assert.equal(approvedHttp.status(), 200);
          const approved = await approvedHttp.json(); assert.equal(approved.approval.approvalId, approvalId); assert.equal(approved.approval.status, "approved");
        } finally { await approvalPage.close(); }
        const approvedPlan = await api("/api/v1/change-plans/" + completionPlan.planId + "?workspaceId=" + encodeURIComponent(workspace.workspaceId));
        assert.equal(approvedPlan.status, "awaiting_approval", "Channel plans retain an explicit continuation after canonical approval.");
        const continuation = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans/" + completionPlan.planId + "/responses");
        await approvalDialog.getByRole("button", { name: "Continue after approval", exact: true }).click();
        const continued = await continuation; assert.equal(continued.status(), 200);
        const completed = await continued.json(); assert.equal(completed.status, "completed");
        const connectionRef = completed.evidenceRefs.find(ref => ref.startsWith("channel-connection:")); assert.ok(connectionRef);
        const connectionId = connectionRef.slice("channel-connection:".length);
        const connection = await api("/api/v1/integrations/connections/" + connectionId);
        assert.equal(connection.catalogId, "channel.ntfy"); assert.equal(connection.label, completionDraft.label); assert.equal(connection.enabled, false);
        assert.equal(connection.status, "connected");
        assert.equal((await requestJson(stack.gatewayUrl, "/api/v1/channels/drafts/" + completionDraft.draftId)).status, 404);
        await capture("channel-plan-completed-390");
        const returnedDiagnostics = page.waitForResponse(response => response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/v1/comms/diagnostics/" + connectionId);
        await review.getByRole("button", { name: "Return to Channels", exact: true }).click();
        await page.waitForURL(url => url.pathname.startsWith("/settings/") && url.searchParams.get("channelConnection") === connectionId);
        const selectedConnection = panel.getByRole("region", { name: "Selected channel connection", exact: true });
        await selectedConnection.getByRole("heading", { name: completionDraft.label, exact: true }).waitFor();
        const returnedDiagnosticsHttp = await returnedDiagnostics;
        assert.equal(returnedDiagnosticsHttp.status(), 200, "Saved channel diagnostics must load with the explicit fixture feature enabled.");
        const returnedReport = await returnedDiagnosticsHttp.json();
        assert.equal(returnedReport.connectorId, connectionId); assert.equal(returnedReport.connectorType, "integration_connection");
        assert.equal(returnedReport.checks.find(check => check.key === "enabled")?.status, "warn", "A disabled fixture connection must retain its disabled posture.");
        assert.ok(Number.isFinite(Date.parse(returnedReport.checkedAt)));
        await returnedDiagnosticsHttp.finished();
        await capture("channel-plan-completed-return-390");
        const browserHealth = filterAssertedChannelApprovalConflict(browserLog.getSnapshot(logCursor), approvalConflictProof);
        assertBrowserConsoleHealthy({ getSnapshot: () => browserHealth.snapshot }, undefined, NEXT_UI_PACKAGE);
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "channel-guided-setup.json");
        await writeJson(diagnostics, { rendered, focusProof, narrowProof, planId: plan.planId, workspaceId: workspace.workspaceId,
          draftId: draft.draftId, cancelledStatus: cancelled.status, completedPlanId: completionPlan.planId, completedStatus: completed.status, approvedConnectionId: connectionId, loopbackMessages: received.length,
          boundHandoff: true, narrowWidth: 390, resumedTestEvidenceId: tested.evidenceId, resumedDraftRevision: savedTestDraft.revision, resumeTestPostCount: testsBeforeResume, assertedApprovalConflict: { requestPath: prematurePath, method: "POST", status: 409, acknowledgedConsoleErrors: browserHealth.acknowledgedCount }, note: "Real disposable owner/browser proof. No external provider, OAuth exchange or credential/keychain write. Exact canonical approval completed one disabled task-owned ntfy connection using only a loopback notification receiver." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map(key => [key, artifacts.flatMap(item => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), ...accessibilityArtifacts, ...locationArtifacts, relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { renderedAdapters: rendered.length, keyboardHeadings: focusProof.reduce((total, entry) => total + entry.headings.length, 0), keyboardAdapterCoverage: focusProof.length, narrowAdapterCoverage: narrowProof.length,
          targetCardAdapters: 2, persistedDraftTestResume: 1, resumeWithoutResend: 1, exactSettingsPlan: 1, planReload: 1, canonicalReturn: 1, cancelledPlan: 1, cancelledReturn: 1, canonicalApproval: 1, approvalGuard: 1, completedPlan: 1, completedReturn: 1, savedDiagnostics: 1,
          loopbackSandboxMessages: received.length, narrowWidth: 390 }, artifacts: combined };
      } catch (error) {
        if (page && browserLog) {
          const actual = await page.evaluate(() => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }));
          await writeJson(path.join(context.artifactRoot, "diagnostics", "channel-guided-failure-location.json"), actual);
          await captureBrowserArtifacts(context, { slug: "channel-guided-failure", page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        }
        throw error;
      } finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally {
      try { if (receiver) await new Promise(resolve => receiver.close(resolve)); await llm?.close(); }
      finally { restoreUi(); }
    }
  }
}