import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertProviderCatalogProof({ before, after, providerId, modelCatalog, rendered, mutations }) {
  assert.ok(Array.isArray(before?.providers), "Provider proof requires the Gateway provider list.");
  const provider = before.providers.find((item) => item.providerId === providerId);
  assert.ok(provider, "Verification provider is absent from the Gateway configuration.");
  assert.deepEqual([...rendered.providerIds].sort(), before.providers.map((item) => item.providerId).sort(),
    "Provider choices differ from the Gateway owner.");
  assert.equal(rendered.selectedProviderId, providerId, "The requested provider was not selected.");
  const activeProvider = before.providers.find((item) => item.providerId === before.activeProviderId);
  assert.equal(rendered.savedDefault, `Saved Chat default: ${activeProvider?.label ?? before.activeProviderId} / ${before.activeModel}`,
    "The displayed saved route differs from the Gateway owner.");
  assert.equal(modelCatalog?.source, "live", "Provider refresh returned fallback evidence.");
  assert.notEqual(modelCatalog?.catalogStatus, "stale", "Provider refresh returned stale evidence.");
  assert.ok(Array.isArray(modelCatalog?.items) && modelCatalog.items.length > 0, "The loopback fixture returned no model records.");
  const ownerModels = [...new Set(modelCatalog.items.map((item) => item.id))];
  assert.deepEqual(rendered.models, ownerModels, "Displayed model names differ from the live Gateway response.");
  assert.equal(after?.activeProviderId, before.activeProviderId, "Provider inspection changed the saved provider.");
  assert.equal(after?.activeModel, before.activeModel, "Provider inspection changed the saved model.");
  assert.equal(after?.revision, before.revision, "Provider inspection changed the settings revision.");
  assert.deepEqual(mutations, [], "Provider inspection sent a settings mutation.");
}

/** Require a ready loopback fixture before measuring the browser action.
 * Stale-while-revalidate responses remain stale evidence, never a pass. */
export async function requireFreshProviderCatalog(readOwner, pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const catalog = await readOwner();
    if (catalog?.source === "live" && catalog.catalogStatus !== "stale"
      && Array.isArray(catalog.items) && catalog.items.length > 0) return catalog;
    if (attempt < 29) await pause(250);
  }
  throw new Error("Provider fixture did not reach a fresh, nonempty live owner catalog.");
}

/** Refresh may join an owner read still in flight. Settled earlier reads do not qualify. */
export function selectProviderCatalogRead(pendingAtClick, startedDuringAction) {
  const request = startedDuringAction.at(-1) ?? pendingAtClick.at(-1);
  assert.ok(request, "Model refresh has no new or in-flight owner request.");
  return request;
}

/** Reads only the isolated lane's provider configuration and synthetic model endpoint. */
export async function runCockpitProviderCatalogProof({ context, browser, stack, fixture, providerId, viewports, deps }) {
  const {
    assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl,
    emptyArtifacts, installMissionControlNextBrowserState, path, relativeToRun,
    requestJson, runScenario,
  } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context,
      { id: `ux-budgets.cockpit-provider-catalog.${variant}`, lane: "ux-budgets",
        title: `Cockpit provider catalog ${variant}`, subsystem: "mission-control-ux" },
      async () => {
        await requireFreshProviderCatalog(async () => {
          const response = await requestJson(stack.gatewayUrl, `/api/v1/llm/models?providerId=${encodeURIComponent(providerId)}`);
          assertOk(response, `read ${variant} live catalog fixture`);
          return response.body;
        });
        const before = await requestJson(stack.gatewayUrl, "/api/v1/llm/config");
        assertOk(before, `read ${variant} provider owner`);
        const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await browserContext.addInitScript((theme) => window.localStorage.setItem("goatcitadel.ui.theme.v1", theme), variant === "mobile" ? "light" : "dark");
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          const mutations = [];
          const catalogReads = [];
          const pendingCatalogReads = new Set();
          page.on("request", (request) => {
            const url = new URL(request.url());
            const pathname = url.pathname;
            if (request.method() === "GET" && pathname === "/api/v1/llm/models"
              && url.searchParams.get("providerId") === providerId) {
              catalogReads.push(request);
              pendingCatalogReads.add(request);
            }
            if (!["GET", "HEAD", "OPTIONS"].includes(request.method())
              && /^\/api\/v1\/(settings|llm\/config|change-plans)(\/|$)/.test(pathname)) {
              mutations.push(`${request.method()} ${pathname}`);
            }
          });
          page.on("requestfinished", (request) => pendingCatalogReads.delete(request));
          page.on("requestfailed", (request) => pendingCatalogReads.delete(request));
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/models?shell=cockpit#providers"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, variant === "mobile" ? "light" : "dark");
          const panel = page.getByRole("region", { name: "Providers and model catalogs", exact: true });
          const select = panel.getByRole("combobox", { name: "Inspect provider", exact: true });
          await select.waitFor();
          await select.selectOption(providerId);
          const pendingAtClick = [...pendingCatalogReads];
          const actionStart = catalogReads.length;
          await panel.getByRole("button", { name: "Refresh models", exact: true }).click();
          await panel.getByRole("heading", { name: "Live catalog", exact: true }).waitFor();
          await panel.locator('[aria-busy="false"]').waitFor();
          const modelRequest = selectProviderCatalogRead(pendingAtClick, catalogReads.slice(actionStart));
          const response = await modelRequest.response();
          assert.ok(response, "Model refresh request has no owner response.");
          assert.equal(response.status(), 200, "Model refresh did not receive a successful Gateway response.");
          const modelCatalog = await response.json();
          await panel.getByRole("heading", { name: "Live catalog", exact: true }).waitFor();
          await panel.getByRole("list", { name: "Discovered models" }).waitFor();
          const rendered = {
            providerIds: await select.locator("option").evaluateAll((items) => items.map((item) => item.value)),
            selectedProviderId: await select.inputValue(),
            savedDefault: await panel.getByText(/^Saved Chat default:/).innerText(),
            models: await panel.getByRole("list", { name: "Discovered models" }).locator("li > span:first-child").allTextContents(),
          };
          await panel.getByRole("searchbox", { name: "Filter models", exact: true }).fill("not-a-verification-model");
          await panel.getByText("No models match this filter.", { exact: true }).waitFor();
          await panel.getByRole("searchbox", { name: "Filter models", exact: true }).fill("");
          await panel.getByRole("list", { name: "Discovered models" }).waitFor();
          const configResponse = page.waitForResponse((candidate) => candidate.request().method() === "GET"
            && new URL(candidate.url()).pathname === "/api/v1/llm/config");
          await panel.getByRole("button", { name: "Refresh providers", exact: true }).click();
          assert.equal((await configResponse).status(), 200, "Provider refresh failed.");
          await select.waitFor();
          const after = await requestJson(stack.gatewayUrl, "/api/v1/llm/config");
          assertOk(after, `read ${variant} provider owner after inspection`);
          assertProviderCatalogProof({ before: before.body, after: after.body, providerId, modelCatalog, rendered, mutations });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (blocking.length || overflow > 1) throw new Error(`Provider catalog ${variant}: accessibility ${blocking.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow}px`);
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-provider-catalog-${variant}.png`);
          await panel.scrollIntoViewIfNeeded();
          await page.screenshot({ path: screenshot, fullPage: false });
          return { status: "passed", metrics: { blockingAxe: 0, overflow, providerCount: rendered.providerIds.length,
            modelCount: rendered.models.length, savedRevision: after.body.revision },
          artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
        } finally {
          await browserContext.close();
        }
      });
  }
}
