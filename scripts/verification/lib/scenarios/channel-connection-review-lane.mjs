import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

/** Real disposable Gateway and browser; environment-name fixture only, with no live channel test. */
export async function runChannelConnectionReviewLane(context, deps) {
  const { path, startDeterministicLlmStub,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack, llmStub, runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    llmStub = await startDeterministicLlmStub();
    // Clean checkouts have no config/goatcitadel.json (it is gitignored operator state): seed shipped defaults.
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-channel-review`, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data"; config.assistant.workspaceDir = "./workspace"; config.assistant.worktreesDir = "./.worktrees"; delete config.generation;
    await writeJson(configPath, config);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "channel-review-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-channel-review");
    await runScenario(context, { id: "channels.connection-review", lane: "channel-connection-review", title: "Channel repair retains edits and requires current connection review", subsystem: "settings" }, async ({ correlationId }) => {
      const created = await requestJson(stack.gatewayUrl, "/api/v1/integrations/connections", { method: "POST", body: {
        catalogId: "channel.telegram", label: "Review channel", enabled: false, status: "paused",
        config: { botTokenEnv: "GOATCITADEL_CHANNEL_REVIEW_NONEXISTENT_FIXTURE", defaultChatId: "-1000123456" },
      } }); assertOk(created, "create disposable channel");
      const base = created.body, connectionUrl = `/api/v1/integrations/connections/${base.connectionId}`;
      const seeded = await requestJson(stack.gatewayUrl, "/api/v1/channels/drafts", { method: "POST", body: { catalogId: base.catalogId, connectionId: base.connectionId, lifecycleMode: "repair" } }); assertOk(seeded, "hydrate reviewed channel draft");
      const draft = seeded.body, draftUrl = `/api/v1/channels/drafts/${draft.draftId}`;
      assert.equal(draft.connectionRevision, base.revision);
      const workspaces = await requestJson(stack.gatewayUrl, "/api/v1/workspaces"); assertOk(workspaces, "read disposable workspaces");
      const workspace = workspaces.body.items[0]; assert.ok(workspace);
      const browser = await chromium.launch({ headless: true }); let page, browserLog, logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        const artifacts = []; let peer, blockRefresh = true, tests = 0, reviews = 0;
        const capture = async slug => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        await page.route(`**${draftUrl}/test`, async route => { tests += 1; await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Live channel tests are disabled for this fixture." }) }); });
        await page.route(`**${draftUrl}/validate`, async route => {
          if (!peer) {
            const changed = await requestJson(stack.gatewayUrl, connectionUrl, { method: "PATCH", body: { expectedRevision: base.revision, label: "Peer channel", enabled: false, config: { ...base.config, defaultChatId: "-1000999999" } } }); assertOk(changed, "competing connection edit"); peer = changed.body;
          }
          await route.continue();
        });
        await page.route(`**${connectionUrl}`, async route => {
          if (route.request().method() === "GET" && peer && blockRefresh) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic connection review unavailable" }) });
          else await route.continue();
        });
        await page.route(`**${draftUrl}/connection-review`, async route => { reviews += 1; await route.continue(); });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/channels"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "channels", readyText: "Drafts" }, NEXT_UI_PACKAGE);
        await page.getByRole("button", { name: /Review channel/ }).last().click();
        await page.getByRole("button", { name: "Advanced JSON", exact: true }).click();
        const input = page.getByLabel("Draft JSON", { exact: true });
        await input.fill(JSON.stringify({ ...draft.draft, defaultChatId: "-1000777777" }));
        const [rejected] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === `${draftUrl}/validate`),
          page.getByRole("button", { name: "Validate", exact: true }).click(),
        ]);
        assert.equal(rejected.status(), 409); assert.equal((await rejected.json()).details?.reason, "CHANNEL_CONNECTION_REVIEW_REQUIRED");
        await page.getByText(/Current settings could not be loaded/).waitFor();
        const retained = { ...JSON.parse(await input.inputValue()), defaultChatId: "-1000888888" };
        await input.fill(JSON.stringify(retained));
        assert.equal(await page.getByRole("button", { name: "Run live test", exact: true }).isDisabled(), true);
        blockRefresh = false;
        await page.getByRole("button", { name: "Reload connection review", exact: true }).click();
        const accept = page.getByRole("button", { name: "Use current connection review", exact: true });
        await accept.waitFor(); assert.equal(reviews, 0); assert.equal(tests, 0);
        await page.getByText("Current configuration", { exact: true }).click();
        await capture("channel-review-retained-desktop");
        await page.setViewportSize({ width: 390, height: 844 }); await accept.scrollIntoViewIfNeeded();
        assert.ok((await accept.boundingBox())?.height >= 44);
        await capture("channel-review-retained-narrow");
        const [reviewed] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === `${draftUrl}/connection-review`), accept.click()]);
        assert.equal(reviewed.status(), 200); const acknowledged = await reviewed.json();
        assert.equal(acknowledged.connectionRevision, peer.revision);
        assert.equal(JSON.parse(await input.inputValue()).defaultChatId, retained.defaultChatId);
        assert.equal(tests, 0);
        logCursor = browserLog.mark();
        const [saved] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === draftUrl && response.request().method() === "PATCH"), page.getByRole("button", { name: "Save draft", exact: true }).click()]);
        assert.equal(saved.status(), 200); const savedDraft = await saved.json();
        assert.equal(saved.request().postDataJSON().expectedRevision, acknowledged.revision);
        assert.equal(savedDraft.draft.defaultChatId, retained.defaultChatId);
        assert.equal(savedDraft.connectionRevision, peer.revision);
        assert.equal(await page.getByRole("button", { name: "Finalize connection", exact: true }).isDisabled(), true);
        assert.equal(reviews, 1); assert.equal(tests, 0);
        const current = await requestJson(stack.gatewayUrl, connectionUrl); assertOk(current, "read preserved connection"); assert.deepEqual(current.body, peer);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await input.scrollIntoViewIfNeeded(); await capture("channel-review-saved-narrow");
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "channel-connection-review.json");
        await writeJson(diagnostics, { initial: base, peer, reviewed: acknowledged, savedDraft, tests, reviews, note: "Real stale connection rejection, failed read recovery, retained unsaved edit, explicit draft review, and fresh draft CAS. No live channel, provider, keychain, or drive operations." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map(key => [key, artifacts.flatMap(item => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { staleConnectionRejected: 1, explicitReviews: reviews, liveTests: tests, narrowWidth: 390 }, artifacts: combined };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "channel-review-failure", page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
