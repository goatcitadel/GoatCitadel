import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

/** Validate every visible row against its exact owner position and native URL. */
export function assertHistoryWindow(rows, expected) {
  assert.ok(rows.length > 0 && rows.length < expected.length, "History rows must remain windowed");
  const positions = rows.map(row => row.position);
  assert.equal(new Set(positions).size, positions.length, "History window duplicated a position");
  for (const [index, row] of rows.entries()) {
    assert.equal(row.total, expected.length, "History window lost its owner total");
    assert.ok(Number.isSafeInteger(row.position) && row.position >= 1 && row.position <= expected.length);
    assert.equal(row.href, expected[row.position - 1], "History window lost or mixed an owner record");
    if (index) assert.equal(row.position, rows[index - 1].position + 1, "History window reordered records");
  }
}

/** Persist waiting runs only in the lane's disposable Gateway; no workflow is executed. */
export async function runCockpitWorkHistoryProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  let fixture;
  async function seedHistory() {
    const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
      method: "POST", body: { workspaceName: "Durable history proof", sessionTitle: "History owner", sessionCount: 1, longThreadTurns: 2 },
    });
    assertOk(seeded, "seed isolated history workspace");
    const workspaceId = seeded.body?.workspaceId;
    if (!workspaceId) throw new Error("History proof has no workspace.");
    const runIds = [];
    for (let index = 0; index < 101; index += 1) {
      const result = await requestJson(stack.gatewayUrl, "/api/v1/durable/runs", { method: "POST", body: {
        workflowKey: "verification.history.wait", payload: { workspaceId },
        metadata: { workspaceId, objective: `Saved history record ${String(index + 1).padStart(3, "0")}` },
        waitForEvent: { eventKey: "verification.history.never-sent" },
      } });
      assertOk(result, "create saved history fixture");
      if (!result.body?.runId || result.body.status !== "waiting") throw new Error("History fixture did not remain waiting.");
      runIds.push(result.body.runId);
    }
    for (const [kind, payload, metadata] of [
      ["foreign", { workspaceId: "foreign-history-workspace" }, {}],
      ["unbound", {}, {}],
      ["conflicting", { workspaceId }, { workspaceId: "foreign-history-workspace" }],
    ]) {
      const result = await requestJson(stack.gatewayUrl, "/api/v1/durable/runs", { method: "POST", body: {
        workflowKey: "verification.history.wait", payload,
        metadata: { ...metadata, objective: `Excluded ${kind} history record` },
        waitForEvent: { eventKey: "verification.history.never-sent" },
      } });
      assertOk(result, `seed ${kind} scope exclusion`);
    }
    return { workspaceId, runIds };
  }
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-work-history.${variant}`, lane: "ux-budgets",
      title: `Cockpit saved Work history ${variant}`, subsystem: "mission-control-ux" }, async () => {
      fixture ??= await seedHistory();
      const query = new URLSearchParams({ workspaceId: fixture.workspaceId, limit: "100" });
      const first = await requestJson(stack.gatewayUrl, `/api/v1/durable/runs?${query}`);
      assertOk(first, "read first scoped history page");
      if (first.body?.items?.length !== 100 || !first.body.nextCursor) throw new Error("History first page has no continuation.");
      query.set("cursor", first.body.nextCursor);
      const second = await requestJson(stack.gatewayUrl, `/api/v1/durable/runs?${query}`);
      assertOk(second, "read second scoped history page");
      const expected = [...first.body.items, ...second.body.items];
      if (expected.length !== 101 || second.body.nextCursor
        || new Set(expected.map((run) => run.runId)).size !== 101
        || !expected.every((run) => fixture.runIds.includes(run.runId))) throw new Error("Scoped history owner lost or mixed saved runs.");
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
      try {
        await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
        await browserContext.addInitScript((theme) => window.localStorage.setItem("goatcitadel.ui.theme.v1", theme), variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, citadelId);
        const page = await browserContext.newPage();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/work/history?shell=cockpit"), { waitUntil: "domcontentloaded" });
        const list = page.getByRole("list", { name: "Durable run history" });
        await list.waitFor({ timeout: 30_000 });
        await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, variant === "mobile" ? "light" : "dark");
        const links = () => list.getByRole("link", { name: "Open run record" }).evaluateAll((items) => items.map((item) => item.getAttribute("href")));
        const expectedLinks = (runs) => runs.map((run) => `/work/runs/${encodeURIComponent(run.runId)}?shell=cockpit`);
        if (JSON.stringify(await links()) !== JSON.stringify(expectedLinks(first.body.items))) throw new Error("History UI differs from first owner page.");
        await page.getByRole("button", { name: "Load older runs", exact: true }).click();
        await page.getByText("101 saved runs loaded.", { exact: false }).waitFor();
        const wanted = expectedLinks(expected), visited = new Map();
        // Traverse the real keyboard owner instead of timed scroll jumps while
        // Virtuoso is measuring row heights. Every position must receive focus.
        const firstLink = list.locator("li[aria-posinset='1']").getByRole("link", { name: "Open run record" });
        await firstLink.focus();
        await page.keyboard.press("Home");
        let maxMounted = 0;
        for (let position = 1; position <= wanted.length; position += 1) {
          await page.waitForFunction((expectedPosition) =>
            document.activeElement?.closest("li[aria-posinset]")?.getAttribute("aria-posinset") === String(expectedPosition), position);
          const rows = await list.locator("li[aria-posinset]").evaluateAll(items => items.map(item => ({
            position: Number(item.getAttribute("aria-posinset")), total: Number(item.getAttribute("aria-setsize")),
            href: item.querySelector("a")?.getAttribute("href"),
          })));
          assertHistoryWindow(rows, wanted); maxMounted = Math.max(maxMounted, rows.length);
          assert.ok(rows.some(row => row.position === position), "Focused history owner is not mounted");
          for (const row of rows) visited.set(row.position, row.href);
          if (position < wanted.length) await page.keyboard.press("ArrowDown");
        }
        assert.deepEqual([...visited].sort(([a], [b]) => a - b).map(([, href]) => href), wanted,
          "History pagination lost, duplicated or made owner records unreachable");
        await page.keyboard.press("Home");
        await list.locator("li[aria-posinset='1']").getByRole("link", { name: "Open run record" }).waitFor();
        if ((await page.locator("main").innerText()).includes("Excluded ")) throw new Error("Foreign or unbound record leaked into history.");
        await page.getByRole("heading", { name: "Durable runs", exact: true }).scrollIntoViewIfNeeded();
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (blocking.length || overflow > 1) throw new Error(`History ${variant}: accessibility ${blocking.map((item) => item.id).join(", ") || "clear"}; overflow ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-work-history-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        await list.locator("li[aria-posinset='1']").getByRole("link", { name: "Open run record" }).click();
        await page.getByRole("heading", { name: expected[0].metadata.objective, exact: true }).waitFor();
        return { status: "passed", metrics: { savedRuns: expected.length, pages: 2, visitedOwnerRows: visited.size, maxMountedRows: maxMounted, excludedScopes: 3, blockingAxe: 0, overflow },
          artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } finally {
        await browserContext.close();
      }
    });
  }
}
