import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function selectTrustProofCapability(snapshot) {
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.mutationSemantics, "none");
  const candidates = snapshot.capabilities.callable.length ? snapshot.capabilities.callable : snapshot.capabilities.inspectable;
  const item = candidates.find((candidate) => {
    const label = candidate.title ?? candidate.capabilityId;
    return label && candidates.filter((other) => (other.title ?? other.capabilityId) === label).length === 1;
  });
  assert.ok(item, "The live snapshot must provide a uniquely named capability to inspect.");
  return item;
}

export async function runCockpitTrustPolicyProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-trust-policy.${variant}`, lane: "ux-budgets",
      title: `Native Trust snapshot filtering and exact evidence ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [], writes = [];
      let page;
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/")) writes.push({ method: request.method(), path: new URL(request.url()).pathname });
        });
        const isSnapshot = (response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/trust/policy-snapshot";
        const firstRead = page.waitForResponse(isSnapshot);
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#trust-policy"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const firstResponse = await firstRead;
        assert.equal(firstResponse.status(), 200);
        const snapshot = await firstResponse.json();
        const capability = selectTrustProofCapability(snapshot);
        const label = capability.title ?? capability.capabilityId;
        const panel = page.getByRole("region", { name: "Trust and policy", exact: true });
        await panel.getByRole("searchbox", { name: "Search trust evidence", exact: true }).waitFor();
        assert.ok((await panel.innerText()).includes("across recorded scopes"));
        await panel.getByRole("combobox", { name: "Evidence type", exact: true }).selectOption("capability");
        await panel.getByRole("searchbox", { name: "Search trust evidence", exact: true }).fill(label);
        await panel.getByRole("button", { name: `Inspect trust evidence ${label}`, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: `Trust evidence: ${label}`, exact: true });
        await dialog.waitFor();
        const detail = await dialog.innerText();
        assert.ok(detail.includes(`capability:${capability.capabilityId}`), "Trust detail substituted the selected owner ID.");
        assert.ok(detail.includes(capability.source), "Trust detail omitted the owner source.");
        assert.ok(detail.includes(capability.trustLabel ?? capability.lifecycleState ?? "Unknown"));
        if (capability.reviewWarning) assert.ok(detail.includes(capability.reviewWarning));
        for (const required of capability.requires ?? []) assert.ok(detail.includes(`Requires ${required}`));
        assert.equal(await dialog.getByRole("link", { name: "Open Library / Capabilities in detailed settings", exact: true }).getAttribute("href"), "/library/capabilities?shell=classic");
        await page.addScriptTag({ path: axeSourcePath });
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const audit = async (stage) => {
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Trust accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `Trust overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-trust-policy-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        };
        await audit("detail");
        await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
        const search = panel.getByRole("searchbox", { name: "Search trust evidence", exact: true });
        await search.fill("verification-no-match-b015e925-543f-4e10");
        await panel.getByText("No trust evidence matches these filters.", { exact: true }).waitFor();
        await search.fill("");
        const refresh = page.waitForResponse(isSnapshot);
        await panel.getByRole("button", { name: "Refresh trust snapshot", exact: true }).click();
        assert.equal((await refresh).status(), 200);
        await panel.getByRole("button", { name: "Refresh trust snapshot", exact: true }).waitFor();
        await panel.scrollIntoViewIfNeeded(); await audit("filtered");
        assert.deepEqual(writes, [], "Inspecting Trust evidence mutated a runtime owner.");
        return { status: "passed", metrics: { exactOwnerCapabilityId: capability.capabilityId, ownerSnapshotObserved: snapshot.generatedAt,
          readOnly: true, filterAndRefresh: true, browserMutations: 0, blockingAxe: 0, overflow: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true });
            const screenshot = path.join(dir, `ux-budgets-cockpit-trust-policy-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Preserve the original read-only proof failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
