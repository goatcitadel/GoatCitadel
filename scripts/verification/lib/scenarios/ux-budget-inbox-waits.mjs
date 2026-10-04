import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";

export async function runUxBudgetInboxWaits(environment) {
  const { context, browser, stack, fixture, seedInboxQuestion, seedCompletedBackgroundUpdate, deps } = environment;
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
        id: `ux-budgets.cockpit-inbox-question.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox question ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const seeded = await seedInboxQuestion(variant);
        const inboxUrl = `/api/v1/inbox?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
        const projected = await requestJson(stack.gatewayUrl, inboxUrl);
        assertOk(projected, `read ${variant} Inbox question`);
        const item = projected.body?.items?.find((entry) => entry.id === `user_input:${seeded.promptId}`);
        if (
          !item ||
          item.source?.sessionId !== seeded.sessionId ||
          item.source?.turnId !== seeded.turnId ||
          item.source?.promptId !== seeded.promptId
        ) {
          throw new Error("Inbox question did not preserve its exact Chat owner IDs.");
        }
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ has: page.locator(`a[href="${item.href}"]`) });
          await row.getByRole("button", { name: "Details" }).click();
          const review = page.getByRole("region", { name: "Current Chat question" });
          await review.getByText("Which path should the verification run take from here?").waitFor();
          await page.waitForFunction(() => {
            const rect = document.querySelector('[aria-label="Current Chat question"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.top < window.innerHeight - 100 && rect.bottom > 100);
          });
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const reviewShot = path.join(screenshotDir, `ux-budgets-inbox-question-review-${variant}.png`);
          const confirmShot = path.join(screenshotDir, `ux-budgets-inbox-question-confirm-${variant}.png`);
          await page.waitForTimeout(250);
          await page.screenshot({ path: reviewShot, fullPage: false });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Inbox question ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          await review.getByRole("radio", { name: /Continue with the current plan/ }).check();
          await review.getByRole("button", { name: "Review answer" }).click();
          await page.getByRole("dialog", { name: "Submit this answer" }).waitFor();
          await page.screenshot({ path: confirmShot, fullPage: false });
          const before = await requestJson(
            stack.gatewayUrl,
            `/api/v1/chat/sessions/${encodeURIComponent(seeded.sessionId)}/thread`,
          );
          assertOk(before, `read ${variant} unanswered Chat question`);
          const waiting = before.body?.turns?.find((turn) => turn.turnId === seeded.turnId)?.trace;
          if (waiting?.status !== "waiting_for_user_input" || waiting.pendingUserInput?.promptId !== seeded.promptId) {
            throw new Error("Reviewing the Inbox answer changed the canonical Chat wait.");
          }
          await page.getByRole("button", { name: "Confirm answer" }).click();
          await review.getByText("Gateway accepted the answer", { exact: false }).waitFor();
          const after = await requestJson(stack.gatewayUrl, inboxUrl);
          assertOk(after, `read ${variant} answered Inbox question`);
          if (after.body?.items?.some((entry) => entry.id === item.id)) {
            throw new Error("Answered Chat question remained in the current Inbox projection.");
          }
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow },
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

  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-inbox-background-update.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox background update ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const seeded = await seedCompletedBackgroundUpdate(variant);
        const response = await requestJson(
          stack.gatewayUrl,
          `/api/v1/inbox?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
        );
        assertOk(response, `read ${variant} Inbox background update`);
        const item = response.body?.items?.find((entry) => entry.id === `completed_background_run:${seeded.watcherId}`);
        if (
          !item ||
          item.source?.runId !== seeded.childRunId ||
          item.group !== "updates" ||
          response.body.items.some((entry) => entry.id === `completed_background_run:${seeded.orphanWatcherId}`)
        ) {
          throw new Error("Inbox did not project only the verified completed background run.");
        }
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ has: page.locator(`a[href="${item.href}"]`) });
          await row.getByText("Background run completed").waitFor();
          await row.getByRole("button", { name: "Details" }).click();
          const inspector = page.locator('[aria-label="Inspector: Background run completed"]');
          await inspector.getByText("read-only summary", { exact: false }).waitFor();
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Inbox background update ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-inbox-background-update-${variant}.png`);
          await page.waitForTimeout(250);
          await page.screenshot({ path: screenshot, fullPage: false });
          if (await page.locator(`li[data-inbox-item] a[href*="${seeded.orphanRunId}"]`).count()) {
            throw new Error("Forged background watcher appeared in the Inbox.");
          }
          await inspector.getByRole("link", { name: "Open in classic Ops" }).click();
          await page.waitForURL(
            (url) =>
              url.pathname === "/ops/runtime" &&
              url.searchParams.get("runId") === seeded.childRunId &&
              url.searchParams.get("shell") === "classic",
          );
          await page.getByRole("heading", { name: `Run ${seeded.childRunId}` }).waitFor();
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow, runId: seeded.childRunId },
            artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
