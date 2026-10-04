import { mkdir } from "node:fs/promises";
import { clickTurnAction } from "./cockpit-turn-actions.mjs";

/** Exercise a branch edit against a disposable Gateway Chat turn in both cockpit layouts. */
export async function runCockpitChatBranchProof({ context, browser, stack, citadelId, viewports, deps }) {
  const {
    assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl,
    emptyArtifacts, installMissionControlNextBrowserState, path, relativeToRun,
    requestJson, runScenario,
  } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context,
      { id: `ux-budgets.cockpit-chat-branch.${variant}`, lane: "ux-budgets",
        title: `Cockpit Chat branch edit ${variant}`, subsystem: "mission-control-ux" },
      async () => {
        const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST", body: { workspaceName: `Branch proof ${variant}`,
            sessionTitle: `Branch proof ${variant}`, sessionCount: 1, longThreadTurns: 2 },
        });
        assertOk(seed, `seed ${variant} branch conversation`);
        const { workspaceId, sessionId } = seed.body ?? {};
        if (!workspaceId || !sessionId) throw new Error("Branch proof has no canonical workspace and conversation.");
        const threadPath = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`;
        const initial = await requestJson(stack.gatewayUrl, threadPath);
        assertOk(initial, `read ${variant} branch source`);
        const turns = initial.body?.turns;
        const source = turns?.findLast((turn) => turn.branch?.isSelectedPath && turn.assistantMessage);
        if (!source) throw new Error("Branch proof has no completed selected turn.");
        const originalIds = turns.map((turn) => turn.turnId);
        const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(sessionId)}&shell=cockpit`), { waitUntil: "domcontentloaded" });
          const messages = page.locator('[aria-label="Messages"]');
          await messages.waitFor({ timeout: 30_000 });
          const scroller = messages.locator('[data-testid="virtuoso-scroller"]');
          await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new element.ownerDocument.defaultView.Event("scroll", { bubbles: true })); });
          await clickTurnAction(messages, "Edit and resend", { timeout: 10_000 });
          await page.getByRole("status").getByText("Editing a new branch from this turn.").waitFor();
          const revised = `Branch proof ${variant} revised message.`;
          await page.getByRole("textbox", { name: "Message" }).fill(revised);
          const send = page.getByRole("button", { name: "Send branch" });
          await send.waitFor();
          for (let attempt = 0; attempt < 40 && !(await send.isEnabled()); attempt += 1) {
            await page.waitForTimeout(250);
          }
          if (!(await send.isEnabled())) {
            const reasons = await page.locator('form [role="status"]').allTextContents();
            throw new Error(`Branch send is unavailable after a valid edit: ${reasons.join(" | ")}`);
          }
          const before = await requestJson(stack.gatewayUrl, threadPath);
          assertOk(before, `read ${variant} branch before send`);
          if (JSON.stringify(before.body?.turns?.map((turn) => turn.turnId)) !== JSON.stringify(originalIds)) {
            throw new Error("Starting a branch edit mutated the canonical Chat thread before send.");
          }
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (blocking.length || overflow > 1) throw new Error(`Branch edit ${variant}: accessibility ${blocking.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow}px`);
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-chat-branch-${variant}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          await send.click();
          let completed;
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const current = await requestJson(stack.gatewayUrl, threadPath);
            assertOk(current, `read ${variant} branch outcome`);
            completed = current.body?.turns?.find((turn) => turn.userMessage?.content === revised
              && turn.branch?.isSelectedPath && turn.assistantMessage?.content?.includes("UX_BUDGET_OK"));
            if (completed) break;
            await page.waitForTimeout(250);
          }
          if (!completed) throw new Error("Branch edit did not produce a completed, selected Gateway turn.");
          if (completed.turnId === source.turnId || !originalIds.every((id) => id !== completed.turnId)) {
            throw new Error("Branch edit reused an existing turn identity.");
          }
          return { status: "passed", metrics: { blockingAxe: 0, overflow, branchTurnId: completed.turnId },
            artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
        } finally {
          await browserContext.close();
        }
      });
  }
}
