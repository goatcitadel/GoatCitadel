import assert from "node:assert/strict";
import fs from "node:fs/promises";

/** Real Gateway and UI; disabled synthetic MCP configuration, with every connection action blocked. */
export async function runMcpServerRevisionsLane(context, deps) {
  const { path, prepareVerificationRuntime, startDeterministicLlmStub, writeDeterministicLlmProviderConfig,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack, llmStub, runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-mcp-revisions`);
    llmStub = await startDeterministicLlmStub();
    await writeDeterministicLlmProviderConfig(runtimeRoot, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data"; config.assistant.workspaceDir = "./workspace"; config.assistant.worktreesDir = "./.worktrees";
    delete config.generation; await writeJson(configPath, config);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "mcp-review-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-mcp-revision");
    await runScenario(context, { id: "mcp.server-revisions", lane: "mcp-server-revisions", title: "MCP Settings retains conflicts and requires fresh save and deletion reviews", subsystem: "settings" }, async ({ correlationId }) => {
      const created = await requestJson(stack.gatewayUrl, "/api/v1/mcp/servers", { method: "POST", body: { label: "Review MCP", transport: "stdio", command: "node", args: ["--password", "synthetic-mcp-original"], enabled: false } });
      assertOk(created, "create disabled MCP fixture"); const initial = created.body, baseUrl = `/api/v1/mcp/servers/${initial.serverId}`;
      const read = async () => { const result = await requestJson(stack.gatewayUrl, baseUrl); assertOk(result, "read MCP review"); return result.body; };
      const peerWrite = async (reviewed, label) => { const result = await requestJson(stack.gatewayUrl, baseUrl, { method: "PATCH", body: { expectedRevision: reviewed.revision, label, args: ["--password", "synthetic-mcp-peer"] } }); assertOk(result, "owned peer edit"); return result.body; };
      for (const method of ["PATCH", "DELETE"]) assert.equal((await requestJson(stack.gatewayUrl, baseUrl, { method, body: {} })).status, 400);
      assert.deepEqual(await read(), initial);
      const workspaces = await requestJson(stack.gatewayUrl, "/api/v1/workspaces"); assertOk(workspaces, "owned workspace"); const workspace = workspaces.body.items[0]; assert.ok(workspace);
      const browser = await chromium.launch({ headless: true }); let page, browserLog, logCursor; let connectionCalls = 0;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        await page.route(/\/api\/v1\/mcp\/servers\/[^/]+\/(?:connect|disconnect|oauth|health-check)(?:\/|$)/, async route => {
          connectionCalls++; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "MCP live actions disabled in revision proof" }) });
        });
        const artifacts = [], receipts = [];
        const capture = async slug => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        const waitMutation = method => page.waitForResponse(response => new URL(response.url()).pathname === baseUrl && response.request().method() === method);
        const race = async (method, reviewed, label, blockRefresh = false) => {
          const state = { tokens: [], winner: null, blockRefresh };
          await page.route(`**${baseUrl}`, async route => {
            if (route.request().method() === "GET" && state.blockRefresh && state.winner) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic server refresh failure" }) }); return; }
            if (route.request().method() === method) { const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision); if (!state.winner) { assert.equal(input.expectedRevision, reviewed.revision); state.winner = await peerWrite(reviewed, label); } }
            await route.continue();
          }); return state;
        };
        const reject = async (method, click, state) => {
          const [response] = await Promise.all([waitMutation(method), click()]); assert.equal(response.status(), 409);
          assert.equal((await response.json()).code, "WRITE_CONFLICT"); assert.deepEqual(await read(), state.winner);
        };
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/mcp"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "mcp", readyText: "MCP servers" }, NEXT_UI_PACKAGE);
        await page.getByRole("button", { name: /Review MCP/ }).click(); await page.getByRole("button", { name: "Edit server", exact: true }).click();
        const label = page.getByLabel("MCP server label", { exact: true }); await label.fill("Local MCP draft");
        const editRace = await race("PATCH", initial, "Peer MCP", true);
        await reject("PATCH", () => page.getByRole("button", { name: "Save changes", exact: true }).click(), editRace);
        await page.getByText(/Current settings could not be loaded/).waitFor();
        assert.equal(await label.inputValue(), "Local MCP draft"); await label.fill("Newer MCP draft");
        assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), true);
        editRace.blockRefresh = false; await page.getByRole("button", { name: "Reload server review", exact: true }).click();
        const reviewButton = page.getByRole("button", { name: "Use current server review", exact: true }); await reviewButton.waitFor();
        assert.equal(await label.inputValue(), "Newer MCP draft");
        await capture("mcp-retained-draft-desktop"); await page.setViewportSize({ width: 390, height: 844 });
        assert.ok((await reviewButton.boundingBox())?.height >= 44);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await capture("mcp-current-review-narrow"); await reviewButton.scrollIntoViewIfNeeded(); await capture("mcp-retained-draft-narrow");
        await reviewButton.click(); assert.equal(editRace.tokens.length, 1);
        logCursor = browserLog.mark(); const [response] = await Promise.all([waitMutation("PATCH"), page.getByRole("button", { name: "Save changes", exact: true }).click()]);
        assert.equal(response.status(), 200); const saved = await response.json();
        assert.deepEqual(editRace.tokens, [initial.revision, editRace.winner.revision]); assert.equal(saved.label, "Newer MCP draft");
        assert.deepEqual(await read(), saved); assert.equal(saved.args[1], "[REDACTED]"); assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ method: "PATCH", tokens: editRace.tokens, saved }); await page.unroute(`**${baseUrl}`);
        await page.getByRole("button", { name: "Back to list", exact: true }).click(); await page.getByRole("button", { name: /Newer MCP draft/ }).click();
        const deleteRace = await race("DELETE", saved, "Peer before delete"); await page.getByRole("button", { name: "Delete", exact: true }).click();
        const confirm = () => page.getByRole("dialog", { name: "Delete MCP server?", exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
        await reject("DELETE", confirm, deleteRace); await reviewButton.waitFor();
        assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).isDisabled(), true);
        await capture("mcp-delete-conflict-narrow"); await reviewButton.click(); assert.equal(deleteRace.tokens.length, 1);
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        assert.ok((await page.getByRole("dialog", { name: "Delete MCP server?", exact: true }).getByRole("button", { name: "Delete", exact: true }).boundingBox())?.height >= 44);
        await capture("mcp-reviewed-delete-narrow"); logCursor = browserLog.mark();
        const [removed] = await Promise.all([waitMutation("DELETE"), confirm()]); assert.equal(removed.status(), 200); assert.equal((await removed.json()).deleted, true);
        assert.deepEqual(deleteRace.tokens, [saved.revision, deleteRace.winner.revision]); assert.equal((await requestJson(stack.gatewayUrl, baseUrl)).status, 404);
        assert.equal(connectionCalls, 0); assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ method: "DELETE", tokens: deleteRace.tokens, deleted: true });
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "mcp-server-revisions.json"); await writeJson(diagnostics, { initial, receipts, connectionCalls, note: "Disabled synthetic configuration only. No MCP process, credential custody, provider, or drive operations." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map(key => [key, artifacts.flatMap(item => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { staleMutationsRejected: 2, reviewedMutations: 2, failedRefreshRecovered: 1, connectionCalls, narrowWidth: 390 }, artifacts: combined };
      } catch (error) { if (page && browserLog) await captureBrowserArtifacts(context, { slug: "mcp-revisions-failure", page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor }); throw error; }
      finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
