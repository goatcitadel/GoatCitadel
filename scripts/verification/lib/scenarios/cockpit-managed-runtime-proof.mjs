import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const editable = (runtime) => ({ enabled: runtime.enabled, autoStart: runtime.autoStart,
  baseUrl: runtime.baseUrl, alias: runtime.alias });
const completed = (plan) => ["completed", "applied"].includes(plan?.status);
export function assertManagedRuntimeSaved({ before, after, alias, request }) {
  assert.ok(Number.isSafeInteger(before.revision) && before.revision > 0);
  assert.ok(after.revision > before.revision, "The runtime configuration revision did not advance.");
  assert.deepEqual(request, { expectedRevision: before.revision, llamaCpp: { ...editable(before.llamaCpp), alias } });
  assert.deepEqual(editable(after.llamaCpp), { ...editable(before.llamaCpp), alias });
  assert.equal(after.llamaCpp.managementMode, "managed");
  assert.equal(after.llamaCpp.enabled, false, "The fixture must never enable a local process.");
  assert.equal(after.llamaCpp.autoStart, false, "The fixture must never request auto-start.");
  for (const key of ["command", "modelPath", "modelsRootPath"]) assert.equal(after.llamaCpp[key], before.llamaCpp[key]);
}

/** Only the disposable, disabled verification runtime is changed; every write uses its governed owner. */
export async function runCockpitManagedRuntimeProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Runtime proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, "managed runtime proof owner request");
    return response.body;
  };
  const read = () => api("/api/v1/settings");
  const readPlan = (id) => api(`/api/v1/change-plans/${encodeURIComponent(id)}?workspaceId=default`);
  async function settle(response, patch, revision) {
    const receipt = response.changePlanReceipt;
    if (!receipt) return response;
    let plan = await readPlan(receipt.planId);
    assert.equal(plan.origin?.workspaceId, "default"); assert.equal(plan.origin?.surface, "settings");
    assert.equal(plan.target?.ownerId, "runtime_settings"); assert.equal(plan.target?.expectedRevision, revision);
    assert.deepEqual(plan.request, { kind: "runtime_configuration", change: { operation: "llama_cpp_configuration", config: patch } });
    if (plan.status === "awaiting_approval") {
      assert.equal(plan.requiredAction?.kind, "approval");
      const approvalId = plan.requiredAction.approvalId;
      assert.ok(approvalId, "The runtime plan did not expose its approval owner.");
      const decision = await api(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST", body: { decision: "approve", resolutionNote: "Approved exact disabled runtime fixture configuration." },
      });
      assert.equal(decision.approval?.approvalId, approvalId); assert.equal(decision.approval?.status, "approved");
    }
    // The existing llama configuration owner resumes after its exact approval; do not bypass that flow.
    for (let attempt = 0; attempt < 40 && !completed(plan); attempt += 1) {
      plan = await readPlan(receipt.planId);
      if (["failed", "manual_required", "cancelled", "rollback_failed"].includes(plan.status)) break;
      if (!completed(plan)) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(completed(plan), `The governed runtime plan did not settle: ${plan.status}.`);
    return read();
  }
  async function save(patch) {
    const before = await read();
    const result = await api("/api/v1/settings", { method: "PATCH", body: { expectedRevision: before.revision, llamaCpp: patch } });
    return settle(result, patch, before.revision);
  }
  const original = await read();
  assert.equal(original.llamaCpp?.enabled, false, "Runtime proof must begin with the disposable runtime disabled.");
  assert.equal(original.llamaCpp?.autoStart, false, "Runtime proof must begin without auto-start.");
  const originalConfig = { ...editable(original.llamaCpp), managementMode: original.llamaCpp.managementMode ?? "external" };
  try {
    if (originalConfig.managementMode !== "managed") await save({ managementMode: "managed" });
    for (const { variant, viewport } of viewports) {
      await runScenario(context, { id: `ux-budgets.cockpit-managed-runtime.${variant}`, lane: "ux-budgets",
        title: `Cockpit managed runtime reviewed save and stale revision ${variant}`, subsystem: "mission-control-ux" }, async () => {
        const before = await read();
        const alias = `cockpit-${variant}-${Date.now()}`;
        const theme = variant === "mobile" ? "light" : "dark";
        const browserContext = await browser.newContext({ viewport, colorScheme: theme });
        const screenshots = []; const writes = []; let page;
        try {
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, "default", citadelId);
          page = await browserContext.newPage();
          page.on("request", (request) => {
            if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/"))
              writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
          });
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/advanced?shell=cockpit"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
          const panel = page.getByRole("region", { name: "Managed local runtime", exact: true });
          const aliasInput = panel.getByRole("textbox", { name: "Model alias", exact: true });
          // A background settings refetch temporarily removes the control-ready subtree. Capture one
          // rendered, refresh-ready observation instead of combining values across that transition.
          const readyView = await page.waitForFunction(() => {
            const panel = document.getElementById("managed-runtime");
            if (!panel) return null;
            const refresh = [...panel.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh runtime settings");
            const field = name => [...panel.querySelectorAll("label")].find(label => label.textContent?.trim() === name)?.querySelector("input");
            const alias = field("Model alias"), endpoint = field("Runtime endpoint");
            const revision = [...panel.querySelectorAll("p")].map(item => item.textContent?.replace(/\s+/gu, " ").trim())
              .find(value => /^Mode: Managed · settings revision \d+ · Process:/u.test(value ?? ""));
            return refresh && !refresh.disabled && alias && endpoint && revision
              ? { alias: alias.value, endpoint: endpoint.value, revision } : null;
          });
          const observed = await readyView.jsonValue(); await readyView.dispose();
          const canonical = await read();
          assert.equal(canonical.revision, before.revision, "The canonical settings changed before editing.");
          assert.deepEqual(editable(canonical.llamaCpp), editable(before.llamaCpp));
          assert.equal(canonical.llamaCpp.managementMode, "managed");
          assert.equal(observed.alias, before.llamaCpp.alias);
          assert.equal(observed.endpoint, before.llamaCpp.baseUrl);
          assert.equal(Number(/settings revision (\d+) ·/u.exec(observed.revision)?.[1]), before.revision);
          assert.deepEqual(writes, [], "Reading runtime readiness sent a mutation.");
          await page.addScriptTag({ path: axeSourcePath });
          const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
          const audit = async (stage) => {
            const axe = await auditPageAccessibility(page);
            const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.equal(blocking.length, 0, `Runtime ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
            assert.ok(overflow <= 1, `Runtime ${stage} overflow ${overflow}px`);
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-managed-runtime-${variant}-${stage}.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); return overflow;
          };
          await aliasInput.fill(alias);
          await panel.getByRole("button", { name: "Review runtime changes", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Apply managed runtime configuration?", exact: true });
          await dialog.waitFor();
          assert.ok((await dialog.innerText()).includes(before.llamaCpp.baseUrl));
          assert.ok((await dialog.innerText()).includes(`${before.llamaCpp.alias} → ${alias}`));
          assert.deepEqual(writes, [], "Review changed runtime settings before confirmation.");
          assert.equal((await read()).revision, before.revision); await audit("review");
          await dialog.getByRole("button", { name: "Keep current runtime settings", exact: true }).click();
          await dialog.waitFor({ state: "hidden" }); assert.deepEqual(writes, []);
          await panel.getByRole("button", { name: "Review runtime changes", exact: true }).click(); await dialog.waitFor();
          const responsePromise = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/v1/settings");
          await dialog.getByRole("button", { name: "Apply reviewed runtime settings", exact: true }).click();
          const response = await responsePromise; assert.equal(response.status(), 200);
          const request = response.request().postDataJSON();
          const saved = await settle(await response.json(), request.llamaCpp, before.revision);
          assertManagedRuntimeSaved({ before, after: saved, alias, request });
          assert.equal(writes.length, 1, "The browser sent a duplicate or unrelated mutation.");
          const refreshPlan = panel.getByRole("button", { name: "Refresh runtime change status", exact: true });
          if (await refreshPlan.count()) await refreshPlan.click();
          await panel.getByRole("button", { name: "Refresh runtime settings", exact: true }).click();
          await panel.getByText(/settings revision/).filter({ hasText: String(saved.revision) }).waitFor();
          assert.equal(await aliasInput.inputValue(), alias);
          await panel.scrollIntoViewIfNeeded(); await audit("saved");
          await aliasInput.fill(before.llamaCpp.alias);
          await panel.getByRole("button", { name: "Review runtime changes", exact: true }).click(); await dialog.waitFor();
          const restored = await save(editable(before.llamaCpp));
          assert.equal(restored.llamaCpp.alias, before.llamaCpp.alias);
          // The save's live event refreshes the panel shortly after `save` returns, and that refresh decides
          // whether this review is still confirmable. Branching before it lands races the refresh between the
          // check and the click. The open modal hides the region from role queries, so locate it by id.
          await page.locator("#managed-runtime").getByText(new RegExp(`settings revision ${restored.revision}\\b`, "u")).waitFor();
          const staleConfirm = dialog.getByRole("button", { name: "Apply reviewed runtime settings", exact: true });
          if (await staleConfirm.isDisabled()) {
            assert.ok((await dialog.innerText()).includes("This review is no longer current."));
            await audit("stale-review");
            await dialog.getByRole("button", { name: "Keep current runtime settings", exact: true }).click();
          } else {
            await staleConfirm.click();
            await panel.getByText("Runtime settings changed. Your draft is preserved; refresh and review the current revision.", { exact: true }).waitFor();
          }
          assert.equal(writes.length, 1, "The stale UI review sent a second settings mutation.");
          assert.equal((await read()).revision, restored.revision);
          await panel.scrollIntoViewIfNeeded(); const overflow = await audit("stale-guard");
          return { status: "passed", metrics: { savedRevision: saved.revision, reviewMutations: 0,
            browserMutations: writes.length, disabledRuntimeStayedDisabled: true, originalAliasRestored: true,
            staleMutationPrevented: true, blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
        } catch (error) {
          if (page && !page.isClosed()) {
            try {
              const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
              const screenshot = path.join(directory, `ux-budgets-cockpit-managed-runtime-${variant}-failure.png`);
              await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
            } catch { /* Preserve the original failure. */ }
          }
          return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
        } finally {
          await browserContext.close();
          const current = await read();
          if (current.llamaCpp.alias !== before.llamaCpp.alias) await save(editable(before.llamaCpp));
        }
      });
    }
  } finally {
    const current = await read();
    if (JSON.stringify({ ...editable(current.llamaCpp), managementMode: current.llamaCpp.managementMode }) !== JSON.stringify(originalConfig)) {
      const restored = await save(originalConfig);
      assert.deepEqual({ ...editable(restored.llamaCpp), managementMode: restored.llamaCpp.managementMode }, originalConfig);
    }
  }
}
