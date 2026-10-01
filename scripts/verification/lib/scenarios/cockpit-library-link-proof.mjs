import { proveCatalogDraftNavigation } from "./cockpit-navigation-draft-proof.mjs";
import { mkdir } from "node:fs/promises";

export async function runCockpitLibraryLinkProof({ context, browser, stack, citadelId, viewports, deps }) {
  // Load the built formatter after the lane has built the UI and its shared dependencies.
  const { presentCapabilityTitle, presentCapabilityDescription } = await import("../../../../packages/mission-control-shared/dist/content/capability-rows.js");
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-library-link.${variant}`, lane: "ux-budgets",
      title: `Cockpit Library saved links ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
        method: "POST", body: { workspaceName: `Library links ${variant}`, sessionTitle: "Library link owner", sessionCount: 1, longThreadTurns: 2 },
      });
      assertOk(seeded, "seed Library workspace");
      const owner = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/catalog?scope=inspectable");
      assertOk(owner, "read Library owner catalog");
      const item = owner.body?.items?.filter((entry) => entry.kind === "skill" && entry.title && entry.summary).at(-1);
      if (!item || !seeded.body?.workspaceId) throw new Error("Library proof needs a named skill and scoped workspace.");
      const title = presentCapabilityTitle(item);
      const description = presentCapabilityDescription(item);
      const browserContext = await browser.newContext({ viewport });
      try {
        await browserContext.addInitScript((theme) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        }, variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, seeded.body.workspaceId, citadelId);
        const page = await browserContext.newPage();
        const href = `/library/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.capabilityId)}?shell=cockpit&type=skill`;
        await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" });
        const detail = variant === "mobile" ? page.getByRole("dialog", { name: title, exact: true }) : page.getByRole("complementary", { name: "Capability details" });
        await detail.getByRole("tab", { name: "Overview", exact: true }).waitFor({ timeout: 30_000 });
        await detail.getByRole("heading", { name: title, exact: true }).waitFor();
        if (!(await detail.textContent()).includes(description)) throw new Error("Library deep link selected different owner content.");
        await page.reload({ waitUntil: "domcontentloaded" });
        await detail.getByRole("tab", { name: "Overview", exact: true }).waitFor({ timeout: 30_000 });
        await detail.getByRole("heading", { name: title, exact: true }).waitFor();
        if (!(await detail.textContent()).includes(description)) throw new Error("Library reload lost the selected capability.");
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((entry) => ["serious", "critical"].includes(entry.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (blocking.length || overflow > 1) throw new Error(`Library link ${variant}: accessibility ${blocking.map((entry) => entry.id).join(", ") || "clear"}; overflow ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-library-link-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        if (variant === "mobile") await detail.getByRole("button", { name: "Close sheet", exact: true }).click();
        const typeFilter = page.getByRole("combobox", { name: /^Type(?:\s|$)/u });
        await typeFilter.selectOption("tool");
        await typeFilter.selectOption("skill");
        if (new URL(page.url()).searchParams.get("type") !== "skill") throw new Error("Library query-only navigation did not preserve the filter.");
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#approval-mode"), { waitUntil: "domcontentloaded" });
        const draftNavigation = await proveCatalogDraftNavigation({ page, readGrants: async () => {
          const response = await requestJson(stack.gatewayUrl, "/api/v1/tools/grants?limit=400");
          assertOk(response, "navigation tool-grant owner"); return response.body;
        } });
        await typeFilter.waitFor();
        if (await typeFilter.inputValue() !== "tool") throw new Error("Safety did not open the filtered tool catalog.");
        return { status: "passed", metrics: { capabilityId: item.capabilityId, blockingAxe: 0, overflow, draftNavigation },
          artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } finally { await browserContext.close(); }
    });
  }
}
