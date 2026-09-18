import assert from "node:assert/strict";
import fs from "node:fs/promises";

/** Disposable loopback Gateway only; no provider, channel, keychain, or volume operations. */
export async function runIntegrationConnectionRevisionsLane(context, deps) {
  const { path, prepareVerificationRuntime, startDeterministicLlmStub, writeDeterministicLlmProviderConfig,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack; let llmStub; let runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-integration-revision`);
    llmStub = await startDeterministicLlmStub();
    await writeDeterministicLlmProviderConfig(runtimeRoot, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data"; config.assistant.workspaceDir = "./workspace"; config.assistant.worktreesDir = "./.worktrees";
    delete config.generation;
    await writeJson(configPath, config);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "integration-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-integration-revision");
    await runScenario(context, { id: "integrations.connection-revisions", lane: "integration-connection-revisions",
      title: "Settings retains stale integration drafts and requires a fresh deletion review", subsystem: "settings" }, async ({ correlationId }) => {
      const catalog = await requestJson(stack.gatewayUrl, "/api/v1/integrations/catalog"); assertOk(catalog, "load fixture catalog");
      const github = catalog.body.items.find(item => item.key === "github" && item.kind !== "channel"); assert.ok(github);
      const created = await requestJson(stack.gatewayUrl, "/api/v1/integrations/connections", { method: "POST", body: { catalogId: github.catalogId, label: "Review integration", enabled: false, status: "paused", config: { owner: "original-owner", apiKey: "synthetic-integration-base" } } });
      assertOk(created, "create owned integration fixture");
      const initial = created.body, baseUrl = `/api/v1/integrations/connections/${initial.connectionId}`;
      const read = async () => { const result = await requestJson(stack.gatewayUrl, baseUrl); assertOk(result, "read connection review"); return result.body; };
      const peerWrite = async (reviewed, label) => { const result = await requestJson(stack.gatewayUrl, baseUrl, { method: "PATCH", body: { expectedRevision: reviewed.revision, label, config: { owner: "peer-owner", apiKey: "synthetic-integration-peer" } } }); assertOk(result, "owned peer mutation"); return result.body; };
      for (const method of ["PATCH", "DELETE"]) assert.equal((await requestJson(stack.gatewayUrl, baseUrl, { method, body: { label: "Unreviewed" } })).status, 400);
      assert.deepEqual(await read(), initial);
      const workspaces = await requestJson(stack.gatewayUrl, "/api/v1/workspaces"); assertOk(workspaces, "load owned workspaces");
      const workspace = workspaces.body.items[0]; assert.ok(workspace);
      const browser = await chromium.launch({ headless: true });
      let page; let browserLog; let logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        const artifacts = [], receipts = [];
        const capture = async slug => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        const waitMutation = method => page.waitForResponse(response => new URL(response.url()).pathname === baseUrl && response.request().method() === method);
        const race = async (method, reviewed, label, failRefresh = false) => {
          const state = { tokens: [], winner: null, blockRefresh: failRefresh };
          await page.route(`**${baseUrl}`, async route => {
            if (route.request().method() === "GET" && state.blockRefresh && state.winner) {
              await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic connection refresh failure" }) }); return;
            }
            if (route.request().method() === method) {
              const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
              if (!state.winner) { assert.equal(input.expectedRevision, reviewed.revision); state.winner = await peerWrite(reviewed, label); }
            }
            await route.continue();
          });
          return state;
        };
        const reject = async (method, click, state) => {
          const [response] = await Promise.all([waitMutation(method), click()]);
          assert.equal(response.status(), 409);
          assert.equal((await response.json()).details?.reason, "INTEGRATION_CONNECTION_REVISION_CONFLICT");
          assert.deepEqual(await read(), state.winner);
        };
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/integrations"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "integrations", readyText: "Connected integrations" }, NEXT_UI_PACKAGE);
        await page.getByRole("button", { name: /Review integration/ }).click();
        await page.getByRole("button", { name: "Edit connection", exact: true }).click();
        const label = page.getByLabel("Label", { exact: true });
        await label.fill("Local integration draft");
        await page.getByRole("button", { name: "Advanced JSON", exact: true }).click();
        const configInput = page.getByLabel("Advanced Config JSON", { exact: true });
        await configInput.fill(JSON.stringify({ owner: "local-owner", apiKey: "[REDACTED]" }));
        const editRace = await race("PATCH", initial, "Peer integration", true);
        await reject("PATCH", () => page.getByRole("button", { name: "Save changes", exact: true }).click(), editRace);
        await page.getByText(/Current settings could not be loaded/).waitFor();
        assert.equal(await label.inputValue(), "Local integration draft");
        assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), true);
        editRace.blockRefresh = false;
        await page.getByRole("button", { name: "Reload connection review", exact: true }).click();
        await page.getByRole("button", { name: "Use current connection review", exact: true }).waitFor();
        await page.getByText("Current configuration", { exact: true }).click();
        await page.getByText("peer-owner", { exact: true }).waitFor();
        assert.equal(JSON.parse(await configInput.inputValue()).owner, "local-owner");
        await capture("integration-retained-draft-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        const reviewButton = page.getByRole("button", { name: "Use current connection review", exact: true });
        assert.ok((await reviewButton.boundingBox())?.height >= 44);
        await capture("integration-current-review-narrow");
        await reviewButton.scrollIntoViewIfNeeded();
        await capture("integration-retained-draft-narrow");
        await reviewButton.click();
        assert.equal(editRace.tokens.length, 1, "review acceptance must not retry automatically");
        logCursor = browserLog.mark();
        const [savedResponse] = await Promise.all([waitMutation("PATCH"), page.getByRole("button", { name: "Save changes", exact: true }).click()]);
        assert.equal(savedResponse.status(), 200);
        const saved = await savedResponse.json();
        assert.deepEqual(editRace.tokens, [initial.revision, editRace.winner.revision]);
        assert.deepEqual(await read(), saved);
        assert.equal(saved.config.apiKey, "[REDACTED]");
        assert.equal(saved.config.owner, "local-owner");
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ method: "PATCH", tokens: editRace.tokens, winner: editRace.winner, saved });
        await page.unroute(`**${baseUrl}`);
        await page.getByRole("button", { name: "Close editor", exact: true }).click();
        await page.getByRole("button", { name: /Local integration draft/ }).click();
        const removeRace = await race("DELETE", saved, "Peer before delete");
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        const confirm = () => page.getByRole("dialog", { name: "Delete integration connection?", exact: true }).getByRole("button", { name: "Delete connection", exact: true }).click();
        await reject("DELETE", confirm, removeRace);
        await page.getByRole("button", { name: "Use current connection review", exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).isDisabled(), true);
        await capture("integration-delete-conflict-narrow");
        await page.getByRole("button", { name: "Use current connection review", exact: true }).click();
        assert.equal(removeRace.tokens.length, 1);
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        assert.ok((await page.getByRole("dialog", { name: "Delete integration connection?", exact: true }).getByRole("button", { name: "Delete connection", exact: true }).boundingBox())?.height >= 44);
        await capture("integration-reviewed-delete-narrow");
        logCursor = browserLog.mark();
        const [removed] = await Promise.all([waitMutation("DELETE"), confirm()]);
        assert.equal(removed.status(), 200); assert.equal((await removed.json()).deleted, true);
        assert.deepEqual(removeRace.tokens, [saved.revision, removeRace.winner.revision]);
        assert.equal((await requestJson(stack.gatewayUrl, baseUrl)).status, 404);
        await page.getByText("No integration connections yet.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ method: "DELETE", tokens: removeRace.tokens, winner: removeRace.winner, deleted: true });
        await capture("integration-committed-narrow");
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "integration-connection-revisions.json");
        await writeJson(diagnostics, { initial, receipts, note: "Two real conflicts, explicit reviewed retries, failed refresh recovery, and fresh delete confirmation. Only synthetic loopback integration configuration; no live connector, provider, keychain, or volume operations." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map(key => [key, artifacts.flatMap(item => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { staleMutationsRejected: 2, reviewedMutations: 2, failedRefreshRecovered: 1, narrowWidth: 390 }, artifacts: combined };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "integration-revisions-failure", page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
