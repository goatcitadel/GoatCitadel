import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertMcpEnabledSaved({ before, after, receipt, request, enabled }) {
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  assert.match(after.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(request, { expectedRevision: before.revision, enabled });
  assert.equal(after.enabled, enabled);
  for (const key of ["serverId", "label", "transport", "connectionMode", "command", "args", "url", "authType", "oauth", "policy", "trustTier", "category", "costTier", "createdAt"]) {
    assert.deepEqual(after[key], before[key], `MCP enabled control changed ${key}.`);
  }
  assert.equal(after.status, "disconnected", "Configuration proof must not connect or invoke the server.");
  assert.deepEqual(receipt, after, "Saved MCP receipt differs from canonical readback.");
}

/** Uses a disposable server record; never connects, starts a process, or invokes tools. */
export async function runCockpitMcpServersProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "MCP proof needs an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "MCP saved-state proof owner request"); return response.body;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-servers.${variant}`, lane: "ux-budgets",
      title: `Cockpit reviewed MCP saved state ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const label = `UX MCP ${variant}-${Date.now()}`;
      const initial = await api("/api/v1/mcp/servers", { method: "POST", body: {
        label, transport: "stdio", command: "node", args: ["--version"], enabled: false,
        authType: "none", category: "development", trustTier: "restricted", costTier: "free",
        policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] },
      } });
      const route = `/api/v1/mcp/servers/${encodeURIComponent(initial.serverId)}`;
      const read = () => api(route);
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = []; const writes = []; let page;
      try {
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/"))
            writes.push({ pathname, method: request.method(), body: request.postDataJSON() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        await panel.scrollIntoViewIfNeeded();
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        await panel.getByText("Saved server details", { exact: true }).click();
        const details = panel.locator("details[open]");
        assert.ok((await details.innerText()).includes(initial.serverId));
        assert.ok((await details.innerText()).includes(initial.revision));
        await panel.getByText("Saved server details", { exact: true }).click();
        await page.addScriptTag({ path: axeSourcePath });
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const audit = async stage => {
          const axe = await auditPageAccessibility(page);
          const violations = axe.violations.filter(item => ["serious", "critical"].includes(item.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(violations.length, 0, `MCP ${stage} accessibility: ${violations.map(item => item.id).join(", ")}`);
          assert.ok(overflow <= 1, `MCP ${stage} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-mcp-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          return overflow;
        };
        const dialog = page.getByRole("dialog", { name: "Change saved MCP server state?", exact: true });
        await panel.getByRole("button", { name: `Review enable ${label}`, exact: true }).click(); await dialog.waitFor();
        assert.ok((await dialog.innerText()).includes("Disabled → Enabled"));
        assert.ok((await dialog.innerText()).includes("closes current connections"));
        assert.deepEqual(writes, []); assert.deepEqual(await read(), initial);
        for (const name of ["Apply reviewed MCP state", "Keep current MCP state"]) {
          const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
          assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name} outside viewport`);
        }
        await audit("review");
        await dialog.getByRole("button", { name: "Keep current MCP state", exact: true }).click();
        await dialog.waitFor({ state: "hidden" }); assert.deepEqual(writes, []);
        let before = initial;
        for (const enabled of [true, false]) {
          await panel.getByRole("button", { name: `Review ${enabled ? "enable" : "disable"} ${label}`, exact: true }).click(); await dialog.waitFor();
          const responsePromise = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === route);
          await dialog.getByRole("button", { name: "Apply reviewed MCP state", exact: true }).click();
          const response = await responsePromise; assert.equal(response.status(), 200);
          await dialog.waitFor({ state: "hidden" });
          await panel.getByRole("button", { name: `Review ${enabled ? "disable" : "enable"} ${label}`, exact: true }).waitFor();
          const after = await read();
          assertMcpEnabledSaved({ before, after, receipt: await response.json(), request: response.request().postDataJSON(), enabled });
          await panel.getByText(`MCP server ${label} ${enabled ? "enabled" : "disabled"}. Saved configuration confirmed; connectivity and tool permission are separate.`, { exact: true }).waitFor();
          before = after; await panel.scrollIntoViewIfNeeded(); await audit(enabled ? "enabled" : "disabled");
        }
        assert.equal(writes.length, 2);
        assert.ok(writes.every(write => write.pathname === route && write.method === "PATCH"));
        await panel.getByRole("button", { name: `Review enable ${label}`, exact: true }).click(); await dialog.waitFor();
        const peer = await api(route, { method: "PATCH", body: { expectedRevision: before.revision, label: `${label} reviewed elsewhere` } });
        await dialog.getByRole("button", { name: "Apply reviewed MCP state", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await panel.getByText("The MCP server changed. Review its current configuration before applying the retained draft.", { exact: true }).waitFor();
        assert.equal(writes.length, 2, "Stale MCP review sent a mutation.");
        assert.equal((await read()).revision, peer.revision);
        await panel.scrollIntoViewIfNeeded(); const overflow = await audit("stale-guard");
        return { status: "passed", metrics: { browserMutations: 2, cancelledReviewMutations: 0, staleMutationPrevented: true,
          exactRevisionsConfirmed: true, enabledThenDisabled: true, toolsInvoked: 0, blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            await page.getByRole("region", { name: "MCP server configuration", exact: true }).scrollIntoViewIfNeeded({ timeout: 2_000 });
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-mcp-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Keep the original failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally {
        await browserContext.close();
        const current = await read(); await api(route, { method: "DELETE", body: { expectedRevision: current.revision } });
      }
    });
  }
}
