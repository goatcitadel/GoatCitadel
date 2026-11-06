import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

export function assertNativeInboxOwner(item, href, workspaceId) {
  assert.equal(item.source.workspaceId, workspaceId, "Inbox owner projection crossed the selected workspace.");
  assert.ok(typeof href === "string" && href.startsWith("/") && !href.startsWith("//"), "Inbox owner link must remain local.");
  const destination = new URL(href, "http://verification.invalid");
  assert.equal(destination.origin, "http://verification.invalid", "Inbox owner link must not change origin.");
  assert.equal(destination.searchParams.get("workspaceId"), workspaceId, "Inbox owner link lost its workspace.");
  assert.equal(destination.searchParams.get("shell"), "cockpit", "Inbox owner link must open the native owner.");
  if (item.kind === "user_input") {
    assert.equal(destination.pathname, "/inbox");
    assert.equal(destination.searchParams.get("item"), item.id, "Inbox question link selected another item.");
  } else {
    assert.equal(item.kind, "completed_background_run");
    assert.equal(destination.pathname, `/work/runs/${encodeURIComponent(item.source.runId)}`);
  }
  for (const key of ["sessionId", "turnId", "runId", "taskId"]) {
    if (item.source[key] !== undefined) assert.equal(destination.searchParams.get(key), item.source[key], `Inbox owner link lost ${key}.`);
  }
  return destination;
}

export function assertCompletedBackgroundOwner(trace, runId, workspaceId) {
  assert.equal(trace?.runId, runId, "Run trace belongs to another requested run.");
  assert.equal(trace?.run?.runId, runId, "Run trace substituted its canonical owner.");
  assert.equal(trace?.run?.payload?.workspaceId, workspaceId, "Run trace crossed the selected workspace.");
  assert.equal(trace?.run?.status, "completed", "Background owner is no longer completed.");
}

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
          const row = page.locator(`li[data-inbox-row=${JSON.stringify(item.id)}]`);
          await row.waitFor();
          assert.equal(await row.count(), 1, "Inbox question must select exactly its canonical row.");
          assertNativeInboxOwner(item, await row.getByRole("link", { name: "Open in Inbox", exact: true }).getAttribute("href"), fixture.workspaceId);
          await row.getByRole("button", { name: "Details", exact: true }).click();
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
          await review.getByRole("button", { name: "Send answer" }).waitFor();
          await page.screenshot({ path: confirmShot, fullPage: false });
          const before = await requestJson(
            stack.gatewayUrl,
            `/api/v1/chat/sessions/${encodeURIComponent(seeded.sessionId)}/thread`,
          );
          assertOk(before, `read ${variant} unanswered Chat question`);
          const waiting = before.body?.turns?.find((turn) => turn.turnId === seeded.turnId)?.trace;
          if (waiting?.status !== "waiting_for_user_input" || waiting.pendingUserInput?.promptId !== seeded.promptId) {
            throw new Error("Choosing the Inbox answer changed the canonical Chat wait.");
          }
          await review.getByRole("button", { name: "Send answer" }).click();
          await review.getByText("Answer sent", { exact: false }).waitFor();
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
          const row = page.locator(`li[data-inbox-row=${JSON.stringify(item.id)}]`);
          await row.waitFor();
          assert.equal(await row.count(), 1, "Background update must select exactly its canonical row.");
          assertNativeInboxOwner(item, await row.getByRole("link", { name: "Open in Work", exact: true }).getAttribute("href"), fixture.workspaceId);
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
          assert.equal(await page.locator(`li[data-inbox-row=${JSON.stringify(`completed_background_run:${seeded.orphanWatcherId}`)}]`).count(), 0,
            "Forged background watcher must not have a canonical Inbox row.");
          const nativeOwner = inspector.getByRole("link", { name: "Open in Work", exact: true });
          assertNativeInboxOwner(item, await nativeOwner.getAttribute("href"), fixture.workspaceId);
          const tracePath = `/api/v1/observe/runs/${encodeURIComponent(seeded.childRunId)}/trace`;
          const ownerResponse = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === tracePath);
          await nativeOwner.click();
          await page.waitForURL(
            (url) =>
              url.pathname === `/work/runs/${encodeURIComponent(seeded.childRunId)}` &&
              url.searchParams.get("runId") === seeded.childRunId &&
              url.searchParams.get("workspaceId") === fixture.workspaceId &&
              url.searchParams.get("shell") === "cockpit",
          );
          const traceResponse = await ownerResponse;
          assert.equal(traceResponse.status(), 200, "Native Work must read the exact canonical run successfully.");
          assertCompletedBackgroundOwner(await traceResponse.json(), seeded.childRunId, fixture.workspaceId);
          await page.getByRole("heading", { name: "Chat turn", exact: true }).waitFor();
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow, runId: seeded.childRunId,
              ownerSurface: "native_work", classicContinuity: "not_exercised" },
            artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
