import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";

export async function runUxBudgetInboxProposals(environment) {
  const { context, browser, stack, fixture, deps } = environment;
  const {
    assertOk,
    auditPageAccessibility,
    axeSourcePath,
    buildVerificationUiUrl,
    emptyArtifacts,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    requestJson,
    runScenario,
  } = deps;
  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-inbox-capability-proposal.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox capability proposal ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const title = `Review ${variant} capability fixture`;
        const created = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/proposals", {
          method: "POST",
          body: {
            proposalKind: "skill",
            title,
            summary: "A proposed verification skill",
            payload: { workspaceId: fixture.workspaceId },
          },
        });
        assertOk(created, `seed ${variant} capability proposal`);
        const proposalId = created.body?.proposalId;
        if (!proposalId || created.body.status !== "proposed")
          throw new Error("Seeded capability proposal is not proposed.");
        const projected = await requestJson(
          stack.gatewayUrl,
          `/api/v1/inbox?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
        );
        assertOk(projected, `read ${variant} capability Inbox`);
        const item = projected.body?.items?.find((entry) => entry.id === `capability_proposal:${proposalId}`);
        if (item?.source?.workspaceId !== fixture.workspaceId || item.group !== "proposals") {
          throw new Error("Capability proposal is missing from its workspace Inbox.");
        }
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ hasText: title });
          await row.getByRole("button", { name: "Details" }).click();
          const inspector = page.locator(`[aria-label="Inspector: ${title}"]`);
          await inspector.getByText("Decisions for this proposal are unavailable in Inbox", { exact: false }).waitFor();
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Capability proposal ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          const current = await requestJson(
            stack.gatewayUrl,
            `/api/v1/capabilities/proposals/${encodeURIComponent(proposalId)}`,
          );
          assertOk(current, `read ${variant} capability owner`);
          if (current.body?.proposal?.status !== "proposed")
            throw new Error("Viewing a capability proposal changed its owner state.");
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-inbox-capability-proposal-${variant}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow },
            artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }

  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-inbox-memory-review.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox memory review ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const insight = `Remember the ${variant} verification style guide.`;
        const created = await requestJson(stack.gatewayUrl, "/api/v1/memory/trace-candidates", {
          method: "POST",
          body: {
            workspaceId: fixture.workspaceId,
            candidateType: "repo_fact",
            sourceText: `The ${variant} verification fixture uses a project style guide.`,
            proposedInsight: insight,
            confidence: 0.9,
            sourceRefs: [{ sourceType: "manual", sourceRef: `ux-budget-${variant}` }],
          },
        });
        assertOk(created, `seed ${variant} Inbox memory proposal`);
        const candidateId = created.body?.candidateId;
        if (!candidateId) throw new Error("Seeded Inbox memory proposal has no canonical candidate ID.");

        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ hasText: insight });
          await row.getByRole("button", { name: "Details" }).click();
          const review = page.getByRole("region", { name: "Current memory proposal" });
          await review.getByText(`Proposed insight: ${insight}`).waitFor();
          await page.waitForFunction(() => {
            const rect = document.querySelector('[aria-label="Current memory proposal"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.top < window.innerHeight - 100 && rect.bottom > 100);
          });
          await page.waitForTimeout(250);
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const reviewShot = path.join(screenshotDir, `ux-budgets-inbox-memory-review-${variant}.png`);
          const confirmShot = path.join(screenshotDir, `ux-budgets-inbox-memory-confirm-${variant}.png`);
          await page.screenshot({ path: reviewShot, fullPage: false });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Inbox memory review ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          await review.getByRole("button", { name: "Reject proposal" }).click();
          await page.getByRole("button", { name: "Confirm rejection" }).waitFor();
          await page.screenshot({ path: confirmShot, fullPage: false });
          const pending = await requestJson(
            stack.gatewayUrl,
            `/api/v1/memory/trace-candidates?workspaceId=${encodeURIComponent(fixture.workspaceId)}&status=proposed&limit=500`,
          );
          assertOk(pending, `read ${variant} pending Inbox memory proposal`);
          if (!pending.body?.items?.some((candidate) => candidate.candidateId === candidateId)) {
            throw new Error("Opening the Inbox confirmation changed the canonical proposal.");
          }
          await page.getByRole("button", { name: "Confirm rejection" }).click();
          await page.getByText("Gateway rejected the proposal.", { exact: false }).waitFor();
          const resolved = await requestJson(
            stack.gatewayUrl,
            `/api/v1/memory/trace-candidates?workspaceId=${encodeURIComponent(fixture.workspaceId)}&status=all&limit=500`,
          );
          assertOk(resolved, `read ${variant} resolved Inbox memory proposal`);
          if (resolved.body?.items?.find((candidate) => candidate.candidateId === candidateId)?.status !== "rejected") {
            throw new Error("The canonical memory proposal did not record rejection.");
          }
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow, canonicalStatus: "rejected" },
            artifacts: emptyArtifacts({
              screenshots: [reviewShot, confirmShot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
