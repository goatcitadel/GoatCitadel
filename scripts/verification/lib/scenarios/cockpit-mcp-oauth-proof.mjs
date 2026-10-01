import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

function configuration(record) {
  const value = { ...record };
  for (const key of ["revision", "connectionRevision", "configurationBindingId", "authState", "status", "lastConnectedAt", "lastError", "updatedAt"]) delete value[key];
  return value;
}
export function assertMcpOAuthStartAgreement({ before, request, receipt, owner }) {
  assert.deepEqual(request, { expectedRevision: before.revision, expectedConnectionRevision: before.connectionRevision ?? null });
  assert.equal(receipt.review.version, 1); assert.deepEqual(receipt.review.reviewed, request);
  assert.deepEqual(receipt.review.server, owner); assert.deepEqual(configuration(owner), configuration(before));
  // Handshake metadata alone preserves the edit revision; the claimed connection nonce must rotate.
  assert.match(owner.revision, /^[a-f0-9]{64}$/u);
  assert.match(owner.connectionRevision, /^[a-f0-9]{64}$/u); assert.notEqual(owner.connectionRevision, before.connectionRevision);
  assert.equal(owner.status, "disconnected"); assert.equal(owner.authState.readiness, "needs_auth");
  assert.match(receipt.state, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
  const expected = new URL(before.oauth.authorizationUrl), actual = new URL(receipt.authorizeUrl);
  expected.searchParams.set("response_type", "code"); expected.searchParams.set("state", receipt.state);
  expected.searchParams.set("redirect_uri", before.oauth.redirectUri);
  expected.searchParams.set("scope", before.oauth.scopes.join(" "));
  expected.searchParams.sort(); actual.searchParams.sort(); assert.equal(actual.toString(), expected.toString());
}

/** Actual canonical handshake only. No authorization page, token exchange, remote transport or tool invocation. */
export async function runCockpitMcpOAuthProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-oauth.${variant}`, lane: "ux-budgets",
      title: `Reviewed MCP authorization handshake ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "register synthetic OAuth metadata", page, browserContext;
      const screenshots = [], writes = [], unexpected = [], external = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const label = `UX MCP OAuth ${variant} ${Date.now()}`;
        let owner = await api("/api/v1/mcp/servers", { method: "POST", body: {
          label, transport: "http", url: "https://example.invalid/mcp", authType: "oauth2", enabled: false,
          oauth: { authorizationUrl: "https://example.invalid/authorize", tokenUrl: "https://example.invalid/token", redirectUri: "http://127.0.0.1/manual-fixture", scopes: ["inspect"] },
          category: "development", trustTier: "restricted", costTier: "free",
          policy: { requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] },
        } });
        const serverRoute = `/api/v1/mcp/servers/${encodeURIComponent(owner.serverId)}`, startRoute = `${serverRoute}/oauth/start-reviewed`;
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        await browserContext.route("https://example.invalid/**", async route => { external.push(route.request().method()); await route.abort("blockedbyclient"); });
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (pathname === startRoute && request.method() === "POST") writes.push(request.postDataJSON());
          else unexpected.push(`${request.method()} ${pathname}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30000 });
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        const inspection = page.getByRole("dialog", { name: "MCP server inspection", exact: true });
        const controls = inspection.getByRole("region", { name: "Reviewed MCP OAuth controls", exact: true });
        const review = controls.getByRole("region", { name: "MCP OAuth action review", exact: true });
        stage = "cancel authorization replacement with zero writes";
        await controls.getByRole("button", { name: "Review OAuth authorization", exact: true }).click(); await review.waitFor();
        assert.ok((await review.innerText()).includes("closing the reviewed connection")); await capture("review");
        await review.getByRole("button", { name: "Cancel OAuth review", exact: true }).click(); assert.deepEqual(writes, []);
        stage = "reject stale saved metadata before admission";
        await controls.getByRole("button", { name: "Review OAuth authorization", exact: true }).click(); await review.waitFor();
        owner = await api(serverRoute, { method: "PATCH", body: { expectedRevision: owner.revision, category: "research" } });
        await review.getByRole("button", { name: "Start reviewed authorization", exact: true }).click();
        await controls.getByText("The server or authorization request changed. Refresh and review it again.", { exact: true }).waitFor();
        assert.deepEqual(writes, []); await inspection.getByRole("button", { name: "Refresh MCP inspection", exact: true }).click();
        stage = "confirm exact canonical handshake without contacting a provider";
        const before = owner;
        await controls.getByRole("button", { name: "Review OAuth authorization", exact: true }).click(); await review.waitFor();
        const pending = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === startRoute);
        await review.getByRole("button", { name: "Start reviewed authorization", exact: true }).click();
        const response = await pending; assert.equal(response.status(), 200, JSON.stringify(await response.json()));
        const receipt = await response.json(); owner = await api(serverRoute);
        assertMcpOAuthStartAgreement({ before, request: writes[0], receipt, owner });
        const link = controls.getByRole("link", { name: "Open authorization page", exact: true }); await link.waitFor();
        assert.equal(await link.getAttribute("href"), receipt.authorizeUrl); assert.equal(browserContext.pages().length, 1);
        stage = "withhold mismatched manually returned state";
        await controls.getByLabel("Authorization code", { exact: true }).fill("synthetic-transient-code");
        await controls.getByLabel("Returned state", { exact: true }).fill("different-state");
        await controls.getByRole("button", { name: "Review authorization completion", exact: true }).click();
        await controls.getByText("Enter the code and the exact returned state for this current authorization request.", { exact: true }).waitFor();
        assert.equal(writes.length, 1); assert.deepEqual(unexpected, []);
        await controls.getByLabel("Authorization code", { exact: true }).fill(""); await controls.getByLabel("Returned state", { exact: true }).fill("");
        await capture("acknowledged-manual-flow");
        stage = "retain unknown start outcome across remount";
        const beforeLost = owner; let lostReceipt;
        const lose = async route => { const reply = await route.fetch(); assert.equal(reply.status(), 200); lostReceipt = await reply.json(); await route.abort("failed"); };
        await page.route(`**${startRoute}`, lose);
        await controls.getByRole("button", { name: "Review OAuth authorization", exact: true }).click(); await review.waitFor();
        await review.getByRole("button", { name: "Start reviewed authorization", exact: true }).click();
        await controls.getByText(/^MCP authorization outcome is unconfirmed/).waitFor();
        owner = await api(serverRoute); assertMcpOAuthStartAgreement({ before: beforeLost, request: writes[1], receipt: lostReceipt, owner });
        await page.unroute(`**${startRoute}`, lose);
        await inspection.getByRole("button", { name: "Close sheet", exact: true }).click();
        const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
        await nav.getByRole("link", { name: "General", exact: true }).click(); await nav.getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        assert.equal(await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).isDisabled(), true);
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        await controls.getByText(/^MCP authorization outcome is unconfirmed/).waitFor();
        assert.equal(await controls.getByRole("button", { name: "Review OAuth authorization", exact: true }).isDisabled(), true);
        assert.equal(await controls.getByLabel("Authorization code", { exact: true }).count(), 0);
        assert.equal(writes.length, 2); assert.deepEqual(unexpected, []); assert.deepEqual(external, []);
        assert.equal(browserContext.pages().length, 1); await capture("unknown-remount");
        return { status: "passed", metrics: { exactHandshakeOwner: true, browserWrites: 2, fixtureWrites: 2, cancelledWrites: 0, staleWrites: 0,
          providerRequests: 0, tokenExchanges: 0, transportConnections: 0, toolInvocations: 0, manualStateMismatchWithheld: true, responseLossInjected: true, remountLock: true, blockingAxe: 0,
          limitation: "Synthetic saved OAuth endpoints; real canonical start only. No remote authorization page/token exchange, callback or credential custody success claimed." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await capture("failure", false); } catch { /* Preserve failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserWrites: writes.length, unexpectedMutations: unexpected }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, audit = true) {
        await mkdir(screenshotDir, { recursive: true });
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page);
          assert.deepEqual(result.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-oauth-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
