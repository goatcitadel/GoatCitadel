import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { runPersonalityEditorJourney } from "./cockpit-personality-editor-proof.mjs";

export function assertPersonalityDefaultSaved({ before, after, selectedId, request, response }) {
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  assert.match(after.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(after.revision, before.revision, "The personality owner revision did not advance.");
  assert.equal(after.defaultPersonalityId, selectedId, "The owner saved a different global default.");
  assert.ok(after.items.some((item) => item.id === selectedId), "The saved personality is absent from the catalog.");
  assert.deepEqual(request, { personalityId: selectedId, expectedRevision: before.revision });
  assert.equal(response.defaultPersonalityId, selectedId, "The mutation reply did not acknowledge the selected default.");
  assert.equal(response.revision, after.revision, "The mutation reply disagrees with canonical owner readback.");
}

/** Mutates only the disposable verification catalog and restores its original global default through the owner. */
export async function runCockpitPersonalityProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Personality proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "personality proof owner request"); return response.body;
  };
  const readCatalog = () => api("/api/v1/personalities");
  const restoreDefault = (personalityId, expectedRevision) => api("/api/v1/personalities/default", {
    method: "PATCH", body: { personalityId, expectedRevision },
  });
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-personality.${variant}`, lane: "ux-budgets",
      title: `Cockpit personality reviewed default and stale revision ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await readCatalog();
      const beforeSettings = await api("/api/v1/settings");
      const original = before.items.find((item) => item.id === before.defaultPersonalityId);
      const selected = before.items.find((item) => item.builtin && item.id !== "default" && item.id !== original?.id);
      assert.ok(original && selected, "The verification owner must expose two saved personality choices.");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      const screenshots = [];
      const diagnostics = [];
      const writes = [];
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) {
            writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit#work-personality"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        const panel = page.getByRole("region", { name: "Work personality", exact: true });
        const select = panel.getByRole("combobox", { name: "Saved personality", exact: true });
        await select.waitFor();
        await panel.getByText(`Current global default: ${original.label}`, { exact: true }).waitFor();
        await panel.getByText("Catalog details", { exact: true }).click();
        await panel.getByText(`Catalog revision: ${before.revision}`, { exact: true }).waitFor();
        assert.equal(await select.inputValue(), original.id);
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (stage) => {
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (blocking.length) {
            const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-personality-${variant}-${stage}-axe.json`);
            await mkdir(path.dirname(diagnostic), { recursive: true });
            await writeFile(diagnostic, JSON.stringify({ stage, theme, overflow, violations: blocking }, null, 2));
            diagnostics.push(relativeToRun(context, diagnostic));
          }
          assert.equal(blocking.length, 0, `Personality ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          assert.ok(overflow <= 1, `Personality ${stage} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-personality-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          return overflow;
        };
        await select.selectOption(selected.id);
        await panel.getByText("Saved instructions and safety notes", { exact: true }).click();
        assert.ok((await panel.innerText()).includes(selected.systemOverlay), "Saved instructions disagree with the owner.");
        assert.equal(await panel.locator("details code").textContent(), before.revision);
        await panel.getByRole("button", { name: "Review global default", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Change Work default?", exact: true });
        await dialog.waitFor();
        assert.ok((await dialog.innerText()).includes(selected.label));
        assert.ok((await dialog.innerText()).includes("future Work turns, including existing conversations"));
        assert.deepEqual(writes, [], "Personality review mutated the owner before confirmation.");
        assert.equal((await readCatalog()).revision, before.revision);
        await audit("review");
        await dialog.getByRole("button", { name: "Keep current default", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual(writes, [], "Cancelling the reviewed personality changed runtime state.");
        await panel.getByRole("button", { name: "Review global default", exact: true }).click();
        await dialog.waitFor();
        const committedResponse = page.waitForResponse((response) => response.request().method() === "PATCH"
          && new URL(response.url()).pathname === "/api/v1/personalities/default");
        await dialog.getByRole("button", { name: "Apply reviewed default", exact: true }).click();
        const committed = await committedResponse;
        assert.equal(committed.status(), 200, "The reviewed default did not complete.");
        await panel.getByText(`Current global default: ${selected.label}`, { exact: true }).waitFor();
        const saved = await readCatalog();
        assert.equal(writes.length, 1, "Changing a personality issued an unrelated or duplicate mutation.");
        assert.equal(writes[0].pathname, "/api/v1/personalities/default");
        assertPersonalityDefaultSaved({ before, after: saved, selectedId: selected.id, request: writes[0].body, response: await committed.json() });
        await panel.getByText(`Catalog revision: ${saved.revision}`, { exact: true }).waitFor();
        await panel.scrollIntoViewIfNeeded(); await audit("saved");

        // Restore using the real owner while a reviewed UI choice still holds the previous revision.
        await select.selectOption(original.id);
        await panel.getByRole("button", { name: "Review global default", exact: true }).click();
        await dialog.waitFor();
        const restored = await restoreDefault(original.id, saved.revision);
        assert.equal(restored.defaultPersonalityId, original.id);
        assert.notEqual(restored.revision, saved.revision);
        await dialog.getByRole("button", { name: "Apply reviewed default", exact: true }).click();
        await panel.getByText("The personality catalog changed. Review the current saved personality before applying it.", { exact: true }).waitFor();
        await panel.getByText(`Current global default: ${original.label}`, { exact: true }).waitFor();
        await panel.getByText(`Catalog revision: ${restored.revision}`, { exact: true }).waitFor();
        assert.equal(writes.length, 1, "A stale reviewed personality sent a second mutation.");
        const final = await readCatalog();
        assert.equal(final.defaultPersonalityId, original.id, "The isolated proof did not restore the original default.");
        assert.equal(final.revision, restored.revision);
        const afterSettings = await api("/api/v1/settings");
        assert.equal(afterSettings.llm?.activeProviderId, beforeSettings.llm?.activeProviderId);
        assert.equal(afterSettings.llm?.activeModel, beforeSettings.llm?.activeModel);
        await panel.scrollIntoViewIfNeeded(); const overflow = await audit("stale-guard");
        const editorEvidence = await runPersonalityEditorJourney({ page, panel, readCatalog, api, audit });
        return { status: "passed", metrics: { cancelledReviewMutations: 0, browserMutations: writes.length,
          savedDefaultConfirmed: true, staleMutationPrevented: true, originalDefaultRestored: true,
          ...editorEvidence, modelRouteUnchanged: true, blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-personality-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Preserve the original proof failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally {
        await browserContext.close();
        const current = await readCatalog();
        if (current.defaultPersonalityId !== original.id) {
          const restored = await restoreDefault(original.id, current.revision);
          assert.equal(restored.defaultPersonalityId, original.id, "Owner cleanup failed to restore the global default.");
        }
      }
    });
  }
}
