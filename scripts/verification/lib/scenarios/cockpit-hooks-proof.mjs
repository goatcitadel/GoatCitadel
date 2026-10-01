import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export function assertHookReviewHasNoEffects({ before, after, writes, persistedValues, secret }) {
  assert.deepEqual(after, before, "Hook review/cancellation changed canonical records or deliveries.");
  assert.deepEqual(writes, [], "Hook review/cancellation dispatched a mutation.");
  assert.equal(persistedValues.some(value => value.includes(secret)), false, "Signing input entered browser storage.");
}

/** Owner evidence and guarded cancellation. No OS keychain write or external webhook send. */
export async function runCockpitHooksProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Requires disposable verification runtime.");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `Hook owner request failed (${response.status}).`); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-hooks.${variant}`, lane: "ux-budgets",
      title: `Native scoped hook evidence, secret custody and registration cancellation ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let page, browserContext, stage = "seed unique workspace";
      const screenshots = [], diagnostics = [], writes = [];
      const suffix = randomUUID().slice(0, 8), secret = `verification-private-${randomUUID()}`;
      try {
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Hooks fixture ${suffix}`, ...(citadelId ? { citadelId } : {}) } });
        assert.ok(workspace.workspaceId && workspace.workspaceId !== "default");
        const route = `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}/hooks`;
        const read = async () => ({ hooks: (await api(`${route}?limit=500`)).items, runs: (await api(`${route}/runs?limit=500`)).items });
        const before = await read(); assert.deepEqual(before, { hooks: [], runs: [] });
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => { const pathname = new URL(request.url()).pathname;
          if (request.method() !== "GET" && pathname.startsWith(route)) writes.push({ method: request.method(), pathname }); });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#hooks"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Governed hooks", exact: true });
        await panel.getByText("No matching hooks returned.", { exact: true }).waitFor();
        assert.ok((await panel.innerText()).includes(workspace.workspaceId));
        await panel.getByRole("button", { name: "Delivery history", exact: true }).click();
        await panel.getByText("No retained deliveries returned.", { exact: true }).waitFor();
        await capture("owner-evidence");
        stage = "review registration without credential custody or delivery side effects";
        await panel.getByRole("button", { name: "Register hook", exact: true }).click();
        await panel.getByLabel("Hook label", { exact: true }).fill(`Review only ${suffix}`);
        await panel.getByLabel("Lifecycle event", { exact: true }).selectOption("tool.call.after");
        await panel.getByLabel("Hook mode", { exact: true }).selectOption("observe");
        await panel.getByLabel("HTTPS endpoint", { exact: true }).fill(`https://fixture.invalid/review-${suffix}`);
        await panel.getByLabel("Signing secret", { exact: true }).fill(secret);
        await panel.getByRole("button", { name: "Review hook registration", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Register this hook?", exact: true });
        await dialog.waitFor();
        const description = await dialog.innerText();
        assert.ok(description.includes(workspace.workspaceId) && description.includes("tool.call.after"));
        assert.ok(description.includes("Future matching events may send metadata") && description.includes("no atomic revision precondition"));
        assert.equal(description.includes(secret), false);
        await capture("registration-review");
        await dialog.getByRole("button", { name: "Cancel hook action", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        const persistedValues = await page.evaluate(() => [...Object.values(window.localStorage), ...Object.values(window.sessionStorage)]);
        assertHookReviewHasNoEffects({ before, after: await read(), writes, persistedValues, secret });
        stage = "discard ephemeral endpoint and signing input";
        await panel.getByRole("button", { name: "Close hook editor", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved hook inputs", exact: true }); await leave.waitFor();
        assert.equal(await leave.getByRole("button", { name: "Keep public draft and close", exact: true }).count(), 0);
        await leave.getByRole("button", { name: "Discard hook inputs", exact: true }).click();
        await leave.waitFor({ state: "hidden" });
        await panel.getByRole("button", { name: "Register hook", exact: true }).click();
        assert.equal(await panel.getByLabel("Signing secret", { exact: true }).inputValue(), "");
        assert.equal(await panel.getByLabel("HTTPS endpoint", { exact: true }).inputValue(), "");
        assertHookReviewHasNoEffects({ before, after: await read(), writes, persistedValues, secret });
        await capture("discarded");
        return { status: "passed", metrics: { scopedCanonicalEvidence: true, registrationCancellationWrites: 0,
          transientSigningInput: true, keychainWriteTested: false, externalHookDeliveryTested: false, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await screenshot("failure"); } catch { /* Preserve first failure. */ } }
        const failure = `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.replaceAll(secret, "[REDACTED]");
        return { status: "failed", error: failure,
          metrics: { failedStage: stage, writes }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
      async function screenshot(name) {
        const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const file = path.join(directory, `cockpit-hooks-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, file));
      }
      async function capture(name) {
        await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-hooks-${variant}-${name}-axe.json`); await writeFile(file, JSON.stringify(blocking, null, 2).replaceAll(secret, "[REDACTED]")); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        await screenshot(name);
      }
    });
  }
}
