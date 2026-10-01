import { TOAST_SETTLE_MS } from "./ux-budget-measurements.mjs";

export function createUxBudgetBrowserFixtures({ browser, stack, fixture, deps }) {
  const {
    NEXT_UI_PACKAGE,
    assertOk,
    buildVerificationUiUrl,
    installMissionControlNextBrowserState,
    path,
    requestJson,
    waitForVerificationRouteReady,
  } = deps;
  async function openRoute(viewport, entry, href) {
    const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
    try {
      await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
      const page = await browserContext.newPage();
      await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, entry, NEXT_UI_PACKAGE);
      await page.waitForTimeout(TOAST_SETTLE_MS);
      return { browserContext, page };
    } catch (error) {
      await browserContext.close();
      throw error;
    }
  }

  async function seedInboxQuestion(variant) {
    const session = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
      method: "POST",
      body: { workspaceId: fixture.workspaceId, title: `Inbox question ${variant}`, mode: "chat" },
    });
    assertOk(session, `create ${variant} Inbox question session`);
    const sessionId = session.body?.sessionId;
    if (!sessionId) throw new Error("Seeded Inbox question has no canonical session ID.");
    const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/chat-user-input-scenario", {
      method: "POST",
      body: { sessionId, workspaceId: fixture.workspaceId },
    });
    assertOk(seeded, `seed ${variant} Inbox question`);
    if (!seeded.body?.promptId || !seeded.body?.turnId) {
      throw new Error("Seeded Inbox question has no canonical prompt and turn IDs.");
    }
    return { sessionId, promptId: seeded.body.promptId, turnId: seeded.body.turnId };
  }

  async function seedCompletedBackgroundUpdate(variant) {
    const childSession = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
      method: "POST",
      body: { workspaceId: fixture.workspaceId, title: `Background update ${variant}`, mode: "chat" },
    });
    assertOk(childSession, `create ${variant} background child session`);
    const childSessionId = childSession.body?.sessionId;
    if (!childSessionId) throw new Error("Seeded background child has no canonical session ID.");
    const { Storage } = await import(new URL("../../../../packages/storage/dist/index.js", import.meta.url));
    const storage = new Storage({
      dbPath: path.join(stack.runtimeRoot, "data", "index.db"),
      transcriptsDir: path.join(stack.runtimeRoot, "data", "transcripts"),
      auditDir: path.join(stack.runtimeRoot, "data", "audit"),
    });
    const parentRunId = `ux-background-parent-${variant}`;
    const childRunId = `ux-background-child-${variant}`;
    const orphanRunId = `ux-background-orphan-${variant}`;
    const watcherId = `ux-background-watcher-${variant}`;
    const orphanWatcherId = `ux-background-orphan-watcher-${variant}`;
    const delegationRunId = `ux-background-delegation-${variant}`;
    const stepId = `ux-background-step-${variant}`;
    const childTurnId = `ux-background-turn-${variant}`;
    const now = new Date().toISOString();
    try {
      if (
        storage.chatSessionMeta.get(fixture.sessionId)?.workspaceId !== fixture.workspaceId ||
        storage.chatSessionMeta.get(childSessionId)?.workspaceId !== fixture.workspaceId
      ) {
        throw new Error("Seeded background sessions are not in the verification workspace.");
      }
      storage.durableRuns.createRun({
        runId: parentRunId,
        workflowKey: "chat.turn.execute",
        status: "completed",
        payload: {
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          turnId: `ux-background-parent-turn-${variant}`,
        },
        finishedAt: now,
        now,
      });
      for (const [runId, turnId] of [
        [childRunId, childTurnId],
        [orphanRunId, `ux-background-orphan-turn-${variant}`],
      ]) {
        storage.durableRuns.createRun({
          runId,
          workflowKey: "chat.turn.execute",
          status: "completed",
          payload: { workspaceId: fixture.workspaceId, sessionId: childSessionId, turnId },
          finishedAt: now,
          now,
        });
      }
      storage.chatDelegationRuns.create({
        runId: delegationRunId,
        parentRunId,
        sessionId: fixture.sessionId,
        taskId: `ux-background-task-${variant}`,
        objective: "Verify a background update",
        roles: ["Coder"],
        mode: "sequential",
        status: "completed",
        startedAt: now,
        finishedAt: now,
      });
      storage.chatDelegationSteps.create({
        stepId,
        runId: delegationRunId,
        role: "Coder",
        index: 0,
        status: "completed",
        durableRunId: childRunId,
        childSessionId,
        childTurnId,
        startedAt: now,
        finishedAt: now,
      });
      storage.durableChildWatchers.create({
        watcherId,
        parentRunId,
        childRunId,
        source: "chat_delegation",
        metadata: { delegationRunId, stepId, childSessionId, childTurnId },
      });
      storage.durableChildWatchers.create({
        watcherId: orphanWatcherId,
        parentRunId,
        childRunId: orphanRunId,
        source: "chat_delegation",
        metadata: {
          delegationRunId: `missing-${variant}`,
          stepId: `missing-${variant}`,
          childSessionId,
          childTurnId: `ux-background-orphan-turn-${variant}`,
        },
      });
    } finally {
      storage.close();
    }
    return { childRunId, watcherId, orphanRunId, orphanWatcherId };
  }
  return { openRoute, seedInboxQuestion, seedCompletedBackgroundUpdate };
}
