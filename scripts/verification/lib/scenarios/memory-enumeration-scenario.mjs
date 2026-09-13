import assert from "node:assert/strict";

/** Real Gateway and browser journey, using only the lane's fresh fixture runtime. */
export async function runMemoryEnumerationScenario(context, stack, deps) {
  const { runScenario, requestJson, assertOk, randomUUID, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, NEXT_UI_PACKAGE,
    captureBrowserArtifacts, assertBrowserConsoleHealthy, path, writeJson, relativeToRun } = deps;
  await runScenario(context, {
    id: "memory-truth.complete-enumeration",
    lane: "memory-truth",
    title: "Memory enumerates beyond 500, preserves workspace scope and reloads after canonical mutation",
    subsystem: "memory",
  }, async ({ correlationId }) => {
    const createWorkspace = async name => {
      const result = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
        method: "POST", body: { workspaceName: name, sessionTitle: name, sessionCount: 1, longThreadTurns: 2 },
      });
      assertOk(result, "create memory enumeration fixture workspace");
      assert.ok(result.body?.workspaceId);
      return result.body.workspaceId;
    };
    const workspaceId = await createWorkspace("Memory enumeration workspace");
    const foreignWorkspaceId = await createWorkspace("Memory enumeration foreign workspace");
    const query = `Enumeration ${randomUUID().slice(0, 8)}`;
    const seed = async (index, owner = workspaceId) => {
      const result = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
        method: "POST", body: { workspaceId: owner, namespace: "enumeration-proof",
          title: `${query} item ${String(index).padStart(4, "0")}`, content: "Local pagination fixture.", metadata: {} },
      });
      assertOk(result, "seed memory enumeration item");
      assert.equal(result.body.workspaceId, owner);
      assert.ok(result.body.itemId);
      return result.body.itemId;
    };
    const expectedIds = [];
    for (let offset = 0; offset < 503; offset += 8) {
      expectedIds.push(...await Promise.all(Array.from({ length: Math.min(8, 503 - offset) }, (_, index) => seed(offset + index))));
    }
    const foreignId = await seed("foreign", foreignWorkspaceId);
    const list = (extra = {}) => requestJson(stack.gatewayUrl, `/api/v1/memory/items?${new URLSearchParams({ workspaceId, query, status: "all", limit: "500", ...extra })}`);
    const first = await list();
    assertOk(first, "list first enumeration page");
    assert.equal(first.body.total, 503);
    assert.equal(first.body.items.length, 500);
    assert.ok(first.body.nextCursor);
    const second = await list({ cursor: first.body.nextCursor });
    assertOk(second, "list final enumeration page");
    assert.equal(second.body.total, 503);
    assert.equal(second.body.snapshotAt, first.body.snapshotAt);
    assert.equal(second.body.nextCursor, undefined);
    const allIds = [...first.body.items, ...second.body.items].map(item => item.itemId);
    assert.equal(allIds.length, 503);
    assert.deepEqual(new Set(allIds), new Set(expectedIds));
    assert.ok(!allIds.includes(foreignId));
    const wrongScope = await list({ cursor: first.body.nextCursor, workspaceId: foreignWorkspaceId });
    assert.equal(wrongScope.status, 409);
    assert.equal(wrongScope.body.details?.reason, "MEMORY_CURSOR_SCOPE_MISMATCH");

    const browser = await chromium.launch({ headless: true });
    let page;
    let browserLog;
    let browserCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1024 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspaceId);
      page = await browserContext.newPage();
      browserLog = attachBrowserLogging(page);
      browserCursor = browserLog.mark();
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/memory"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "memory", readyText: "Memory items" }, NEXT_UI_PACKAGE);
      await page.getByRole("searchbox", { name: "Search memory", exact: true }).fill(query);
      await page.getByText("500 of 503 total", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Load more memory", exact: true }).click();
      await page.getByText("503 of 503 total", { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Load more memory", exact: true }).count(), 0);
      const visibleIds = await page.locator('button[id^="memory-list-item-"]').evaluateAll(elements => elements.map(element => element.id.slice("memory-list-item-".length)));
      assert.equal(visibleIds.length, 503);
      assert.deepEqual(new Set(visibleIds), new Set(expectedIds));
      assertBrowserConsoleHealthy(browserLog, browserCursor, NEXT_UI_PACKAGE);
      const artifacts = await captureBrowserArtifacts(context, { slug: "memory-complete-enumeration", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor: browserCursor });

      const refreshedSearch = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/memory/items" && url.searchParams.get("query") === query &&
          !url.searchParams.has("cursor") && response.status() === 200;
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("searchbox", { name: "Search memory", exact: true }).fill(query);
      await (await refreshedSearch).finished();
      await page.getByText("500 of 503 total", { exact: false }).waitFor();
      // Commit the real fixture mutation after the browser has selected its
      // continuation, before that request reaches the real Gateway. This avoids
      // the search debounce racing the seed and legitimately issuing a fresh cursor.
      let insertedDuringContinuation = false;
      await page.route("**/api/v1/memory/items?*", async route => {
        if (!insertedDuringContinuation && new URL(route.request().url()).searchParams.has("cursor")) {
          insertedDuringContinuation = true;
          await seed(503);
        }
        await route.continue();
      });
      const [staleResponse] = await Promise.all([
        page.waitForResponse(response => response.url().includes("/api/v1/memory/items?") && new URL(response.url()).searchParams.has("cursor")),
        page.getByRole("button", { name: "Load more memory", exact: true }).click(),
      ]);
      assert.ok(insertedDuringContinuation);
      assert.equal(staleResponse.status(), 409, "a mutation committed before continuation must invalidate its cursor");
      assert.equal((await staleResponse.json()).details?.reason, "MEMORY_CURSOR_STALE");
      await page.getByRole("button", { name: "Reload memory", exact: true }).waitFor();
      await page.getByText("Loaded results may be out of date", { exact: false }).waitFor();
      assert.equal(await page.getByText("API error 409", { exact: false }).count(), 0);
      assert.equal(await page.getByText("MEMORY_CURSOR_STALE", { exact: false }).count(), 0);
      const staleArtifacts = await captureBrowserArtifacts(context, { slug: "memory-stale-enumeration", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor: browserCursor });
      await page.getByRole("button", { name: "Reload memory", exact: true }).click();
      await page.getByText("500 of 504 total", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Load more memory", exact: true }).click();
      await page.getByText("504 of 504 total", { exact: false }).waitFor();
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "memory-enumeration.json");
      await writeJson(diagnostics, { workspaceId, foreignWorkspaceId, expectedIds, apiIds: allIds, browserIds: visibleIds,
        total: 503, afterMutationTotal: 504, wrongScopeStatus: wrongScope.status, staleStatus: 409,
        note: "The final browser log intentionally includes the asserted stale-cursor HTTP 409." });
      return { status: "passed", metrics: { apiItems: allIds.length, browserItems: visibleIds.length, afterMutationTotal: 504 },
        artifacts: Object.fromEntries(Object.keys(artifacts).map(key => [key,
          [...artifacts[key], ...(staleArtifacts[key] ?? []), ...(key === "diagnostics" ? [relativeToRun(context, diagnostics)] : [])]])) };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "memory-enumeration-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor: browserCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
