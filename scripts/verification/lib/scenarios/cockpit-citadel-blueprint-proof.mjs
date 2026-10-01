import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export function assertBlueprintImportOwner({ before, blueprint, request, receipt, owner }) {
  assert.deepEqual(request, { blueprint, expectedRevision: before.revision });
  assert.equal(receipt.citadelId, before.citadelId); assert.notEqual(receipt.revision, before.revision);
  assert.deepEqual(receipt, owner, "The import receipt disagrees with the canonical structure.");
  assert.deepEqual(receipt.record, before.record, "Blueprint import changed directory metadata.");
  for (const [field, value] of Object.entries(blueprint.charter)) assert.deepEqual(receipt.charter?.[field], value);
  assert.equal(receipt.charter?.defaultChamberId, undefined);
  const prior = new Set(before.chambers.map(item => item.chamberId));
  for (const chamber of before.chambers) assert.deepEqual(receipt.chambers.find(item => item.chamberId === chamber.chamberId), chamber);
  const fields = items => items.map(({ name, sensitivity, sealed }) => ({ name, sensitivity, sealed })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(fields(receipt.chambers.filter(item => !prior.has(item.chamberId))), fields(blueprint.chambers));
}

/** Imports only into new task-owned Citadels in the disposable verification runtime. */
export async function runCockpitCitadelBlueprintProof({ context, browser, stack, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Blueprint proof requires a disposable runtime.");
  const api = async (route, init) => { const reply = await requestJson(stack.gatewayUrl, route, init); assert.ok(reply.ok, `${route} returned ${reply.status}`); return reply.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-citadel-blueprint.${variant}`, lane: "ux-budgets",
      title: `Native reviewed Blueprint import and export ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const screenshots = [], writes = []; let browserContext, page, panel, stage = "prepare an isolated Citadel";
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const suffix = `${variant}-${randomUUID().slice(0, 8)}`, id = `ux-blueprint-${suffix}`;
        const initialRecords = (await api("/api/v1/citadels?view=all&limit=500")).items;
        const record = await api("/api/v1/citadels", { method: "POST", body: { name: `Blueprint ${suffix}`, slug: id, kind: "team", description: "Disposable Blueprint verification." } });
        assert.equal(record.citadelId, id);
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Blueprint workspace ${suffix}`, citadelId: id } });
        const ownerPath = `/api/v1/citadels/${encodeURIComponent(id)}`, read = () => api(`${ownerPath}/structure`);
        const original = await read(); assert.equal(original.citadelId, id);
        const blueprint = { schemaVersion: "goatcitadel.blueprint.v1", metadata: { name: `Reviewed Blueprint ${suffix}` },
          charter: { purpose: `Reviewed purpose ${suffix}`, kind: "team", goals: ["Verify native Blueprint import"], boundaries: ["Disposable fixture only"], successDefinition: ["Exact owner receipt"], riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" },
          chambers: [{ name: `Reviewed Chamber ${suffix}`, sensitivity: "private", sealed: true }], riskNotes: [] };
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, id); page = await browserContext.newPage();
        page.on("request", request => { const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) writes.push({ method: request.method(), pathname, body: request.postDataJSON() }); });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-blueprint"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 }); panel = page.getByRole("region", { name: "Citadel Blueprint", exact: true });
        await panel.getByRole("button", { name: "Import", exact: true }).click();
        const input = panel.getByLabel("Blueprint JSON", { exact: true });
        stage = "load a file without dispatching an import";
        await panel.getByLabel("Choose Blueprint file (up to 1 MiB)", { exact: true }).setInputFiles({ name: "reviewed-blueprint.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(blueprint)) });
        await page.waitForFunction(value => document.querySelector('section[aria-label="Citadel Blueprint"] textarea')?.value === value, JSON.stringify(blueprint));
        assert.equal(writes.length, 0); assert.deepEqual(await read(), original);
        stage = "retain a draft through native close";
        await panel.getByRole("button", { name: "Close import", exact: true }).click();
        await page.getByRole("dialog", { name: "Unsaved Blueprint draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await panel.getByRole("button", { name: "Import · Unsaved", exact: true }).click(); assert.equal(await input.inputValue(), JSON.stringify(blueprint));
        const validate = async () => { const reply = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/blueprints/validate");
          await panel.getByRole("button", { name: "Validate", exact: true }).click(); assert.equal((await reply).status(), 200); await panel.getByText("Blueprint valid — review its changes before importing.", { exact: true }).waitFor(); };
        const review = async () => { await panel.getByRole("button", { name: "Review import", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Apply this Blueprint?", exact: true }); await dialog.waitFor();
          for (const target of [dialog, dialog.getByRole("button", { name: "Apply Blueprint", exact: true })]) { const box = await target.boundingBox(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1); }
          return dialog; };
        stage = "validate then cancel exact import review"; await validate(); const cancelled = await review(); await cancelled.getByText(original.revision, { exact: true }).waitFor(); await capture("review", cancelled);
        assert.equal(writes.filter(write => write.pathname === `${ownerPath}/from-blueprint`).length, 0); assert.deepEqual(await read(), original);
        await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
        stage = "withhold stale revision before dispatch"; const stale = await review();
        const peer = await api(`${ownerPath}/charter`, { method: "PUT", body: { ...blueprint.charter, purpose: `Independent peer ${suffix}`, expectedRevision: original.revision } });
        await stale.getByRole("button", { name: "Apply Blueprint", exact: true }).click(); await stale.waitFor({ state: "hidden" });
        await panel.getByText(/The Citadel changed\. Your Blueprint is preserved/).waitFor(); assert.equal(writes.filter(write => write.pathname === `${ownerPath}/from-blueprint`).length, 0);
        assert.equal(await input.inputValue(), JSON.stringify(blueprint)); assert.deepEqual(await read(), peer);
        stage = "revalidate, confirm and independently read the exact import"; await validate(); const fresh = await review(); await fresh.getByText(peer.revision, { exact: true }).waitFor();
        const imported = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${ownerPath}/from-blueprint`);
        await fresh.getByRole("button", { name: "Apply Blueprint", exact: true }).click(); const reply = await imported; assert.equal(reply.status(), 201); const receipt = await reply.json();
        await panel.getByText("Blueprint imported and confirmed against the saved structure.", { exact: true }).waitFor();
        const importWrite = writes.filter(write => write.pathname === `${ownerPath}/from-blueprint`); assert.equal(importWrite.length, 1);
        assertBlueprintImportOwner({ before: peer, blueprint, request: importWrite[0].body, receipt, owner: await read() }); await capture("imported");
        stage = "download the actual secret-free export artifact";
        await panel.getByRole("button", { name: "Export", exact: true }).click(); await panel.getByRole("button", { name: "Download blueprint", exact: true }).waitFor();
        const exported = await api(`${ownerPath}/blueprint`); assert.deepEqual(exported.charter, blueprint.charter); assert.equal(exported.chambers.length, peer.chambers.length + blueprint.chambers.length);
        const downloadEvent = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download blueprint", exact: true }).click(); const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), `${id}-blueprint.json`); const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), exported); await capture("export");
        stage = "retain an unknown import after its committed response is lost";
        await panel.getByRole("button", { name: "Import", exact: true }).click(); const lostBlueprint = { ...blueprint, charter: { ...blueprint.charter, purpose: `Unknown import ${suffix}` }, chambers: [] };
        if (!await input.isVisible()) await panel.getByText("Paste or inspect Blueprint JSON", { exact: true }).click();
        await input.fill(JSON.stringify(lostBlueprint)); await validate(); const lost = await review(); const beforeLost = await read(); let lostReceipt;
        const lose = async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 201); lostReceipt = await response.json(); await route.abort("failed"); };
        await page.route(`**${ownerPath}/from-blueprint`, lose); await lost.getByRole("button", { name: "Apply Blueprint", exact: true }).click();
        await panel.getByText(/^Citadel structure outcome is unconfirmed/).waitFor(); await page.unroute(`**${ownerPath}/from-blueprint`, lose);
        assertBlueprintImportOwner({ before: beforeLost, blueprint: lostBlueprint, request: writes.filter(write => write.pathname === `${ownerPath}/from-blueprint`).at(-1).body, receipt: lostReceipt, owner: await read() });
        const count = writes.length, retainedWrites = structuredClone(writes), committed = await read();
        const sourceUrl = page.url(), documentOrigin = await page.evaluate(() => performance.timeOrigin);
        const retainedText = JSON.stringify(lostBlueprint), hashText = value => createHash("sha256").update(value).digest("hex");
        const retainedHash = hashText(retainedText);
        assert.equal(await input.inputValue(), retainedText); assert.equal(committed.citadelId, id);
        assert.deepEqual(committed, lostReceipt);
        const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        const reviewLeave = async decision => {
          await nav.getByRole("link", { name: "General", exact: true }).click();
          await leave.waitFor(); await leave.getByText("You have unsaved changes in Blueprint import.", { exact: true }).waitFor();
          assert.equal(await leave.count(), 1); assert.equal(page.url(), sourceUrl);
          assert.deepEqual(writes, retainedWrites); assert.deepEqual(await read(), committed);
          await leave.getByRole("button", { name: decision, exact: true }).click();
          await leave.waitFor({ state: "hidden" });
        };
        await reviewLeave("Cancel");
        assert.equal(page.url(), sourceUrl); assert.equal(await input.inputValue(), retainedText);
        assert.equal(hashText(await input.inputValue()), retainedHash);
        await panel.getByText(/^Citadel structure outcome is unconfirmed/u).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Validate", exact: true }).isDisabled(), true);
        assert.equal(await panel.getByRole("button", { name: "Review import", exact: true }).isDisabled(), true);
        assert.deepEqual(writes, retainedWrites);
        await reviewLeave("Keep draft and close");
        await page.waitForURL(url => url.pathname === "/settings/general" && url.search === "?shell=cockpit" && !url.hash);
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await nav.getByRole("link", { name: "Citadel", exact: true }).click();
        await page.getByRole("tab", { name: "Blueprint", exact: true }).click(); await page.waitForURL(sourceUrl);
        await panel.getByText(`Citadel: ${id}`, { exact: true }).waitFor();
        // Remount reads the current export. Inspect its exact artifact before reopening the retained input.
        await panel.getByRole("button", { name: "Download blueprint", exact: true }).waitFor();
        await panel.getByText("Export preview", { exact: true }).click();
        const renderedExport = JSON.parse(await panel.locator("details pre").textContent());
        assert.deepEqual(renderedExport, await api(`${ownerPath}/blueprint`));
        assert.deepEqual(renderedExport.charter, lostBlueprint.charter);
        await panel.getByRole("button", { name: "Import · Unsaved", exact: true }).click();
        await input.waitFor(); assert.equal(await input.inputValue(), retainedText);
        assert.equal(hashText(await input.inputValue()), retainedHash);
        assert.equal(await panel.getByRole("button", { name: "Validate", exact: true }).isDisabled(), true);
        assert.equal(await panel.getByRole("button", { name: "Review import", exact: true }).isDisabled(), true);
        await panel.getByText(/^Citadel structure outcome is unconfirmed/u).waitFor();
        assert.equal(writes.length, count); assert.deepEqual(writes, retainedWrites);
        assert.deepEqual(await read(), committed);
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin);
        const finalRecords = (await api("/api/v1/citadels?view=all&limit=500")).items;
        for (const prior of initialRecords) assert.deepEqual(finalRecords.find(item => item.citadelId === prior.citadelId), prior);
        await capture("unknown-locked");
        return { status: "passed", metrics: { exactImportOwner: true, staleImportWrites: 0, cancelledImportWrites: 0, actualExportDownload: true, retainedUnknownAcrossRemount: true, canceledLeavePreservesImport: true, explicitKeepBeforeRemount: true, exactRetainedInputHash: retainedHash, sameDocumentRemount: true, remountImportWrites: 0, blockingAxe: 0,
          limitation: "Only Charter and Chambers in new disposable Citadels. No connections, grants, accounts or runtime activation." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const shot = path.join(screenshotDir, `ux-budgets-cockpit-citadel-blueprint-${variant}-failure.png`); await page.screenshot({ path: shot, fullPage: false }); screenshots.push(relativeToRun(context, shot)); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, target = panel) {
        await mkdir(screenshotDir, { recursive: true }); await target.scrollIntoViewIfNeeded(); await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const shot = path.join(screenshotDir, `ux-budgets-cockpit-citadel-blueprint-${variant}-${name}.png`); await page.screenshot({ path: shot, fullPage: false }); screenshots.push(relativeToRun(context, shot));
      }
    });
  }
}
