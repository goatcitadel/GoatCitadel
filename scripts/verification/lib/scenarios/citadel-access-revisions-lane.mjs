import assert from "node:assert/strict";

/** Uses the caller's disposable Gateway and browser; never provisions native volumes. */
export async function runCitadelAccessRevisionsScenario(context, deps, stack) {
  const { path, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun, NEXT_UI_PACKAGE } = deps;
  await runScenario(context, { id: "citadels.access-revisions", lane: "citadel-record-revisions",
    title: "Ward and Council changes reject competing access-rule edits and preserve drafts", subsystem: "library" }, async ({ correlationId }) => {
    const created = await requestJson(stack.gatewayUrl, "/api/v1/citadels", { method: "POST", body: {
      name: "Access Review Citadel", slug: "citadel-access-proof", kind: "custom" } });
    assertOk(created, "create owned access Citadel");
    const citadelId = created.body.citadelId;
    const baseUrl = `/api/v1/citadels/${citadelId}`;
    const workspace = await requestJson(stack.gatewayUrl, "/api/v1/workspaces", { method: "POST", body: { citadelId, name: "Access review workspace" } });
    assertOk(workspace, "create owned access workspace");
    const read = async () => { const result = await requestJson(stack.gatewayUrl, `${baseUrl}/access`); assertOk(result, "read access"); return result.body; };
    const mutate = async (suffix, method, body) => { const result = await requestJson(stack.gatewayUrl, baseUrl + suffix, { method, body }); assertOk(result, "owned peer mutation"); return result.body; };
    const initial = await read();
    const browser = await chromium.launch({ headless: true });
    let page; let browserLog; let logCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspace.body.workspaceId, citadelId);
      page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
      const artifacts = []; const receipts = [];
      const capture = async (slug) => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
      const waitMutation = (suffix, method) => page.waitForResponse((response) => new URL(response.url()).pathname === baseUrl + suffix && response.request().method() === method);
      const race = async (suffix, method, reviewed, peer) => {
        const state = { tokens: [], winner: null };
        await page.route(`**${baseUrl}${suffix}`, async (route) => {
          if (route.request().method() === method) {
            const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
            if (!state.winner) {
              assert.equal(input.expectedRevision, reviewed.revision);
              await peer(reviewed);
              state.winner = await read();
            }
          }
          await route.continue();
        });
        return state;
      };
      const reject = async (suffix, method, click, state) => {
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), 409);
        assert.equal((await response.json()).details?.reason, "CITADEL_ACCESS_REVISION_CONFLICT");
        assert.deepEqual(await read(), state.winner);
      };
      const accept = async (suffix, method, click, state) => {
        logCursor = browserLog.mark();
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), method === "POST" ? 201 : 200);
        const saved = await response.json();
        assert.notEqual(saved.revision, state.winner.revision);
        assert.deepEqual(state.tokens, [state.tokens[0], state.winner.revision]);
        assert.deepEqual(await read(), saved);
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ suffix, method, reviewed: state.tokens, winner: state.winner, saved });
        await page.unroute(`**${baseUrl}${suffix}`);
        return saved;
      };

      const agents = await requestJson(stack.gatewayUrl, "/api/v1/agents?view=active&limit=300");
      assertOk(agents, "read seeded agent catalog");
      assert.ok(agents.body.items.length >= 2);
      const peerAgent = agents.body.items[0], chosenAgent = agents.body.items[1];
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-wards"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-wards", readyText: "Wards" }, NEXT_UI_PACKAGE);
      await page.getByRole("button", { name: "Add Ward", exact: true }).click();
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Preserve this Ward draft");
      await page.getByRole("textbox", { name: "Action pattern", exact: true }).fill("shell.*");
      const addRace = await race("/wards", "POST", initial, (reviewed) => mutate("/council", "POST", { agentId: peerAgent.agentId, expectedRevision: reviewed.revision }));
      await reject("/wards", "POST", () => page.getByRole("button", { name: "Add Ward", exact: true }).last().click(), addRace);
      await page.getByRole("button", { name: "Use current access review", exact: true }).waitFor();
      assert.equal(await name.inputValue(), "Preserve this Ward draft");
      assert.equal(await page.getByRole("button", { name: "Add Ward", exact: true }).last().isEnabled(), false);
      await capture("citadel-ward-retained-draft-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok((await page.getByRole("button", { name: "Use current access review", exact: true }).boundingBox())?.height >= 44);
      await capture("citadel-ward-current-review-narrow");
      await page.getByRole("button", { name: "Use current access review", exact: true }).click();
      let current = await accept("/wards", "POST", () => page.getByRole("button", { name: "Add Ward", exact: true }).last().click(), addRace);
      const ward = current.wards.find((item) => item.name === "Preserve this Ward draft");
      assert.ok(ward);
      const wardPath = "/wards/" + ward.wardId;
      const removeRace = await race(wardPath, "DELETE", current, (reviewed) => mutate("/integrations", "POST", { provider: "calendar", capabilities: ["read"], mode: "read", expectedRevision: reviewed.revision }));
      await page.getByRole("button", { name: "Delete Ward", exact: true }).click();
      await reject(wardPath, "DELETE", () => page.getByRole("button", { name: "Confirm delete Ward", exact: true }).click(), removeRace);
      await page.getByRole("button", { name: "Use current access review", exact: true }).waitFor();
      await capture("citadel-ward-delete-conflict-narrow");
      assert.ok((await read()).wards.some((item) => item.wardId === ward.wardId));
      await page.getByRole("button", { name: "Use current access review", exact: true }).click();
      await page.getByRole("button", { name: /Preserve this Ward draft/ }).click();
      await page.getByRole("button", { name: "Delete Ward", exact: true }).click();
      await capture("citadel-ward-reviewed-delete-narrow");
      current = await accept(wardPath, "DELETE", () => page.getByRole("button", { name: "Confirm delete Ward", exact: true }).click(), removeRace);
      assert.equal(current.wards.length, 0);

      await page.setViewportSize({ width: 1440, height: 1080 });
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-council"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-council", readyText: "Council" }, NEXT_UI_PACKAGE);
      await page.locator("#council-manage > summary").click();
      await page.getByRole("combobox", { name: "Council agent", exact: true }).selectOption(chosenAgent.agentId);
      const councilRace = await race("/council", "POST", current, (reviewed) => mutate("/wards", "POST", { name: "Peer rule before seating", actionPattern: "file.*", effect: "deny", expectedRevision: reviewed.revision }));
      await reject("/council", "POST", () => page.getByRole("button", { name: "Seat", exact: true }).click(), councilRace);
      await page.getByRole("button", { name: "Use current access review", exact: true }).waitFor();
      assert.equal(await page.getByRole("combobox", { name: "Council agent", exact: true }).inputValue(), chosenAgent.agentId);
      assert.equal(await page.getByRole("button", { name: "Seat", exact: true }).isEnabled(), false);
      await capture("citadel-council-conflict-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Use current access review", exact: true }).click();
      current = await accept("/council", "POST", () => page.getByRole("button", { name: "Seat", exact: true }).click(), councilRace);
      assert.equal(current.council.filter((item) => item.agentId === chosenAgent.agentId).length, 1);
      await page.getByText("Agent seated in this Citadel.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      await capture("citadel-council-committed-narrow");
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "citadel-access-revisions.json");
      await writeJson(diagnostics, { citadelId, workspaceId: workspace.body.workspaceId, initial, receipts, terminal: current,
        note: "Three real competing access writes rejected with 409 and three explicit reviewed retries saved. Ward drafts and selected Council agents preserved; deletion re-confirmed. No native volumes or live providers used." });
      const combined = Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key] ?? [])]));
      combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
      return { status: "passed", metrics: { staleMutationsRejected: 3, reviewedMutations: 3, narrowWidth: 390 }, artifacts: combined };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "citadel-access-revisions-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
