import { proveCatalogDraftNavigation } from "./cockpit-navigation-draft-proof.mjs";
import { mkdir } from "node:fs/promises";

// The kinds the Library catalog still lists. Skills and tools are listed in Capabilities, so a Library skill record
// lands there and the Library's Type filter offers only these (see library-catalog-kinds.ts).
const LIBRARY_KINDS = ["code_mode", "proposal", "candidate_skill", "mesh_tool", "mesh_mcp_server", "mesh_skill"];

export async function runCockpitLibraryLinkProof({ context, browser, stack, citadelId, viewports, deps }) {
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
      // A Library skill record is `skill:<skillId>`, which is also the value of the Skills tab's `?item=`.
      const panelItem = `skill:${item.capabilityId.replace(/^skill:/u, "")}`;
      // The Type filter offers a kind only when the catalog holds one. Use a kind the seed provides; with none, the
      // Library shows its empty state, which is asserted instead.
      const libraryKind = owner.body.items.find((entry) => LIBRARY_KINDS.includes(entry.kind))?.kind;
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
        // The old Library address lands on the skill's panel in Capabilities; the Library's catalog filter stays behind.
        const atSkillPanel = (url) => url.pathname === "/capabilities/skills" && url.searchParams.get("item") === panelItem
          && url.searchParams.get("shell") === "cockpit" && !url.searchParams.has("type");
        await page.waitForURL(atSkillPanel, { timeout: 30_000 });
        // The inspector's body is a region named "Inspector: <skill>", docked on a wide screen and in the phone sheet.
        const detail = page.getByRole("region", { name: /^Inspector: /u });
        await detail.getByRole("heading", { name: "Uses", exact: true }).waitFor({ timeout: 30_000 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForURL(atSkillPanel, { timeout: 30_000 });
        await detail.getByRole("heading", { name: "Uses", exact: true }).waitFor({ timeout: 30_000 });
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((entry) => ["serious", "critical"].includes(entry.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (blocking.length || overflow > 1) throw new Error(`Library link ${variant}: accessibility ${blocking.map((entry) => entry.id).join(", ") || "clear"}; overflow ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-library-link-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library?shell=cockpit"), { waitUntil: "domcontentloaded" });
        const typeFilter = page.getByRole("combobox", { name: /^Type(?:\s|$)/u });
        await typeFilter.waitFor({ timeout: 30_000 });
        if (libraryKind) {
          await typeFilter.selectOption(libraryKind);
          await page.waitForURL((url) => url.pathname === "/library" && url.searchParams.get("type") === libraryKind);
        } else {
          await page.getByText("Nothing to review yet", { exact: true }).waitFor({ timeout: 30_000 });
        }
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#approval-mode"), { waitUntil: "domcontentloaded" });
        // Leaving Safety for the tools link ends on the Tools tab in Capabilities, which the draft proof waits for.
        const draftNavigation = await proveCatalogDraftNavigation({ page, readGrants: async () => {
          const response = await requestJson(stack.gatewayUrl, "/api/v1/tools/grants?limit=400");
          assertOk(response, "navigation tool-grant owner"); return response.body;
        } });
        await page.getByRole("heading", { name: "All tools", exact: true }).waitFor({ timeout: 30_000 });
        return { status: "passed", metrics: { capabilityId: item.capabilityId, libraryKind: libraryKind ?? "none", blockingAxe: 0, overflow, draftNavigation },
          artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } finally { await browserContext.close(); }
    });
  }
}
