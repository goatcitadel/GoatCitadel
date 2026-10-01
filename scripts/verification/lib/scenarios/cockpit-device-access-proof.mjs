import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/** Device grants are created through the real request/approval owners in a disposable runtime. */
export async function runCockpitDeviceAccessProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Device proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    // Device request responses contain a private poll secret; never dump response bodies.
    assert.ok(response.ok, `Device proof owner request failed (${response.status}).`);
    return response.body;
  };
  const read = () => api("/api/v1/auth/devices?view=all");
  async function seed(label) {
    const request = await api("/api/v1/auth/device-requests", {
      method: "POST", body: { deviceLabel: label, deviceType: "tablet", platform: "Verification fixture" },
    });
    assert.ok(request.approvalId && request.requestId);
    const resolved = await api(`/api/v1/approvals/${encodeURIComponent(request.approvalId)}/resolve`, {
      method: "POST", body: { decision: "approve", resolutionNote: "Disposable cockpit device-grant fixture." },
    });
    assert.equal(resolved.approval?.approvalId, request.approvalId);
    assert.equal(resolved.approval?.status, "approved");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const grant = (await read()).items.find((item) => item.requestId === request.requestId);
      if (grant) {
        assert.equal(grant.deviceLabel, label); assert.ok(!grant.revokedAt);
        return grant;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("The approved device request did not produce its grant.");
  }
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-device-access.${variant}`, lane: "ux-budgets",
      title: `Cockpit reviewed device access revocation ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const subject = await seed(`Cockpit device ${variant}`);
      const other = await seed(`Retained device ${variant}`);
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      const screenshots = [];
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        const mutations = [];
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
            && /^\/api\/v1\/auth\/(devices|companion)/.test(pathname)) mutations.push(`${request.method()} ${pathname}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/access?shell=cockpit"), { waitUntil: "domcontentloaded" });
        const panel = page.getByRole("region", { name: "Approved devices", exact: true });
        const row = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: subject.deviceLabel, exact: true }) });
        await row.waitFor();
        await row.getByRole("button", { name: "Revoke access", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Revoke device access?", exact: true });
        await dialog.waitFor();
        assert.ok((await dialog.innerText()).includes(subject.deviceLabel));
        assert.ok((await dialog.innerText()).includes("companion sessions and session controls"));
        assert.deepEqual(mutations, []);
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (stage) => {
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((entry) => ["serious", "critical"].includes(entry.impact));
          assert.equal(blocking.length, 0, `Device ${stage} accessibility: ${blocking.map((entry) => entry.id).join(", ")}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `Device ${stage} overflow: ${overflow}px`);
          const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `ux-budgets-cockpit-device-access-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("review");
        await dialog.getByRole("button", { name: "Keep access", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual(mutations, []);
        assert.ok(!(await read()).items.find((item) => item.grantId === subject.grantId)?.revokedAt);
        await row.getByRole("button", { name: "Revoke access", exact: true }).click();
        const response = page.waitForResponse((result) => result.request().method() === "POST"
          && new URL(result.url()).pathname === `/api/v1/auth/devices/${subject.grantId}/revoke`);
        await dialog.getByRole("button", { name: "Revoke device access", exact: true }).click();
        const receiptResponse = await response;
        assert.equal(receiptResponse.status(), 200);
        const receipt = await receiptResponse.json();
        assert.equal(receipt.grant?.grantId, subject.grantId);
        assert.equal(receipt.grant?.requestId, subject.requestId);
        assert.ok(receipt.grant?.revokedAt);
        await row.getByText("Device access revoked.", { exact: true }).waitFor();
        const after = await read();
        assert.equal(after.items.find((item) => item.grantId === subject.grantId)?.revokedAt, receipt.grant.revokedAt);
        assert.deepEqual(after.items.find((item) => item.grantId === other.grantId), other, "Revocation changed another device.");
        assert.deepEqual(mutations, [`POST /api/v1/auth/devices/${subject.grantId}/revoke`]);
        assert.equal(await row.getByRole("button", { name: "Revoke access", exact: true }).isDisabled(), true);
        await row.scrollIntoViewIfNeeded(); await audit("revoked");
        await page.reload({ waitUntil: "domcontentloaded" });
        await row.getByText(/ · Revoked$/, { exact: false }).waitFor();
        assert.equal(await row.getByRole("button", { name: "Revoke access", exact: true }).isDisabled(), true);
        return { status: "passed", metrics: { actualGrantRevoked: true, otherGrantUnchanged: true,
          reviewCancelledWithoutMutation: true, revokedStateSurvivesReload: true, deviceTokensRetrieved: false,
          companionSessionRevocationExercised: false, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page) {
          const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
          const screenshot = path.join(directory, `ux-budgets-cockpit-device-access-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        }
        return { status: "failed", error: String(error?.stack ?? error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
