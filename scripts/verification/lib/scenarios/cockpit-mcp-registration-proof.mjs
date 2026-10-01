import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertMcpRegistrationAgreement({ request, receipt, owner, label, existingIds = [] }) {
  assert.deepEqual(request, { label, transport: "stdio", command: "node", args: ["--version"], authType: "none", enabled: false,
    category: "development", trustTier: "restricted", costTier: "unknown",
    policy: { requireFirstToolApproval: false, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] } });
  assert.ok(receipt.serverId && !existingIds.includes(receipt.serverId));
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.equal(receipt.status, "disconnected");
  for (const [key, value] of Object.entries(request)) assert.deepEqual(receipt[key], value);
  assert.deepEqual(receipt, owner);
}

/** Real disabled registration/deletion and cached reads in the disposable Gateway. No transport execution. */
export async function runCockpitMcpRegistrationProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "MCP registration proof requires an isolated runtime");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-registration.${variant}`, lane: "ux-budgets",
      title: `Native MCP reviewed registration, deletion and cached inspection ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "prepare isolated browser", browserContext, page;
      const writes = [], screenshots = [], unexpected = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const label = `UX MCP registration ${variant} ${Date.now()}`, before = await api("/api/v1/mcp/servers");
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const route = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !route.startsWith("/api/v1/")) return;
          if ((route === "/api/v1/mcp/servers" && request.method() === "POST") || (/^\/api\/v1\/mcp\/servers\/[^/]+$/.test(route) && request.method() === "DELETE"))
            writes.push({ method: request.method(), route, body: request.postDataJSON() });
          else unexpected.push(`${request.method()} ${route}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        const registration = page.getByRole("dialog", { name: "Register MCP server", exact: true });
        async function fillRegistration(value) {
          await panel.getByRole("button", { name: "Register MCP server", exact: true }).click();
          await registration.getByLabel("Server label", { exact: true }).fill(value);
          await registration.getByLabel("Command", { exact: true }).fill("node");
          await registration.getByLabel("Arguments (one per line)", { exact: true }).fill("--version");
          await registration.getByRole("checkbox", { name: "Save as enabled", exact: true }).uncheck();
          await registration.getByRole("button", { name: "Review MCP registration", exact: true }).click();
        }
        stage = "review and cancel registration";
        await fillRegistration(label);
        assert.ok((await registration.innerText()).includes("No connection, process launch, OAuth handshake or tool call is performed."));
        await capture("create-review");
        await registration.getByRole("button", { name: "Cancel registration review", exact: true }).click(); assert.deepEqual(writes, []);
        await registration.getByRole("button", { name: "Close registration", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        await leave.waitFor(); assert.equal(await leave.getByRole("button", { name: "Save and continue", exact: true }).count(), 0);
        await leave.getByRole("button", { name: "Cancel", exact: true }).click(); assert.deepEqual(writes, []);
        stage = "register reviewed disabled configuration";
        await registration.getByRole("button", { name: "Review MCP registration", exact: true }).click();
        const createdResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/mcp/servers");
        await registration.getByRole("button", { name: "Register reviewed MCP server", exact: true }).click();
        const created = await createdResponse; assert.equal(created.status(), 201); const receipt = await created.json();
        await registration.getByText(/registered and saved configuration confirmed/).waitFor();
        const serverRoute = `/api/v1/mcp/servers/${encodeURIComponent(receipt.serverId)}`;
        assertMcpRegistrationAgreement({ request: writes[0].body, receipt, owner: await api(serverRoute), label, existingIds: before.items.map((item) => item.serverId) });
        await capture("created"); await registration.getByRole("button", { name: "Close registration", exact: true }).click();
        stage = "inspect exact cached owner without execution";
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        const inspection = page.getByRole("dialog", { name: "MCP server inspection", exact: true });
        await inspection.getByText(receipt.serverId, { exact: true }).waitFor();
        assert.deepEqual((await api(`${serverRoute}/tools`)).items, []);
        await inspection.getByText("No cached tools are recorded for this server.", { exact: true }).waitFor();
        assert.ok((await inspection.innerText()).includes("does not connect a server")); assert.equal(writes.length, 1);
        await capture("inspection"); await inspection.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "cancel deletion and reject stale owner review";
        const deletion = page.getByRole("dialog", { name: "Delete saved MCP server", exact: true });
        await panel.getByRole("button", { name: `Review delete ${label}`, exact: true }).click();
        await deletion.getByRole("button", { name: "Keep MCP server", exact: true }).click(); assert.equal(writes.length, 1);
        await panel.getByRole("button", { name: `Review delete ${label}`, exact: true }).click();
        const peer = await api(serverRoute, { method: "PATCH", body: { expectedRevision: receipt.revision, category: "research" } });
        await deletion.getByRole("button", { name: "Delete reviewed MCP server", exact: true }).click();
        await deletion.waitFor({ state: "hidden" }); await panel.getByText(/^The server changed\. Refresh and review/).waitFor();
        assert.equal(writes.length, 1); assert.deepEqual(await api(serverRoute), peer); await capture("stale-delete");
        stage = "delete only after a new exact revision review";
        await panel.getByRole("button", { name: `Review delete ${label}`, exact: true }).click();
        await deletion.getByText(peer.revision, { exact: true }).waitFor();
        const deletedResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === serverRoute);
        await deletion.getByRole("button", { name: "Delete reviewed MCP server", exact: true }).click();
        const deleted = await deletedResponse; assert.equal(deleted.status(), 200); assert.deepEqual(await deleted.json(), { deleted: true });
        await deletion.waitFor({ state: "hidden" });
        assert.deepEqual(writes[1], { method: "DELETE", route: serverRoute, body: { expectedRevision: peer.revision } });
        const absent = await requestJson(stack.gatewayUrl, serverRoute); assert.equal(absent.status, 404); assert.equal(absent.body.code, "ENTITY_NOT_FOUND");
        stage = "retain committed-response loss across native remount";
        const unknownLabel = `${label} unknown`; let unknownReceipt;
        const lose = async (route) => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 201);
          unknownReceipt = await response.json(); await route.abort("failed"); };
        await page.route("**/api/v1/mcp/servers", lose); await fillRegistration(unknownLabel);
        await registration.getByRole("button", { name: "Register reviewed MCP server", exact: true }).click();
        await registration.getByText(/^MCP registration outcome is unconfirmed/).first().waitFor(); assert.equal(writes.length, 3);
        assertMcpRegistrationAgreement({ request: writes[2].body, receipt: unknownReceipt, owner: await api(`/api/v1/mcp/servers/${unknownReceipt.serverId}`), label: unknownLabel,
          existingIds: [...before.items.map((item) => item.serverId), receipt.serverId] });
        await page.unroute("**/api/v1/mcp/servers", lose);
        await registration.getByRole("button", { name: "Close registration", exact: true }).click(); await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
        await panel.getByRole("button", { name: "Register MCP server", exact: true }).click();
        await registration.getByText(/^MCP registration outcome is unconfirmed/).first().waitFor();
        assert.equal(await registration.getByRole("button", { name: "Review MCP registration", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 3); assert.deepEqual(unexpected, []); await capture("unknown-locked");
        return { status: "passed", metrics: { browserCreations: 2, browserDeletions: 1, cancelledWrites: 0, staleDeletionWrites: 0,
          exactOwnerAgreement: true, cachedInspectionOnly: true, responseLossInjected: true, remountLock: true, blockingAxe: 0,
          limitation: "Disabled disposable stdio records. Saved configuration and cached metadata only; no connections, commands, OAuth or tools executed." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-registration-${variant}-failure.png`);
          await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); } catch { /* Keep original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage, browserWrites: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-registration-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
