import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { reviewNavigationDraft } from "./cockpit-navigation-draft-proof.mjs";
import { createReviewedMutationRecorder } from "./cockpit-reviewed-mutations.mjs";

export function assertReviewedToolGrant(input, receipt, owner) {
  assert.ok(receipt.grantId && receipt.createdBy && Number.isFinite(Date.parse(receipt.createdAt)));
  for (const field of ["toolPattern", "decision", "scope", "grantType"]) assert.equal(receipt[field], input[field]);
  assert.equal(receipt.scopeRef, input.scope === "global" ? "global" : input.scopeRef);
  assert.equal(receipt.expiresAt, input.expiresAt);
  const rows = owner.items.filter((item) => item.grantId === receipt.grantId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], receipt);
}

export async function runCockpitToolGrantsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  const read = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-tool-grants.${variant}`, lane: "ux-budgets",
      title: `Native tool grant reviewed scope, revoke and unknown lock ${variant}`, subsystem: "mission-control-ux" }, async () => {
      assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)), "Grant writes require an isolated fixture");
      const token = randomUUID().slice(0, 8);
      const workspace = await read("/api/v1/workspaces", { method: "POST", body: { name: `Tool grants ${token}`, ...(citadelId ? { citadelId } : {}) } });
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page; const screenshots = [], traffic = createReviewedMutationRecorder(), writes = traffic.writes;
      try {
        await browserContext.addInitScript((value) => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => traffic.record(request));
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#approval-mode"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Tool catalog and grants", exact: true });
        await panel.getByRole("button", { name: "Review new grant", exact: true }).waitFor();
        await panel.getByLabel("Tool pattern", { exact: true }).fill(`verification.tool.${token}`);
        await panel.getByLabel("Decision", { exact: true }).selectOption("deny");
        await panel.getByLabel("Scope", { exact: true }).selectOption("workspace");
        await panel.getByLabel("Scope ID", { exact: true }).fill(workspace.workspaceId);
        const defaultExpiry = await panel.getByLabel("Expires at", { exact: true }).inputValue();
        assert.equal(await panel.getByLabel("Grant type", { exact: true }).inputValue(), "ttl");
        await panel.getByRole("button", { name: "Review new grant", exact: true }).click();
        let dialog = page.getByRole("dialog", { name: "Review new tool grant", exact: true }); await dialog.waitFor();
        assert.ok((await dialog.innerText()).includes(workspace.workspaceId));
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await traffic.assertPageBackground(page, workspace.workspaceId);
        assert.deepEqual(writes, [], "Cancelled grant review wrote to an owner");
        await panel.getByRole("button", { name: "Review new grant", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Review new tool grant", exact: true });
        const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/tools/grants");
        await dialog.getByRole("button", { name: "Create reviewed grant", exact: true }).click();
        const created = await createResponse; assert.equal(created.status(), 201); const receipt = await created.json();
        const input = { toolPattern: `verification.tool.${token}`, decision: "deny", scope: "workspace", scopeRef: workspace.workspaceId, grantType: "ttl", expiresAt: defaultExpiry };
        assert.ok(Date.parse(input.expiresAt) > Date.now() + 50 * 60_000 && Date.parse(input.expiresAt) <= Date.now() + 60 * 60_000, "New grant must default to one hour");
        assert.deepEqual(writes, [{ method: "POST", pathname: "/api/v1/tools/grants", body: input }]);
        assertReviewedToolGrant(input, receipt, await read("/api/v1/tools/grants?limit=400"));
        await panel.getByText("Tool grant recorded. Effective policy and approval gates still apply.", { exact: true }).waitFor();
        await panel.getByRole("button", { name: `Inspect grant ${receipt.grantId}`, exact: true }).click();
        const detail = page.getByRole("dialog", { name: "Recorded tool grant", exact: true }); await detail.waitFor();
        assert.ok((await detail.innerText()).includes(receipt.grantId));
        await page.addScriptTag({ path: axeSourcePath });
        const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true });
        const audit = async (stage) => {
          await page.evaluate(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); await Promise.all(document.getAnimations().filter((item) => item.effect?.getTiming().iterations !== Infinity).map((item) => item.finished.catch(() => undefined))); });
          const axe = await auditPageAccessibility(page); const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Grant accessibility: ${JSON.stringify(blocking.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })))}`);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), "Grant page overflow");
          const screenshot = path.join(dir, `ux-budgets-cockpit-tool-grants-${variant}-${stage}.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("recorded"); await detail.getByRole("button", { name: "Close dialog", exact: true }).click();
        await panel.getByRole("button", { name: `Revoke grant ${receipt.grantId}`, exact: true }).click();
        const revoke = page.getByRole("dialog", { name: "Revoke tool grant", exact: true }); await revoke.waitFor();
        assert.ok((await revoke.innerText()).includes(receipt.grantId));
        const revokeResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/tools/grants/${receipt.grantId}/revoke`);
        await revoke.getByRole("button", { name: "Confirm revocation", exact: true }).click(); assert.equal((await revokeResponse).status(), 200);
        await panel.getByText("Tool grant revoked.", { exact: true }).waitFor();
        const revoked = (await read("/api/v1/tools/grants?limit=400")).items.find((item) => item.grantId === receipt.grantId);
        assert.ok(revoked?.revokedAt && revoked.revokedBy === receipt.createdBy);
        await panel.getByLabel("Tool pattern", { exact: true }).fill(`verification.tool.${token}.lost`);
        await panel.getByLabel("Decision", { exact: true }).selectOption("deny");
        await panel.getByRole("button", { name: "Review new grant", exact: true }).click();
        let lostReceipt;
        await page.route("**/api/v1/tools/grants", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          const response = await route.fetch(); assert.equal(response.status(), 201); lostReceipt = await response.json(); await route.abort("failed");
        });
        await page.getByRole("dialog", { name: "Review new tool grant", exact: true }).getByRole("button", { name: "Create reviewed grant", exact: true }).click();
        await panel.getByText(/Grant write outcome is unconfirmed\./).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Review new grant", exact: true }).isDisabled(), true);
        assertReviewedToolGrant({ ...input, toolPattern: `verification.tool.${token}.lost` }, lostReceipt, await read("/api/v1/tools/grants?limit=400"));
        const documentTime = await page.evaluate(() => performance.timeOrigin);
        const retainedDraft = async () => {
          for (const [label, expected] of Object.entries({ "Tool pattern": `verification.tool.${token}.lost`,
            Decision: "deny", Scope: "workspace", "Scope ID": workspace.workspaceId, "Grant type": "ttl", "Expires at": input.expiresAt })) {
            assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), expected, `Navigation changed ${label}.`);
          }
          await panel.getByText(/Grant write outcome is unconfirmed\./).waitFor();
          assert.equal(await panel.getByRole("button", { name: "Review new grant", exact: true }).isDisabled(), true);
          assert.equal(writes.length, 3, "Draft navigation retried the unconfirmed grant mutation.");
        };
        const openGeneral = () => page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await reviewNavigationDraft(page, openGeneral, "Cancel");
        await retainedDraft();
        await reviewNavigationDraft(page, openGeneral, "Keep draft and close");
        await page.waitForURL(value => value.pathname === "/settings/general");
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        assert.equal(writes.length, 3);
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
        await page.getByRole("tab", { name: "Tools", exact: true }).click();
        await page.waitForURL(value => value.pathname === "/settings/safety" && value.hash === "#approval-mode");
        await panel.getByRole("button", { name: "Review new grant", exact: true }).waitFor();
        await retainedDraft();
        assertReviewedToolGrant({ ...input, toolPattern: `verification.tool.${token}.lost` }, lostReceipt, await read("/api/v1/tools/grants?limit=400"));
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentTime, "Unknown-lock check must remount in the same app session");
        assert.equal(writes.length, 3); await audit("unknown-lock");
        await traffic.assertPageBackground(page, workspace.workspaceId);
        return { status: "passed", metrics: { reviewedGrantId: receipt.grantId, cancelledWrites: 0, browserMutations: traffic.total,
          reviewedOwnerMutations: writes.length, presenceMutations: traffic.presence.length, observerRequests: traffic.observers.length, exactScope: true,
          independentReadback: true, revoked: true, unknownLockAcrossRemount: true, toolInvocations: 0, blockingAxe: 0, overflow: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true }); const screenshot = path.join(dir, `ux-budgets-cockpit-tool-grants-${variant}-failure.png`); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve the owner failure. */ } }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
