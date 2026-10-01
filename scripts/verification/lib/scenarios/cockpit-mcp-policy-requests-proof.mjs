import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export const reviewedMcpFixturePolicy = {
  requireFirstToolApproval: true, redactionMode: "strict", allowedToolPatterns: ["read.*", "inspect"],
  blockedToolPatterns: ["read.private"], allowedEnvKeys: ["LANG", "LC_ALL"], notes: "Reviewed disposable policy",
};
export function assertMcpPolicyAgreement({ before, request, receipt, owner }) {
  assert.deepEqual(request, { expectedRevision: before.revision, label: before.label, command: before.command,
    enabled: false, category: before.category, args: ["--mode", "read only"], policy: reviewedMcpFixturePolicy });
  assert.equal(receipt.serverId, before.serverId);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/); assert.notEqual(receipt.revision, before.revision);
  for (const key of ["label", "command", "enabled", "category", "args", "policy"]) assert.deepEqual(receipt[key], request[key]);
  for (const key of ["transport", "authType", "trustTier", "costTier", "createdAt"]) assert.deepEqual(receipt[key], before[key]);
  assert.equal(receipt.status, "disconnected"); assert.deepEqual(owner, receipt);
}
export function assertMcpResponseAgreement({ before, request, receipt, owner, action, content }) {
  assert.deepEqual(request, { action, ...(content === undefined ? {} : { content }), owner: before.owner });
  for (const key of ["elicitationId", "method", "prompt", "requestedSchema", "protocol", "owner", "source", "policy", "createdAt"])
    assert.deepEqual(receipt[key], before[key]);
  const status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
  assert.equal(receipt.status, status); assert.equal(receipt.response.action, action);
  assert.deepEqual(receipt.response.owner, before.owner);
  assert.deepEqual(receipt.response.content?.value, content);
  assert.equal(receipt.response.content?.truncated ?? false, false);
  assert.equal(receipt.response.content?.redactedSecretCount ?? 0, 0);
  assert.equal(receipt.response.evidence.status, status); assert.equal(receipt.response.evidence.previousStatus, "pending");
  assert.ok(receipt.response.evidence.auditEventId); assert.ok(Number.isFinite(Date.parse(receipt.response.respondedAt)));
  assert.deepEqual(receipt, owner);
}

/** Disposable fixture setup through the ordinary reviewed settings/approval owner. */
export async function enableMcpDiagnosticsFixture(api, delay) {
  const settings = await api("/api/v1/settings");
  if (settings.features?.connectorDiagnosticsV1Enabled === true) return;
  assert.ok(Number.isSafeInteger(settings.revision) && settings.revision > 0);
  const request = { kind: "runtime_configuration", change: { operation: "feature_flag", flag: "connectorDiagnosticsV1Enabled", enabled: true } };
  const submitted = await api("/api/v1/settings", { method: "PATCH", body: { expectedRevision: settings.revision, features: { connectorDiagnosticsV1Enabled: true } } });
  if (submitted.features?.connectorDiagnosticsV1Enabled !== true) {
    const receipt = submitted.changePlanReceipt;
    assert.ok(receipt?.planId); assert.equal(receipt.status, "awaiting_approval");
    const route = `/api/v1/change-plans/${encodeURIComponent(receipt.planId)}`;
    const reviewed = await api(`${route}?workspaceId=default`);
    assert.equal(reviewed.planId, receipt.planId); assert.equal(reviewed.origin?.workspaceId, "default");
    assert.deepEqual(reviewed.request, request); assert.equal(reviewed.status, "awaiting_approval");
    const action = reviewed.requiredAction;
    assert.equal(action?.kind, "approval"); assert.ok(action.approvalId && action.actionId && action.actionNonce);
    await api(`/api/v1/approvals/${encodeURIComponent(action.approvalId)}/resolve`, { method: "POST", body: { decision: "approve", resolutionNote: "Enable metadata-only diagnostics in this disposable verification runtime." } });
    const fresh = await api(`${route}?workspaceId=default`);
    assert.deepEqual(fresh.request, request); assert.equal(fresh.revision, reviewed.revision); assert.deepEqual(fresh.requiredAction, action);
    await api(`${route}/responses`, { method: "POST", body: { workspaceId: "default", expectedRevision: fresh.revision, actionId: action.actionId, actionNonce: action.actionNonce, values: {} } });
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const saved = await api("/api/v1/settings");
    if (saved.features?.connectorDiagnosticsV1Enabled === true) { assert.ok(saved.revision > settings.revision); return; }
    await delay(200);
  }
  throw new Error("The fixture diagnostics feature did not settle in its canonical settings owner.");
}

/** Seeded elicitation records and disabled configuration only. No remote request producer or MCP execution is claimed. */
export async function runCockpitMcpPolicyRequestsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "MCP policy proof requires an isolated runtime");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-policy-requests.${variant}`, lane: "ux-budgets",
      title: `Native MCP policy and seeded operator responses ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "seed disposable owner records", browserContext, page;
      const screenshots = [], writes = [], unexpected = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        stage = "enable isolated metadata diagnostics through its governed owner";
        await enableMcpDiagnosticsFixture(api, ms => new Promise(resolve => setTimeout(resolve, ms)));
        const label = `UX MCP policy ${variant} ${Date.now()}`;
        const original = await api("/api/v1/mcp/servers", { method: "POST", body: {
          label, transport: "stdio", command: "node", args: ["--version"], authType: "none", enabled: false,
          category: "development", trustTier: "restricted", costTier: "unknown",
          policy: { requireFirstToolApproval: false, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [] },
        } });
        const serverRoute = `/api/v1/mcp/servers/${encodeURIComponent(original.serverId)}`;
        const schema = { type: "object", properties: { name: { type: "string", title: "Display name", minLength: 2, maxLength: 30 },
          count: { type: "integer", title: "Copies", minimum: 1, maximum: 5 }, enabled: { type: "boolean", title: "Include heading" } }, required: ["name"], additionalProperties: false };
        const seed = (suffix, requestedSchema = schema, workspaceId = "default") => api("/api/v1/mcp/elicitations", { method: "POST", body: {
          prompt: `Seeded review fixture ${suffix} ${label}`, requestedSchema, owner: { workspaceId, surface: "mcp" },
          source: { sourceType: "ui", serverId: original.serverId, sourceRef: "disposable-browser-proof" },
        } });
        const accepted = await seed("accept"), declined = await seed("unsupported", { type: "array", items: { type: "string" } }),
          unknown = await seed("unknown"), foreign = await seed("foreign", schema, `foreign-${variant}`);
        const responseRoute = request => `/api/v1/mcp/elicitations/${encodeURIComponent(request.elicitationId)}/respond`;
        const readRequest = async request => { const list = await api(`/api/v1/mcp/elicitations?serverId=${encodeURIComponent(original.serverId)}`);
          const matches = list.items.filter(item => item.elicitationId === request.elicitationId); assert.equal(matches.length, 1); return matches[0]; };
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const route = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !route.startsWith("/api/v1/")) return;
          if ((route === serverRoute && request.method() === "PATCH") || (route === `${serverRoute}/health-check` && request.method() === "POST")
            || [accepted, declined, unknown].some(item => route === responseRoute(item) && request.method() === "POST"))
            writes.push({ method: request.method(), route, body: request.postDataJSON() });
          else unexpected.push(`${request.method()} ${route}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "MCP server configuration", exact: true });
        await panel.getByRole("searchbox", { name: "Search MCP servers", exact: true }).fill(label);
        stage = "review and cancel exact args and policy";
        await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Edit saved MCP server", exact: true });
        await editor.getByText("Arguments and tool policy", { exact: true }).click();
        await editor.getByLabel("Process arguments — one per line", { exact: true }).fill("--mode\nread only");
        await editor.getByRole("checkbox", { name: "Require approval for each tool's first use", exact: true }).check();
        await editor.getByLabel("Tool output redaction", { exact: true }).selectOption("strict");
        await editor.getByLabel("Allowed tool patterns — one per line", { exact: true }).fill("read.*\ninspect");
        await editor.getByLabel("Blocked tool patterns — one per line", { exact: true }).fill("read.private");
        await editor.getByLabel("Allowed environment keys — one per line", { exact: true }).fill("LANG\nLC_ALL");
        await editor.getByLabel("Policy notes", { exact: true }).fill(reviewedMcpFixturePolicy.notes);
        await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
        await capture("policy-review");
        await editor.getByRole("button", { name: "Cancel review", exact: true }).click(); assert.deepEqual(writes, []);
        stage = "save policy with exact current revision and receipt";
        await editor.getByRole("button", { name: "Review MCP changes", exact: true }).click();
        const savePromise = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === serverRoute);
        await editor.getByRole("button", { name: "Save reviewed MCP configuration", exact: true }).click();
        const savedResponse = await savePromise; assert.equal(savedResponse.status(), 200); const saved = await savedResponse.json();
        await editor.getByText("MCP server updated.", { exact: true }).waitFor();
        assertMcpPolicyAgreement({ before: original, request: writes[0].body, receipt: saved, owner: await api(serverRoute) });
        await editor.getByRole("button", { name: "Close editor", exact: true }).click();
        stage = "record saved configuration diagnostics without execution";
        await panel.getByRole("button", { name: `Inspect ${label}`, exact: true }).click();
        const inspection = page.getByRole("dialog", { name: "MCP server inspection", exact: true });
        const reportPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${serverRoute}/health-check`);
        await inspection.getByRole("button", { name: "Record configuration check", exact: true }).click();
        const reportResponse = await reportPromise; const report = await reportResponse.json();
        assert.equal(reportResponse.status(), 200, `Configuration report returned ${reportResponse.status()}: ${JSON.stringify(report)}`);
        assert.equal(report.connectorType, "mcp_server"); assert.equal(report.connectorId, original.serverId); assert.equal(report.status, "error");
        assert.deepEqual(report.checks.map(check => [check.key, check.status]), [["enabled", "warn"], ["status", "fail"], ["command", "pass"], ["policy", "pass"]]);
        await inspection.getByText(/Gateway returned the recorded configuration report/).waitFor();
        assert.ok((await inspection.innerText()).includes("does not start a process")); assert.deepEqual(await api(serverRoute), saved);
        await capture("configuration-report"); await inspection.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "inspect seeded operator requests with exact scope";
        const requests = page.getByRole("region", { name: "MCP operator requests", exact: true });
        await requests.getByRole("button", { name: "Inspect MCP requests", exact: true }).click();
        await requests.getByRole("button", { name: `Inspect MCP request ${accepted.elicitationId}`, exact: true }).waitFor();
        assert.equal(await requests.getByRole("button", { name: `Inspect MCP request ${foreign.elicitationId}`, exact: true }).count(), 0);
        await requests.getByRole("button", { name: `Inspect MCP request ${accepted.elicitationId}`, exact: true }).click();
        const form = page.getByRole("region", { name: "MCP response form", exact: true });
        await form.getByLabel("Display name (required)", { exact: true }).fill("Reviewed display");
        await form.getByLabel("Copies", { exact: true }).fill("2"); await form.getByLabel("Include heading", { exact: true }).selectOption("false");
        await form.getByRole("button", { name: "Review accept response", exact: true }).click(); await capture("response-review");
        await form.getByRole("button", { name: "Cancel response review", exact: true }).click(); assert.equal(writes.length, 2);
        stage = "record reviewed acceptance and confirm exact terminal owner";
        await form.getByRole("button", { name: "Review accept response", exact: true }).click();
        const acceptPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === responseRoute(accepted));
        await form.getByRole("button", { name: "Confirm response", exact: true }).click();
        const acceptResponse = await acceptPromise; assert.equal(acceptResponse.status(), 200); const acceptedReceipt = await acceptResponse.json();
        await form.getByText(/Response accepted and confirmed/).waitFor();
        assertMcpResponseAgreement({ before: accepted, request: writes[2].body, receipt: acceptedReceipt, owner: await readRequest(accepted), action: "accept", content: { name: "Reviewed display", count: 2, enabled: false } });
        assert.ok((await form.innerText()).includes("does not confirm remote delivery or durable execution")); await capture("accepted");
        stage = "withhold unsupported acceptance and explicitly decline";
        await requests.getByRole("button", { name: `Inspect MCP request ${declined.elicitationId}`, exact: true }).click();
        assert.equal(await form.getByRole("button", { name: "Review accept response", exact: true }).isDisabled(), true);
        await form.getByRole("button", { name: "Review decline response", exact: true }).click();
        const declinePromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === responseRoute(declined));
        await form.getByRole("button", { name: "Confirm response", exact: true }).click();
        const declineResponse = await declinePromise; assert.equal(declineResponse.status(), 200); const declinedReceipt = await declineResponse.json();
        await form.getByText(/Response declined and confirmed/).waitFor();
        assertMcpResponseAgreement({ before: declined, request: writes[3].body, receipt: declinedReceipt, owner: await readRequest(declined), action: "decline" });
        stage = "retain actual committed-response loss across remount";
        await requests.getByRole("button", { name: `Inspect MCP request ${unknown.elicitationId}`, exact: true }).click();
        let lostReceipt;
        const lose = async route => { const response = await route.fetch(); assert.equal(response.status(), 200); lostReceipt = await response.json(); await route.abort("failed"); };
        await page.route(`**${responseRoute(unknown)}`, lose);
        await form.getByRole("button", { name: "Review cancel response", exact: true }).click();
        await form.getByRole("button", { name: "Confirm response", exact: true }).click();
        await form.getByText(/^MCP response outcome is unconfirmed/).waitFor();
        assertMcpResponseAgreement({ before: unknown, request: writes[4].body, receipt: lostReceipt, owner: await readRequest(unknown), action: "cancel" });
        await page.unroute(`**${responseRoute(unknown)}`, lose);
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "MCP servers", exact: true }).click();
        await requests.getByRole("button", { name: "Inspect MCP requests", exact: true }).click();
        await requests.getByRole("button", { name: `Inspect MCP request ${unknown.elicitationId}`, exact: true }).click();
        await form.getByText(/^MCP response outcome is unconfirmed/).waitFor();
        assert.equal(await form.getByRole("button", { name: "Review cancel response", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 5); assert.deepEqual(unexpected, []); assert.deepEqual(await readRequest(foreign), foreign);
        await capture("unknown-locked");
        return { status: "passed", metrics: { policyWrites: 1, configurationReports: 1, seededResponseWrites: 3, cancelledWrites: 0,
          exactOwnerAgreement: true, foreignScopeWithheld: true, unsupportedAcceptanceWithheld: true, responseLossInjected: true, remountLock: true, blockingAxe: 0,
          limitation: "Disabled disposable MCP record and API-seeded elicitation records. No process, connection, tool invocation, remote request delivery or durable continuation proved." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-policy-requests-${variant}-failure.png`);
          await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage, browserWrites: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const file = path.join(screenshotDir, `ux-budgets-cockpit-mcp-policy-requests-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
