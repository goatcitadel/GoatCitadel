import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertMcpHttpDiscoveryEvents, createMcpHttpFixture } from "./cockpit-mcp-http-fixture.mjs";

function configuration(server) {
  const value = { ...server };
  for (const key of ["revision", "connectionRevision", "configurationBindingId", "authState", "status", "lastConnectedAt", "lastError", "updatedAt"]) delete value[key];
  return value;
}
export function assertMcpConnectionAgreement({ before, action, request, receipt, owner }) {
  assert.deepEqual(request, { expectedRevision: before.revision, expectedConnectionRevision: before.connectionRevision ?? null });
  assert.equal(receipt.version, 1); assert.equal(receipt.action, action); assert.deepEqual(receipt.reviewed, request);
  assert.equal(owner.serverId, before.serverId); assert.match(owner.revision, /^[a-f0-9]{64}$/u);
  assert.match(owner.connectionRevision, /^[a-f0-9]{64}$/u); assert.notEqual(owner.connectionRevision, before.connectionRevision);
  assert.deepEqual(configuration(owner), configuration(before));
  assert.equal(owner.status, action === "connect" ? "connected" : "disconnected");
  assert.deepEqual(JSON.parse(JSON.stringify({ ...receipt.server, authState: owner.authState })), owner);
  if (action === "disconnect") { assert.equal(owner.revision, before.revision); assert.equal(owner.configurationBindingId, before.configurationBindingId); }
}

/** Actual task-owned loopback HTTP initialization/discovery only. Never invokes tools or external services. */
export async function runCockpitMcpConnectionProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-connection.${variant}`, lane: "ux-budgets",
      title: `Reviewed MCP local discovery and connection generation ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "register enabled task-owned discovery fixture", browserContext, page, fixture;
      const writes = [], unexpected = [], screenshots = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        fixture = await createMcpHttpFixture(stack, path);
        const label = `UX MCP connection ${variant} ${Date.now()}`;
        let owner = await api("/api/v1/mcp/servers", { method: "POST", body: { label, transport: "http", url: fixture.url,
          enabled: true, authType: "none", category: "development", trustTier: "restricted", costTier: "free",
          policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] } } });
        const serverRoute = `/api/v1/mcp/servers/${encodeURIComponent(owner.serverId)}`;
        assert.equal(owner.enabled, true); assert.deepEqual(await fixture.events(), []);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const route = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !route.startsWith("/api/v1/")) return;
          if (request.method() === "POST" && [serverRoute + "/connect-reviewed", serverRoute + "/disconnect-reviewed"].includes(route)) writes.push({ route, body: request.postDataJSON() });
          else unexpected.push(`${request.method()} ${route}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        const inspection = page.getByRole("dialog", { name: "MCP server inspection", exact: true });
        const controls = inspection.getByRole("region", { name: "Reviewed MCP connection controls", exact: true });
        const review = controls.getByRole("region", { name: "MCP connection action review", exact: true });
        stage = "cancel reviewed connection without contacting the fixture";
        await controls.getByRole("button", { name: "Review connection", exact: true }).click(); await review.waitFor();
        assert.ok((await review.innerText()).includes(fixture.url));
        await capture("connect-review");
        await review.getByRole("button", { name: "Cancel connection review", exact: true }).click();
        assert.deepEqual(writes, []); assertMcpHttpDiscoveryEvents(await fixture.events(), 0);
        stage = "withhold stale configuration before connection admission";
        await controls.getByRole("button", { name: "Review connection", exact: true }).click(); await review.waitFor();
        owner = await api(serverRoute, { method: "PATCH", body: { expectedRevision: owner.revision, category: "research" } });
        await review.getByRole("button", { name: "Connect reviewed server", exact: true }).click();
        await controls.getByText("The server configuration or connection changed. Refresh and review it again.", { exact: true }).waitFor();
        assert.deepEqual(writes, []); assertMcpHttpDiscoveryEvents(await fixture.events(), 0);
        await inspection.getByRole("button", { name: "Refresh MCP inspection", exact: true }).click();
        await controls.getByRole("button", { name: "Review connection", exact: true }).click(); await review.waitFor();
        stage = "withhold stale connection generation without contacting the fixture";
        const previous = owner, peerRequest = { expectedRevision: owner.revision, expectedConnectionRevision: owner.connectionRevision ?? null };
        const peerReceipt = await api(serverRoute + "/disconnect-reviewed", { method: "POST", body: peerRequest });
        owner = await api(serverRoute); assertMcpConnectionAgreement({ before: previous, action: "disconnect", request: peerRequest, receipt: peerReceipt, owner });
        await review.getByRole("button", { name: "Connect reviewed server", exact: true }).click();
        await controls.getByText("The server configuration or connection changed. Refresh and review it again.", { exact: true }).waitFor();
        assert.deepEqual(writes, []); assertMcpHttpDiscoveryEvents(await fixture.events(), 0); await capture("stale-generation");
        await inspection.getByRole("button", { name: "Refresh MCP inspection", exact: true }).click();
        stage = "connect exact owner and discover an empty tool catalog";
        await apply("connect"); assertMcpHttpDiscoveryEvents(await fixture.events(), 1);
        assert.deepEqual((await api(serverRoute + "/tools")).items, []); await capture("connected");
        stage = "cancel disconnect then confirm a fresh exact generation";
        await controls.getByRole("button", { name: "Review disconnect", exact: true }).click(); await review.waitFor();
        await review.getByRole("button", { name: "Cancel connection review", exact: true }).click(); assert.equal(writes.length, 1);
        await apply("disconnect"); assertMcpHttpDiscoveryEvents(await fixture.events(), 1); await capture("disconnected");
        stage = "reconnect fixture and retain an unknown disconnect across remount";
        await apply("connect"); assertMcpHttpDiscoveryEvents(await fixture.events(), 2);
        const beforeLost = owner; let lostReceipt;
        const lose = async (route) => { const response = await route.fetch(); assert.equal(response.status(), 200); lostReceipt = await response.json(); await route.abort("failed"); };
        await page.route(`**${serverRoute}/disconnect-reviewed`, lose);
        await controls.getByRole("button", { name: "Review disconnect", exact: true }).click(); await review.waitFor();
        await review.getByRole("button", { name: "Disconnect reviewed server", exact: true }).click();
        await controls.getByText(/^MCP connection outcome is unconfirmed/).waitFor();
        owner = await api(serverRoute); assert.equal(writes.length, 4);
        assertMcpConnectionAgreement({ before: beforeLost, action: "disconnect", request: writes[3].body, receipt: lostReceipt, owner });
        await page.unroute(`**${serverRoute}/disconnect-reviewed`, lose);
        await inspection.getByRole("button", { name: "Close sheet", exact: true }).click();
        const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
        await nav.getByRole("link", { name: "General", exact: true }).click();
        await nav.getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        assert.equal(await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).isDisabled(), true);
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        await controls.getByText(/^MCP connection outcome is unconfirmed/).waitFor();
        assert.equal(await controls.getByRole("button", { name: "Review connection", exact: true }).isDisabled(), true);
        assert.equal(await controls.getByRole("button", { name: "Review disconnect", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 4); assert.deepEqual(unexpected, []); assertMcpHttpDiscoveryEvents(await fixture.events(), 2);
         await capture("unknown-remount");
        return { status: "passed", metrics: { exactOwnerAgreement: true, browserWrites: 4, fixtureSetupWrites: 3, cancelledWrites: 0,
          staleWrites: 0, fixtureDiscoveries: 2, transport: "task-owned-loopback-http", environmentCredentialWrites: 0, toolInvocations: 0, responseLossInjected: true, remountLock: true, blockingAxe: 0,
          limitation: "Task-owned loopback HTTP handshake and empty tools/list only; no remote service, credentials or tool invocation. This stateless fixture does not prove closing a live retained session. Captured-session isolation and stdio discovery are covered separately by owner/source harness tests." }, artifacts: emptyArtifacts({ screenshots }) };

        async function apply(action) {
          const before = owner;
          await controls.getByRole("button", { name: action === "connect" ? "Review connection" : "Review disconnect", exact: true }).click(); await review.waitFor();
          const pending = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${serverRoute}/${action}-reviewed`);
          await review.getByRole("button", { name: action === "connect" ? "Connect reviewed server" : "Disconnect reviewed server", exact: true }).click();
          const response = await pending; assert.equal(response.status(), 200, JSON.stringify(await response.json()));
          const receipt = await response.json(); owner = await api(serverRoute);
          assertMcpConnectionAgreement({ before, action, request: writes.at(-1).body, receipt, owner });
          await controls.getByText(action === "connect" ? /^Gateway connection discovery completed/ : /^Gateway disconnect state confirmed/).waitFor();
        }
      } catch (error) {
        if (page && !page.isClosed()) { try { await capture("failure", false); } catch { /* Preserve the original failure. */ } }
        let cleanupError = "";
        try { await fixture?.stop(); } catch (cleanup) { cleanupError = `; fixture cleanup: ${String(cleanup)}`; }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}${cleanupError}`,
          metrics: { failedStage: stage, browserWrites: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally {
        await fixture?.stop();
        await browserContext?.close();
      }
      async function capture(name, audit = true) {
        await mkdir(screenshotDir, { recursive: true });
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page);
          assert.deepEqual(result.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-connection-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
