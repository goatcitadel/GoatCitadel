import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const MANIFEST = "/api/v1/mcp/server-mode/manifest";
const REMOTE = "/api/v1/mcp/remote-preview";
const LIMIT = 20;

export function assertMcpModePreviewOwnerAgreement(manifest, remote, rendered) {
  for (const [label, value] of [["manifest", manifest], ["remote", remote]]) {
    assert.equal(value?.readOnly, true, `${label} must be read-only`);
    assert.equal(value.mutationSemantics, "none", `${label} must not invoke or mutate`);
    assert.ok(Number.isFinite(Date.parse(value.generatedAt)), `${label} generated timestamp missing`);
  }
  assert.equal(manifest.protocol, "mcp");
  assert.equal(manifest.evidence?.catalogScope, "callable");
  assert.ok(Array.isArray(manifest.tools));
  assert.equal(manifest.summary?.exportedToolDescriptors, manifest.tools.length);
  assert.equal(new Set(manifest.tools.map((item) => item.name)).size, manifest.tools.length);
  assert.ok(Array.isArray(remote.items));
  assert.equal(remote.summary?.remoteServers, remote.items.filter((item) => item.source === "server").length);
  assert.equal(remote.summary?.remoteTemplates, remote.items.filter((item) => item.source === "template").length);
  assert.ok(remote.items.every((item) => ["server", "template"].includes(item.source)));
  assert.equal(new Set(remote.items.map((item) => `${item.source}:${item.id}`)).size, remote.items.length);
  assert.deepEqual(rendered.descriptors, manifest.tools.slice(0, LIMIT).map((item) => item.name));
  assert.deepEqual(rendered.records, remote.items.slice(0, LIMIT).map((item) => item.id));
}
function comparable(snapshot) {
  const { generatedAt: _generatedAt, ...fields } = snapshot;
  return fields;
}

export async function runCockpitMcpModePreviewsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-mcp-mode-previews.${variant}`, lane: "ux-budgets",
      title: `MCP installation read-only previews ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      let stage = "open installation settings";
      const screenshots = [], mutations = [], reads = [];
      let releaseRead;
      const capture = async (suffix) => {
        const screenshot = path.join(context.artifactRoot, "screenshots", `ux-budgets-cockpit-mcp-mode-previews-${variant}-${suffix}.png`);
        await mkdir(path.dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: false });
        screenshots.push(relativeToRun(context, screenshot));
      };
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if ([MANIFEST, REMOTE].includes(pathname)) reads.push({ pathname, method: request.method() });
          if (pathname.startsWith("/api/v1/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
            mutations.push({ pathname, method: request.method() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#mcp-servers"), { waitUntil: "domcontentloaded" });
        const inspect = page.getByRole("button", { name: "Inspect MCP installation previews", exact: true });
        await inspect.waitFor({ timeout: 30_000 });
        assert.deepEqual(reads, [], "Mode projections must wait for explicit inspection");
        const waitOwner = (pathname) => page.waitForResponse((response) =>
          new URL(response.url()).pathname === pathname && response.request().method() === "GET");
        const open = async (action) => {
          const [manifestResponse, remoteResponse] = await Promise.all([waitOwner(MANIFEST), waitOwner(REMOTE), action()]);
          assert.equal(manifestResponse.status(), 200);
          assert.equal(remoteResponse.status(), 200);
          const values = await Promise.all([manifestResponse.json(), remoteResponse.json()]);
          await page.getByRole("dialog", { name: "MCP installation previews", exact: true })
            .getByText("Reading MCP installation previews…", { exact: true }).waitFor({ state: "hidden" });
          return values;
        };
        stage = "compare independent actual owner snapshots";
        const [manifest, remote] = await open(() => inspect.click());
        const dialog = page.getByRole("dialog", { name: "MCP installation previews", exact: true });
        await dialog.getByText("Installation-wide Gateway projections, not filtered to the selected workspace.", { exact: false }).waitFor();
        const descriptorList = dialog.getByRole("list", { name: "MCP server-mode descriptors", exact: true });
        const remoteList = dialog.getByRole("list", { name: "Remote MCP preview records", exact: true });
        assertMcpModePreviewOwnerAgreement(manifest, remote, {
          descriptors: await descriptorList.locator(":scope > li > code").allTextContents(),
          records: await remoteList.locator(":scope > li > code").allTextContents(),
        });
        for (const [ownerPath, snapshot] of [[MANIFEST, manifest], [REMOTE, remote]]) {
          const owner = await requestJson(stack.gatewayUrl, ownerPath);
          assertOk(owner, "independently reread installation preview owner");
          assert.deepEqual(comparable(snapshot), comparable(owner.body));
        }
        await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page);
        const blocking = audit.violations.filter((item) => ["critical", "serious"].includes(item.impact));
        assert.equal(blocking.length, 0, `Blocking accessibility: ${blocking.map((item) => item.id).join(", ")}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `Horizontal overflow: ${overflow}px`);
        await capture("manifest");
        stage = "filter remote templates without another owner call";
        const readCount = reads.length;
        await dialog.getByLabel("Preview records", { exact: true }).selectOption("template");
        assert.deepEqual(await remoteList.locator(":scope > li > code").allTextContents(),
          remote.items.filter((item) => item.source === "template").slice(0, LIMIT).map((item) => item.id));
        assert.equal(reads.length, readCount);
        await dialog.getByRole("heading", { name: "Remote MCP preview", exact: true }).scrollIntoViewIfNeeded();
        await capture("remote");
        stage = "withhold stale snapshots during held refresh and discard late closed view";
        let finishHeld;
        const heldFinished = new Promise((resolve) => { finishHeld = resolve; });
        const held = new Promise((resolve) => { releaseRead = resolve; });
        await page.route(`**${MANIFEST}`, async (route) => {
          try { await held; await route.continue().catch(() => {}); } finally { finishHeld(); }
        });
        await Promise.all([
          page.waitForRequest((request) => new URL(request.url()).pathname === MANIFEST && request.method() === "GET"),
          dialog.getByRole("button", { name: "Refresh MCP previews", exact: true }).click(),
        ]);
        await dialog.getByText("Reading MCP installation previews…", { exact: true }).waitFor();
        assert.equal(await descriptorList.count(), 0);
        assert.equal(await remoteList.count(), 0);
        await dialog.getByRole("button", { name: "Close sheet", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        releaseRead(); releaseRead = undefined;
        await heldFinished;
        await page.unroute(`**${MANIFEST}`);
        await open(() => inspect.click());
        await dialog.getByRole("list", { name: "MCP server-mode descriptors", exact: true }).waitFor();
        stage = "explicit partial transport failure preserves only current available owner";
        await page.route(`**${REMOTE}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Verification projection unavailable" }) }));
        await Promise.all([waitOwner(MANIFEST), waitOwner(REMOTE), dialog.getByRole("button", { name: "Refresh MCP previews", exact: true }).click()]);
        await dialog.getByText("Remote MCP evidence is unavailable.", { exact: true }).waitFor();
        assert.equal(await remoteList.count(), 0);
        assert.equal(await descriptorList.count(), 1);
        await capture("partial");
        await page.unroute(`**${REMOTE}`);
        await open(() => dialog.getByRole("button", { name: "Refresh MCP previews", exact: true }).click());
        assert.deepEqual(mutations, [], "Installation preview must not mutate, connect, discover or invoke");
        assert.ok(reads.every((read) => read.method === "GET"));
        return { status: "passed", metrics: { scope: "installation", independentSnapshots: true, descriptors: manifest.tools.length,
          remoteRecords: remote.items.length, displayLimit: LIMIT, explicitInspection: true, mutations: 0,
          transportStarted: false, toolInvocations: 0, heldRefreshAndClosedView: true,
          partialFailure: "injected_GET_503", blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await capture("failure"); } catch { /* Keep original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, mutations, ownerReads: reads.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { releaseRead?.(); await browserContext.close(); }
    });
  }
}
