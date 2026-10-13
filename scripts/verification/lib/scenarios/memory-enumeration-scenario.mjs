import assert from "node:assert/strict";
import { captureMemoryRecoveryVisual } from "./memory-recovery-visual.mjs";

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
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "memory", readyText: "Memory" }, NEXT_UI_PACKAGE);
      const memoryResponse = () => page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/memory/items" && url.searchParams.get("query") === query && response.status() === 200;
      });
      const search = async () => {
        await page.getByRole("combobox", { name: "Memory status", exact: true }).selectOption("all");
        await page.getByRole("textbox", { name: "Search memory", exact: true }).fill(query);
        const [response] = await Promise.all([memoryResponse(), page.getByRole("button", { name: "Apply memory filter", exact: true }).click()]);
        return response.json();
      };
      const inspectPage = async value => {
        assert.equal(value.items.every(item => item.workspaceId === workspaceId), true);
        const names = value.items.map(item => `Select memory ${item.title}`).sort();
        await page.waitForFunction(({ prefix, names }) => {
          const actual = [...document.querySelectorAll('input[type="checkbox"][aria-label]')]
            .map(element => element.getAttribute("aria-label")).filter(name => name.startsWith(prefix)).sort();
          return JSON.stringify(actual) === JSON.stringify(names);
        }, { prefix: `Select memory ${query} item `, names });
        return value.items.map(item => item.itemId);
      };
      const enumerateBrowser = async (value, total) => {
        const ids = [];
        for (let pages = 0; ; pages++) {
          assert.ok(pages < 20, "the canonical browser enumeration must settle within its bounded page count");
          assert.equal(value.total, total);
          ids.push(...await inspectPage(value));
          if (!value.nextCursor) break;
          const [response] = await Promise.all([memoryResponse(), page.getByRole("button", { name: "Next memory page", exact: true }).click()]);
          value = await response.json();
        }
        assert.equal(await page.getByRole("button", { name: "Next memory page", exact: true }).isDisabled(), true);
        assert.equal(ids.length, total);
        assert.equal(new Set(ids).size, total);
        return ids;
      };
      const visibleIds = await enumerateBrowser(await search(), 503);
      assert.equal(visibleIds.length, 503);
      assert.deepEqual(new Set(visibleIds), new Set(expectedIds));
      assertBrowserConsoleHealthy(browserLog, browserCursor, NEXT_UI_PACKAGE);
      const artifacts = await captureBrowserArtifacts(context, { slug: "memory-complete-enumeration", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor: browserCursor });

      await page.reload({ waitUntil: "domcontentloaded" });
      await inspectPage(await search());
      // Commit the real fixture mutation after the browser has selected its
      // continuation, before that request reaches the real Gateway. This avoids
      // the search debounce racing the seed and legitimately issuing a fresh cursor.
      let insertedDuringContinuation = false, insertedId;
      await page.route("**/api/v1/memory/items?*", async route => {
        if (!insertedDuringContinuation && new URL(route.request().url()).searchParams.has("cursor")) {
          insertedDuringContinuation = true;
          insertedId = await seed(503);
        }
        await route.continue();
      });
      const [staleResponse] = await Promise.all([
        page.waitForResponse(response => response.url().includes("/api/v1/memory/items?") && new URL(response.url()).searchParams.has("cursor")),
        page.getByRole("button", { name: "Next memory page", exact: true }).click(),
      ]);
      assert.ok(insertedDuringContinuation);
      assert.equal(staleResponse.status(), 409, "a mutation committed before continuation must invalidate its cursor");
      assert.equal((await staleResponse.json()).details?.reason, "MEMORY_CURSOR_STALE");
      await page.getByRole("button", { name: "Reload memory directory", exact: true }).waitFor();
      await page.getByRole("alert").filter({ hasText: "Memory changed while paging. Reload the directory to read the current records." }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Next memory page", exact: true }).isDisabled(), true);
      assert.equal(await page.getByText("API error 409", { exact: false }).count(), 0);
      assert.equal(await page.getByText("MEMORY_CURSOR_STALE", { exact: false }).count(), 0);
      const staleArtifacts = await captureMemoryRecoveryVisual(context, stack, deps, {
        slug: "memory-stale-enumeration", page, browserLog, correlationId, logCursor: browserCursor });
      const [reloaded] = await Promise.all([memoryResponse(), page.getByRole("button", { name: "Reload memory directory", exact: true }).click()]);
      const afterIds = await enumerateBrowser(await reloaded.json(), 504);
      assert.deepEqual(new Set(afterIds), new Set([...expectedIds, insertedId]));
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
