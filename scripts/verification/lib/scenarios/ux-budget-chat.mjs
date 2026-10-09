import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateChatBudget, evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";
import { seedVisibleChatArtifact } from "./chat-artifact-fixture.mjs";

export async function runUxBudgetChat(environment) {
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
        id: `ux-budgets.cockpit-chat-space.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Chat space ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(
            buildVerificationUiUrl(
              stack.uiUrl,
              `/chat?sessionId=${encodeURIComponent(fixture.sessionId)}&shell=cockpit`,
            ),
            { waitUntil: "domcontentloaded" },
          );
          await page.waitForSelector('[aria-label="Messages"]', { timeout: 30_000 });
          const layout = await page.evaluate(() => ({
            viewportHeight: window.innerHeight,
            scrollerHeight: document.querySelector('[aria-label="Messages"]')?.clientHeight ?? 0,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          const chat = evaluateChatBudget(layout, variant);
          const overflow = evaluateHorizontalOverflow(layout);
          if (!chat.pass || !overflow.pass)
            throw new Error(
              `Cockpit Chat ${variant}: message area ${chat.ratio} (minimum ${chat.threshold}), horizontal overflow ${overflow.overflow}px`,
            );
          await page.getByRole("button", { name: "Build editor" }).click();
          await page.getByRole("heading", { name: "Build editor" }).waitFor({ timeout: 30_000 });
          if (variant === "mobile") await page.getByRole("button", { name: "Browse files" }).click();
          await page.getByText("Choose a code source").waitFor();
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const editorOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !editorOverflow.pass) {
            throw new Error(
              `Cockpit build editor ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${editorOverflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-build-editor-${variant}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          await page.getByRole("button", { name: "Back to conversation" }).click();
          await page.locator('[aria-label="Messages"]').waitFor();
          const threadPath = `/api/v1/chat/sessions/${encodeURIComponent(fixture.sessionId)}/thread`;
          const beforeCommands = await requestJson(stack.gatewayUrl, threadPath);
          assertOk(beforeCommands, `read ${variant} Chat before local commands`);
          const originalTurnIds = beforeCommands.body?.turns?.map((turn) => turn.turnId);
          if (!Array.isArray(originalTurnIds)) throw new Error("Chat command proof has no canonical thread turn list.");
          await page.getByRole("combobox", { name: "Message", exact: true }).fill("/status");
          await page.getByRole("button", { name: "Show status" }).click();
          const statusPanel = page.getByRole("region", { name: "Chat session status" });
          await statusPanel.waitFor();
          const statusOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          const statusAxe = await auditPageAccessibility(page);
          if (
            !statusOverflow.pass ||
            statusAxe.violations.some((violation) => ["serious", "critical"].includes(violation.impact))
          ) {
            throw new Error(`Cockpit /status ${variant}: inaccessible or horizontally overflowing`);
          }
          const statusShot = path.join(screenshotDir, `ux-budgets-cockpit-status-${variant}.png`);
          await page.screenshot({ path: statusShot, fullPage: false });
          await statusPanel.getByRole("button", { name: "Close session status" }).click();
          await page.getByRole("combobox", { name: "Message", exact: true }).fill("/timer");
          await page.getByRole("button", { name: "Open timer" }).click();
          const timerDialog = page.getByRole("dialog", { name: "Set a Chat timer" });
          await timerDialog.waitFor();
          const timerBounds = await timerDialog.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              left: bounds.left,
              right: bounds.right,
              top: bounds.top,
              bottom: bounds.bottom,
              centerX: bounds.left + bounds.width / 2,
              centerY: bounds.top + bounds.height / 2,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            };
          });
          if (
            timerBounds.left < -1 ||
            timerBounds.right > timerBounds.viewportWidth + 1 ||
            timerBounds.top < -1 ||
            timerBounds.bottom > timerBounds.viewportHeight + 1 ||
            Math.abs(timerBounds.centerX - timerBounds.viewportWidth / 2) > 8 ||
            Math.abs(timerBounds.centerY - timerBounds.viewportHeight / 2) > 8
          ) {
            throw new Error(
              `Cockpit /timer ${variant}: dialog outside viewport or off center: ${JSON.stringify(timerBounds)}`,
            );
          }
          const timerOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          const timerAxe = await auditPageAccessibility(page);
          if (
            !timerOverflow.pass ||
            timerAxe.violations.some((violation) => ["serious", "critical"].includes(violation.impact))
          ) {
            throw new Error(`Cockpit /timer ${variant}: inaccessible or horizontally overflowing`);
          }
          const timerShot = path.join(screenshotDir, `ux-budgets-cockpit-timer-${variant}.png`);
          await page.screenshot({ path: timerShot, fullPage: false });
          await timerDialog.getByRole("button", { name: "Close", exact: true }).last().click();
          const afterCommands = await requestJson(stack.gatewayUrl, threadPath);
          assertOk(afterCommands, `read ${variant} Chat after local commands`);
          if (
            JSON.stringify(afterCommands.body?.turns?.map((turn) => turn.turnId)) !== JSON.stringify(originalTurnIds)
          ) {
            throw new Error(`Cockpit Chat ${variant}: local commands sent a model turn`);
          }
          await page.getByRole("combobox", { name: "Message", exact: true }).fill("/schedule");
          await page.getByRole("button", { name: "Open schedules" }).click();
          await page.getByRole("heading", { name: "Schedules" }).waitFor();
          if (!new URL(page.url()).pathname.endsWith("/work/schedules")) {
            throw new Error(`Cockpit Chat ${variant}: /schedule did not open Work schedules`);
          }
          return {
            status: "passed",
            metrics: {
              ratio: chat.ratio,
              threshold: chat.threshold,
              overflow: editorOverflow.overflow,
              blockingAxe: 0,
            },
            artifacts: emptyArtifacts({
              screenshots: [screenshot, statusShot, timerShot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }

  let chatArtifactFixture;
  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-chat-artifact.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Chat saved artifact ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        chatArtifactFixture ??= await seedVisibleChatArtifact(stack.gatewayUrl, { requestJson, assertOk });
        const { workspaceId, sessionId, artifact, turn } = chatArtifactFixture;
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(
            buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(sessionId)}&shell=cockpit`),
            { waitUntil: "domcontentloaded" },
          );
          const messages = page.locator('[aria-label="Messages"]');
          await messages.waitFor({ timeout: 30_000 });
          const scroller = messages.locator('[data-testid="virtuoso-scroller"]');
          await scroller.waitFor();
          const artifactCard = messages
            .locator('[aria-label="Saved artifacts"]')
            .getByRole("button", { name: artifact.title, exact: true });
          for (let scan = 0; scan < 30 && (await artifactCard.count()) === 0; scan += 1) {
            await scroller.evaluate((element, first) => {
              element.scrollTop = first
                ? element.scrollHeight
                : Math.max(0, element.scrollTop - element.clientHeight * 0.8);
              element.dispatchEvent(new element.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
            }, scan === 0);
            await page.waitForTimeout(100);
          }
          await artifactCard.waitFor({ timeout: 5_000 });
          await artifactCard.click();
          const inspector = page.locator('[aria-label="Inspector: Conversation"]');
          await inspector.waitFor();
          const filesTab = inspector.getByRole("tab", { name: "Files" });
          await filesTab.waitFor();
          if ((await filesTab.getAttribute("aria-selected")) !== "true")
            throw new Error("Saved artifact did not open the Chat Files inspector.");
          const selectedArtifact = inspector.getByRole("region", { name: "Selected artifact" });
          await selectedArtifact.getByRole("heading", { name: artifact.title }).first().waitFor();
          await selectedArtifact
            .locator(".generated-artifact-code-block")
            .getByText(artifact.content, { exact: true })
            .waitFor();
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Chat artifact ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-chat-artifact-${variant}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          await inspector.getByRole("tab", { name: "Context" }).click();
          const recorded = inspector.getByRole("region", { name: "Recorded turn context" });
          await recorded.getByText("Memory mode").waitFor();
          await inspector.getByRole("region", { name: "Current context selection" }).waitFor();
          if (
            !turn.trace?.memoryMode ||
            !(await recorded.textContent())?.toLowerCase().includes(turn.trace.memoryMode)
          ) {
            throw new Error(`Chat artifact ${variant}: recorded memory mode does not match the selected Gateway turn.`);
          }
          const contextAxe = await auditPageAccessibility(page);
          const contextBlockingAxe = contextAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const contextOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (contextBlockingAxe.length || !contextOverflow.pass) {
            throw new Error(
              `Chat context ${variant}: accessibility ${contextBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${contextOverflow.overflow}px`,
            );
          }
          const contextScreenshot = path.join(screenshotDir, `ux-budgets-cockpit-chat-context-${variant}.png`);
          await page.screenshot({ path: contextScreenshot, fullPage: false });
          return {
            status: "passed",
            metrics: {
              blockingAxe: 0,
              overflow: Math.max(overflow.overflow, contextOverflow.overflow),
              artifactId: artifact.artifactId,
            },
            artifacts: emptyArtifacts({
              screenshots: [screenshot, contextScreenshot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
