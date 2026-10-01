import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export function assertIntegrationManagementReceipt({ submitted, receipt, observed, previous }) {
  assert.deepEqual(receipt, observed, "The receipt differs from the exact canonical connection read.");
  assert.ok(receipt.connectionId);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  if (previous) {
    assert.equal(submitted.expectedRevision, previous.revision);
    assert.equal(receipt.connectionId, previous.connectionId);
    assert.equal(receipt.catalogId, previous.catalogId);
    assert.notEqual(receipt.revision, previous.revision);
  } else assert.equal(receipt.catalogId, submitted.catalogId);
  for (const key of ["label", "enabled", "config", "status"])
    if (key in submitted) assert.deepEqual(receipt[key], submitted[key], `Owner did not confirm submitted ${key}.`);
}
function observed(promise) { void promise.catch(() => {}); return promise; }

/** Metadata-only CRUD on unique disabled connections in the disposable verification installation. */
export async function runCockpitIntegrationManagementProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Requires an isolated verification runtime.");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `Integration owner request failed (${response.status}).`); return response.body; };
  const catalog = await api("/api/v1/integrations/catalog");
  const fixture = catalog.items.find(item => item.key === "github" && item.kind === "productivity");
  assert.ok(fixture && !fixture.operatorActions?.length, "Requires the advertised metadata-only GitHub catalog fixture.");
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-integration-management.${variant}`, lane: "ux-budgets",
      title: `Native integration reviewed create/edit/delete ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const screenshots = [], diagnostics = [], writes = [];
      const label = `Managed integration ${variant}-${randomUUID().slice(0, 8)}`;
      let page, browserContext, stage = "open native management";
      try {
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          if (["POST", "PATCH", "DELETE"].includes(request.method()))
            writes.push({ method: request.method(), path: new URL(request.url()).pathname });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#integration-connections"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.getByRole("button", { name: "Add and manage integrations", exact: true }).click();
        const management = page.getByRole("region", { name: "Integration management", exact: true });
        await management.getByRole("button", { name: "Add integration connection", exact: true }).click();
        const editor = management.getByRole("region", { name: "New integration connection", exact: true });
        await editor.getByRole("combobox", { name: "Integration catalog", exact: true }).selectOption(fixture.catalogId);
        await editor.getByLabel("Integration connection label", { exact: true }).fill(label);
        await editor.getByRole("region", { name: `${fixture.formSchema.title} configuration`, exact: true }).waitFor();
        assert.equal(await editor.getByRole("checkbox", { name: "Integration connection enabled", exact: true }).isChecked(), false);
        stage = "cancel creation review without a write";
        await editor.getByRole("button", { name: "Review new connection", exact: true }).click();
        const createReview = page.getByRole("dialog", { name: "Create this integration connection?", exact: true });
        await createReview.waitFor(); await capture("create-review");
        await createReview.getByRole("button", { name: "Keep current connection", exact: true }).click();
        assert.deepEqual(writes, []);
        assert.equal((await api("/api/v1/integrations/connections")).items.some(item => item.label === label), false);
        stage = "create disabled connection and verify canonical readback";
        await editor.getByRole("button", { name: "Review new connection", exact: true }).click();
        const createResponse = responseFor("POST", "/api/v1/integrations/connections");
        await createReview.getByRole("button", { name: "Apply reviewed connection", exact: true }).click();
        const createdResponse = await createResponse; assert.equal(createdResponse.status(), 201);
        const initial = await createdResponse.json(), createInput = createdResponse.request().postDataJSON();
        assert.equal(createInput.label, label); assert.equal(createInput.enabled, false);
        const route = `/api/v1/integrations/connections/${encodeURIComponent(initial.connectionId)}`;
        const read = () => api(route);
        assertIntegrationManagementReceipt({ submitted: createInput, receipt: initial, observed: await read() });
        await management.getByText(`Connection ${label} created.`, { exact: true }).waitFor();
        stage = "edit exact saved revision";
        await management.getByRole("button", { name: "Edit integration connection", exact: true }).click();
        const edit = management.getByRole("region", { name: "Edit integration connection", exact: true });
        const editedLabel = `${label} edited`;
        await edit.getByLabel("Integration connection label", { exact: true }).fill(editedLabel);
        await edit.getByRole("button", { name: "Review connection changes", exact: true }).click();
        const editReview = page.getByRole("dialog", { name: "Apply integration connection changes?", exact: true });
        await editReview.waitFor(); assert.deepEqual(await read(), initial);
        const updateResponse = responseFor("PATCH", route);
        await editReview.getByRole("button", { name: "Apply reviewed connection", exact: true }).click();
        const updatedResponse = await updateResponse; assert.equal(updatedResponse.status(), 200);
        const updated = await updatedResponse.json();
        assertIntegrationManagementReceipt({ previous: initial, submitted: updatedResponse.request().postDataJSON(), receipt: updated, observed: await read() });
        assert.equal(updated.label, editedLabel); assert.equal(updated.enabled, false);
        await management.getByText("Connection updated.", { exact: true }).waitFor();
        await edit.getByRole("button", { name: "Close editor", exact: true }).click();
        await management.getByRole("button", { name: `${editedLabel} · Disabled`, exact: true }).click();
        stage = "cancel deletion then confirm exact revision";
        await management.getByRole("button", { name: "Delete integration connection", exact: true }).click();
        const deletion = page.getByRole("dialog", { name: "Delete integration connection?", exact: true });
        await deletion.waitFor(); await capture("delete-review");
        await deletion.getByRole("button", { name: "Keep integration", exact: true }).click();
        assert.equal(writes.length, 2); assert.deepEqual(await read(), updated);
        await management.getByRole("button", { name: "Delete integration connection", exact: true }).click();
        const deleteResponse = responseFor("DELETE", route);
        await deletion.getByRole("button", { name: "Delete reviewed integration", exact: true }).click();
        const deleted = await deleteResponse; assert.equal(deleted.status(), 200);
        assert.deepEqual(deleted.request().postDataJSON(), { expectedRevision: updated.revision });
        assert.deepEqual(await deleted.json(), { deleted: true });
        const absent = await requestJson(stack.gatewayUrl, route); assert.equal(absent.status, 404);
        await management.getByText("Connection deleted.", { exact: true }).waitFor();
        await management.scrollIntoViewIfNeeded(); await capture("deleted");
        assert.equal(writes.length, 3); assert.equal(writes.some(item => item.path.includes("/actions/")), false);
        return { status: "passed", metrics: { nativeCreateEditDelete: true, exactRevisionReadback: true, cancellationWrites: 0,
          browserMutations: writes.length, externalActions: 0, connectivityTested: false, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
        function responseFor(method, route) { return observed(page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === route)); }
      } catch (error) {
        if (page && !page.isClosed()) { try { await screenshot("failure"); } catch { /* Preserve first failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, writes }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
      async function screenshot(name) { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const file = path.join(directory, `cockpit-integration-management-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, file)); }
      async function capture(name) {
        await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-integration-management-${variant}-${name}-axe.json`); await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        await screenshot(name);
      }
    });
  }
}
