import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertMcpEditorOwnerAgreement({ before, request, receipt, owner, label, category }) {
  assert.deepEqual(request, { expectedRevision: before.revision, label, command: before.command, enabled: false, category });
  assert.equal(owner.serverId, before.serverId);
  assert.match(owner.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(owner.revision, before.revision);
  assert.equal(owner.label, label); assert.equal(owner.category, category); assert.equal(owner.enabled, false);
  assert.equal(owner.status, "disconnected");
  for (const key of ["transport", "connectionMode", "command", "args", "url", "authType", "oauth", "policy", "trustTier", "costTier", "createdAt"]) {
    assert.deepEqual(owner[key], before[key], `Saved editor changed unowned ${key}`);
  }
  assert.deepEqual(receipt, owner);
}

/** Creates a disabled fixture server in the disposable stack. Never connects it or invokes a process/tool. */
export async function runCockpitMcpEditorProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "MCP editor proof requires an isolated runtime");
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-editor.${variant}`, lane: "ux-budgets",
      title: `Cockpit MCP exact saved configuration ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "create disabled fixture";
      let browserContext, page;
      const writes = [], screenshots = [], unexpected = [];
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const label = `UX MCP editor ${variant} ${Date.now()}`;
        const initial = await api("/api/v1/mcp/servers", { method: "POST", body: { label, transport: "stdio", command: "node", args: ["--version"],
          enabled: false, authType: "none", category: "development", trustTier: "restricted", costTier: "free",
          policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] } } });
        const serverRoute = `/api/v1/mcp/servers/${encodeURIComponent(initial.serverId)}`;
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (pathname === serverRoute && request.method() === "PATCH") writes.push(request.postDataJSON());
          else unexpected.push(`${request.method()} ${pathname}`);
        });
        stage = "open exact saved server editor";
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Edit saved MCP server", exact: true });
        await editor.getByLabel("Label", { exact: true }).fill(`${label} edited`);
        await editor.getByLabel("Category", { exact: true }).selectOption("research");
        stage = "cancel exact field review and guarded leave";
        await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
        await editor.getByRole("region", { name: "Review MCP server changes", exact: true }).waitFor();
        await capture("review");
        await editor.getByRole("button", { name: "Cancel review", exact: true }).click();
        await editor.getByRole("button", { name: "Close editor", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        await leave.waitFor(); assert.equal(await leave.getByRole("button", { name: "Save and continue", exact: true }).count(), 0);
        await leave.getByRole("button", { name: "Cancel", exact: true }).click(); assert.deepEqual(writes, []);
        assert.deepEqual(await api(serverRoute), initial);
        stage = "save reviewed configuration";
        const save = async () => {
          await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
          const responsePromise = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === serverRoute);
          await editor.getByRole("button", { name: "Save reviewed MCP configuration", exact: true }).click();
          const response = await responsePromise; assert.equal(response.status(), 200);
          await editor.getByText("MCP server updated.", { exact: true }).waitFor(); return response.json();
        };
        const receipt = await save(); let owner = await api(serverRoute);
        assertMcpEditorOwnerAgreement({ before: initial, request: writes[0], receipt, owner, label: `${label} edited`, category: "research" });
        await capture("saved");
        stage = "withhold stale draft until new exact owner review";
        await editor.getByLabel("Label", { exact: true }).fill(`${label} retained`);
        await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
        const peer = await api(serverRoute, { method: "PATCH", body: { expectedRevision: owner.revision, label: `${label} peer` } });
        await editor.getByRole("button", { name: "Save reviewed MCP configuration", exact: true }).click();
        const currentReview = editor.getByRole("region", { name: "Current MCP server review", exact: true });
        await currentReview.getByText(`${label} peer`, { exact: true }).waitFor(); assert.equal(writes.length, 1);
        assert.equal(await editor.getByLabel("Label", { exact: true }).inputValue(), `${label} retained`);
        await capture("stale-review");
        await currentReview.getByRole("button", { name: "Use current server review", exact: true }).click(); assert.equal(writes.length, 1);
        const second = await save(); owner = await api(serverRoute);
        assertMcpEditorOwnerAgreement({ before: peer, request: writes[1], receipt: second, owner, label: `${label} retained`, category: "research" });
        stage = "retain unknown acknowledgement without duplicate save";
        await editor.getByLabel("Label", { exact: true }).fill(`${label} uncertain`);
        let uncertainReceipt;
        const loseResponse = async (route) => { if (route.request().method() !== "PATCH") return route.continue(); const response = await route.fetch();
          assert.equal(response.status(), 200); uncertainReceipt = await response.json(); await route.abort("failed"); };
        await page.route(`**${serverRoute}`, loseResponse);
        await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
        await editor.getByRole("button", { name: "Save reviewed MCP configuration", exact: true }).click();
        await editor.getByText(/^MCP save outcome is unconfirmed/).first().waitFor(); assert.equal(writes.length, 3);
        assertMcpEditorOwnerAgreement({ before: owner, request: writes[2], receipt: uncertainReceipt, owner: await api(serverRoute), label: `${label} uncertain`, category: "research" });
        await page.unroute(`**${serverRoute}`, loseResponse);
        await capture("unknown-locked");
        await editor.getByRole("button", { name: "Close editor", exact: true }).click();
        await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        assert.equal(await panel.getByRole("button", { name: `Edit ${label} uncertain`, exact: true }).isDisabled(), true);
        assert.deepEqual(unexpected, []); assert.equal(writes.length, 3);
        return { status: "passed", metrics: { exactOwnerAgreement: true, cancelWrites: 0, staleWritePrevented: true, guardedLeave: true,
          browserSaves: writes.length, responseLossInjected: true, sharedUnknownLock: true, blockingAxe: 0,
          limitation: "Disabled disposable stdio configuration only. No connection, process launch, OAuth, credentials update or tool invocation." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-mcp-editor-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve the original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserSaves: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page); assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-mcp-editor-${variant}-${name}.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      }
    });
  }
}
