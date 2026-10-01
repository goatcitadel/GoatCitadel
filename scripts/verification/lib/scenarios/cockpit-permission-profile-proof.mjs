import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export function assertPermissionActivationOwnerAgreement({ workspaceId, reviewed, request, receipt, effective }) {
  assert.equal(reviewed.input.operation, "activate");
  assert.equal(reviewed.input.workspaceId, workspaceId);
  assert.equal(reviewed.input.surface, "chat");
  assert.equal(reviewed.input.sessionId, undefined);
  assert.equal(reviewed.target.workspaceId, workspaceId);
  assert.match(reviewed.revision, /^[a-f0-9]{64}$/);
  assert.match(reviewed.profile.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(request, { profileId: reviewed.profile.profileId, workspaceId, surface: "chat",
    expectedProfileRevision: reviewed.profile.revision, expectedSelectionRevision: reviewed.revision });
  assert.ok(receipt.activationId);
  assert.equal(receipt.active, true);
  assert.equal(receipt.workspaceId, workspaceId);
  assert.equal(receipt.sessionId, undefined);
  assert.equal(receipt.operatorId, reviewed.target.operatorId);
  assert.equal(receipt.surface, "chat");
  assert.equal(receipt.profileId, reviewed.profile.profileId);
  assert.equal(effective.permissionProfile?.profileId ?? effective.permissionProfileId, reviewed.profile.profileId);
}

/** Uses new workspaces only in the lane-owned runtime; no tool execution or profile-rule edits. */
export async function runCockpitPermissionProfileProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Permission proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "permission proof owner request"); return response.body;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-permission-profile.${variant}`, lane: "ux-budgets",
      title: `Cockpit reviewed workspace Chat profile ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "create isolated workspace";
      let page;
      let browserContext;
      const screenshots = [];
      const writes = [];
      const unrelatedWrites = [];
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const suffix = randomUUID().slice(0, 8);
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: {
          citadelId, name: `Permission proof ${variant} ${suffix}`, slug: `permission-proof-${suffix}`, description: "Disposable native Settings verification scope",
        } });
        const workspaceId = workspace.workspaceId;
        assert.ok(workspaceId);
        const profiles = await api(`/api/v1/tools/permission-profiles?workspaceId=${encodeURIComponent(workspaceId)}`);
        const selected = profiles.items.find((item) => item.profileId === "safe" && item.status === "active" && item.approvalMode === "approve_all");
        assert.ok(selected, "The owner must expose its existing safe profile.");
        const readEffective = () => api(`/api/v1/tools/permission-profiles/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=chat`);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (request.method() === "POST" && pathname === "/api/v1/tools/permission-profiles/activate") writes.push(request.postDataJSON());
          else if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")
            && pathname !== "/api/v1/tools/permission-profiles/selection-review") unrelatedWrites.push(`${request.method()} ${pathname}`);
        });
        stage = "open native permission owner";
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Chat permission profile", exact: true });
        await panel.getByRole("searchbox", { name: "Find permission profile", exact: true }).fill(selected.label);
        const choice = panel.getByRole("radio", { name: new RegExp(`^${selected.label}(?:\\s|$)`) });
        await choice.check();
        const group = panel.getByRole("group", { name: "Reviewed Chat profile selection", exact: true });
        const requestReview = async () => {
          const response = page.waitForResponse((item) => item.request().method() === "POST"
            && new URL(item.url()).pathname === "/api/v1/tools/permission-profiles/selection-review");
          await panel.getByRole("button", { name: "Review Chat profile selection", exact: true }).click();
          const result = await response; assert.equal(result.status(), 200);
          const review = await result.json(); await group.waitFor();
          assert.equal(review.input.workspaceId, workspaceId);
          assert.equal(review.input.surface, "chat");
          assert.equal(review.profile.profileId, selected.profileId);
          return review;
        };
        await mkdir(screenshotDir, { recursive: true });
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (name) => {
          await panel.scrollIntoViewIfNeeded();
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Permission ${name} axe: ${blocking.map((item) => item.id).join(", ")}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `Permission ${name} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-permission-profile-${variant}-${name}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        stage = "review and cancel without activation";
        await requestReview(); assert.equal(writes.length, 0);
        await audit("review");
        await group.getByRole("button", { name: "Cancel selection", exact: true }).click();
        await group.waitFor({ state: "hidden" }); assert.equal(writes.length, 0);

        stage = "apply reviewed owner selection";
        const reviewed = await requestReview();
        const savedResponse = page.waitForResponse((item) => item.request().method() === "POST"
          && new URL(item.url()).pathname === "/api/v1/tools/permission-profiles/activate");
        await group.getByRole("button", { name: "Apply reviewed Chat profile", exact: true }).click();
        const response = await savedResponse; assert.equal(response.status(), 200);
        const receipt = await response.json();
        await panel.getByText(`Current effective workspace Chat profile: ${selected.label}`, { exact: true }).waitFor();
        await group.waitFor({ state: "hidden" });
        assert.equal(writes.length, 1);
        assertPermissionActivationOwnerAgreement({ workspaceId, reviewed, request: writes[0], receipt, effective: await readEffective() });
        await audit("saved");

        stage = "reject stale reviewed selection before mutation";
        const stale = await requestReview();
        const fresh = await api("/api/v1/tools/permission-profiles/selection-review", { method: "POST", body: stale.input });
        await api("/api/v1/tools/permission-profiles/activate", { method: "POST", body: { profileId: selected.profileId, workspaceId,
          surface: "chat", expectedProfileRevision: fresh.profile.revision, expectedSelectionRevision: fresh.revision } });
        const changed = await api("/api/v1/tools/permission-profiles/selection-review", { method: "POST", body: stale.input });
        assert.notEqual(changed.revision, stale.revision, "Concurrent owner activation must advance the selection revision.");
        await group.getByRole("button", { name: "Apply reviewed Chat profile", exact: true }).click();
        await panel.getByText("Permission selections changed. Review the current selection before applying it again.", { exact: true }).waitFor();
        await group.waitFor({ state: "hidden" }); assert.equal(writes.length, 1, "A stale review dispatched an activation.");
        await audit("stale-guard");

        stage = "retain unknown acknowledgement without retry";
        const uncertainReview = await requestReview();
        let ownerReply;
        let intercepted = 0;
        const loseAcknowledgement = async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          intercepted += 1;
          const owner = await route.fetch(); assert.equal(owner.status(), 200);
          ownerReply = await owner.json(); await route.abort("failed");
        };
        await page.route("**/api/v1/tools/permission-profiles/activate", loseAcknowledgement);
        await group.getByRole("button", { name: "Apply reviewed Chat profile", exact: true }).click();
        await panel.getByText(/Permission selection outcome is uncertain\./).waitFor();
        assert.equal(intercepted, 1); assert.equal(writes.length, 2);
        assertPermissionActivationOwnerAgreement({ workspaceId, reviewed: uncertainReview, request: writes[1], receipt: ownerReply, effective: await readEffective() });
        await page.unroute("**/api/v1/tools/permission-profiles/activate", loseAcknowledgement);
        // A component remount within the current app session must retain the lock.
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
        await panel.getByText(/Permission selection outcome is uncertain\./).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Review Chat profile selection", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 2); assert.deepEqual(unrelatedWrites, []);
        await audit("unknown-locked");
        return { status: "passed", metrics: { workspaceId, profileId: selected.profileId, cancelledActivationWrites: 0,
          browserActivations: writes.length, exactOwnerAgreement: true, staleWritePrevented: true,
          responseLossInjected: true, appSessionRemountLock: true, blockingAxe: 0,
          limitation: "Existing safe profile in disposable workspaces; no tool execution. Response loss is injected after a real owner commit." },
        artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try { await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-permission-profile-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Keep the original failure even when screenshot capture is unavailable. */ }
        }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserActivations: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
    });
  }
}
