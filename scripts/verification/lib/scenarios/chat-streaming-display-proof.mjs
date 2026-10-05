import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

/** SF6 uses production Chat, durable Gateway execution and a controllable loopback provider. */
export async function runChatStreamingDisplayProof(context, deps) {
  const {
    chromium,
    startDeterministicLlmStub,
    startVerificationStack,
    stopVerificationStack,
    ensureOnboardingComplete,
    requestJson,
    installMissionControlNextBrowserState,
    waitForVerificationRouteReady,
    runScenario,
    attachBrowserLogging,
    captureBrowserArtifacts,
    assertBrowserConsoleHealthy,
    auditPageAccessibility,
    axeSourcePath,
    NEXT_UI_PACKAGE,
  } = deps;
  let stub, stack, runtimeRoot, browser;
  try {
    stub = await startDeterministicLlmStub({ replyText: "DISPLAY_DEFAULT", dispatchPlanStreamOnly: true });
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-stream-display`, stub.baseUrl);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      gatewayMode: "built",
      uiMode: "preview",
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "verification-display-operator-token",
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: "verification-stub-key",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "sf6-display-fixture");
    const api = async (route, init) => {
      const response = await requestJson(stack.gatewayUrl, route, init);
      assert.ok(response.ok, `${route}: ${response.status}`);
      return response.body;
    };
    browser = await chromium.launch({ headless: true });
    for (const [variant, viewport] of [
      ["desktop", { width: 1440, height: 1024 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      await runScenario(
        context,
        {
          id: `SF6-SD4.chat.${variant}`,
          lane: "usability",
          subsystem: "mission-control",
          title: `Streaming Markdown and activity in default Cockpit ${variant}`,
        },
        async () => {
          const session = await api("/api/v1/chat/sessions", {
            method: "POST",
            body: { title: `SF6 display ${variant}` },
          });
          const other = await api("/api/v1/chat/sessions", { method: "POST", body: { title: `SF6 other ${variant}` } });
          const route = `/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}`;
          const prefs = await api(`${route}/prefs`);
          await api(`${route}/prefs`, {
            method: "PATCH",
            body: {
              expectedRevision: prefs.revision,
              providerId: stub.providerId,
              model: stub.model,
              memoryMode: "off",
              webMode: "off",
              subagentPolicy: "off",
              orchestrationEnabled: false,
              thinkingLevel: "off",
            },
          });
          await api("/api/v1/tools/grants", {
            method: "POST",
            body: {
              toolPattern: "session.status",
              decision: "allow",
              scope: "session",
              scopeRef: session.sessionId,
              grantType: "ttl",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          });
          const browserContext = await browser.newContext({
            viewport,
            reducedMotion: variant === "mobile" ? "reduce" : "no-preference",
          });
          await installMissionControlNextBrowserState(browserContext, session.workspaceId, session.citadelId);
          const page = await browserContext.newPage(),
            log = attachBrowserLogging(page);
          const captures = {};
          const capture = async (suffix) => {
            const result = await captureBrowserArtifacts(context, {
              slug: `sf6-${variant}-${suffix}`,
              page,
              browserLog: log,
              gatewayUrl: stack.gatewayUrl,
            });
            for (const [key, paths] of Object.entries(result)) captures[key] = [...(captures[key] ?? []), ...paths];
          };
          const navigate = async (id) => {
            await page.goto(`${stack.uiUrl}/chat?sessionId=${encodeURIComponent(id)}`, {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(
              page,
              { href: "/chat", readySelector: 'section[aria-label="Chat"] [aria-label="Messages"]' },
              NEXT_UI_PACKAGE,
            );
          };
          const thread = () => api(`${route}/thread`);
          const waitForTurnStatus = async (userContent, status) => {
            const deadline = Date.now() + 30_000;
            let observed; // Always assigned before the loop can exit (js/useless-assignment-to-local).
            do {
              const turn = (await thread()).turns.find(
                (record) => record.branch.isSelectedPath && record.userMessage.content === userContent,
              );
              observed = turn?.trace.status ?? "missing";
              if (observed === status) return turn;
              await delay(100);
            } while (Date.now() < deadline);
            throw new Error(`Canonical ${userContent} status expected ${status}, observed ${observed}`);
          };
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          const send = page.getByRole("button", { name: "Send", exact: true });
          const messages = page.getByLabel("Messages", { exact: true });
          const scroller = messages.locator('[data-virtuoso-scroller="true"]');
          const returnToLatest = async () => {
            const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
            if (await jump.count()) await jump.click();
            await scroller.evaluate((node) => {
              node.scrollTop = node.scrollHeight;
            });
            await page.waitForFunction(() => {
              const node = document.querySelector('[aria-label="Messages"] [data-virtuoso-scroller="true"]');
              return node && node.scrollHeight - node.scrollTop - node.clientHeight < 5;
            });
            await jump.waitFor({ state: "hidden" });
          };
          const answerHeading = () => messages.getByRole("heading", { name: `SF6 display ${variant}`, exact: true });
          const assertLayout = async () => {
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
              false,
              "No horizontal page overflow",
            );
            assert.ok(await composer.isVisible(), "Composer remains usable");
          };
          try {
            await navigate(session.sessionId);
            const chunks = [
              `# SF6 display ${variant}\n\n` +
                Array.from(
                  { length: 20 },
                  (_, i) => `Paragraph ${i}: retained **prose** with a bounded amount of readable text.\n\n`,
                ).join(""),
              "| Name | Value |\n| --- | --- |\n| Row one | Short |\n",
              "| Row two | A much wider value with an escaped \\| pipe |\n\n",
              "```ts\n" + "const value = 1;\n".repeat(100),
              "const finalValue = 2;\n```\n\n",
              "> Quote one\n>\n> Quote two\n\n- First\n\n- Second\n\nSee [the spec][spec].\n\n",
              "[spec]: https://example.com/spec\n\n" + "x".repeat(1024) + "\n\nSF6 exact final answer.",
            ];
            stub.replaceDispatchPlan([
              { type: "tool_call", name: "session_status", arguments: {} },
              { type: "stream_controlled", chunks },
            ]);
            const prompt =
              "SF6_DISPLAY: Check session.status once, then provide the formatted display fixture without any other tools.";
            let releaseAdmission;
            const admission = new Promise((resolve) => {
              releaseAdmission = resolve;
            });
            const pendingAdmission = new Set();
            const gateAdmission = (request) => {
              const work = admission.then(() => request.continue());
              pendingAdmission.add(work);
              return work.finally(() => pendingAdmission.delete(work));
            };
            await page.route("**/agent-send/stream", gateAdmission);
            try {
              await composer.fill(prompt);
              await send.click();
              await page.evaluate(() => new Promise(window.requestAnimationFrame));
              assert.equal(
                await messages.getByText(prompt, { exact: false }).count(),
                1,
                "One optimistic user message while admission is held",
              );
              assert.match(await messages.textContent(), /Sending/);
            } finally {
              releaseAdmission();
              await Promise.all([...pendingAdmission]);
              await page.unroute("**/agent-send/stream", gateAdmission);
            }
            await answerHeading().waitFor();
            await page
              .getByText("Paragraph 19: retained prose with a bounded amount of readable text.", { exact: true })
              .waitFor();
            assert.ok(await page.getByRole("button", { name: "Stop response", exact: true }).isEnabled());
            const activity = page.getByLabel("Tool activity for this turn", { exact: true });
            const summary = activity.locator("summary");
            await summary.focus();
            await page.keyboard.press("Enter");
            assert.equal(await activity.evaluate((node) => node.open), true);
            assert.match(await summary.textContent(), /1 done/);
            const proseGap = await messages.evaluate((node) => {
              const paragraphs = [...node.querySelectorAll("p")].filter((paragraph) =>
                /^Paragraph [01]:/u.test(paragraph.textContent),
              );
              return paragraphs[1].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom;
            });
            assert.ok(proseGap >= 8, "Retained paragraphs keep their readable separation");

            await scroller.hover();
            await page.mouse.wheel(0, -100_000);
            // Native scroll events arrive after the gesture. Confirm that the
            // shared reading owner has disengaged before dispatching more text.
            await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
            const readingTop = await scroller.evaluate((node) => node.scrollTop);
            assert.equal(stub.advanceControlledStream(), true);
            await messages.getByRole("cell", { name: "Short", exact: true }).waitFor();
            assert.ok(
              Math.abs((await scroller.evaluate((node) => node.scrollTop)) - readingTop) < 4,
              "Appending a table preserves manual reading position",
            );
            assert.equal(await activity.evaluate((node) => node.open), true);
            assert.equal(await summary.evaluate((node) => node === document.activeElement), true);

            await page.setViewportSize({
              width: variant === "desktop" ? 900 : 360,
              height: variant === "desktop" ? 760 : 640,
            });
            assert.equal(stub.advanceControlledStream(), true);
            await page.getByText("A much wider value with an escaped | pipe", { exact: true }).waitFor();
            await assertLayout();
            await scroller.evaluate((node) => {
              node.scrollTop = node.scrollHeight;
            });
            // Let Virtuoso observe the operator returning to the bottom before
            // the next provider phase changes the measured item height.
            await page.evaluate(
              () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))),
            );
            await page.waitForFunction(() => {
              const node = document.querySelector('[aria-label="Messages"] [data-virtuoso-scroller="true"]');
              return node && node.scrollHeight - node.scrollTop - node.clientHeight < 5;
            });
            await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor({ state: "hidden" });
            assert.equal(stub.advanceControlledStream(), true);
            await page.locator('article[aria-label="Conversation turn"] pre').waitFor();
            await page.waitForFunction(() => {
              const node = document.querySelector('[aria-label="Messages"] [data-virtuoso-scroller="true"]');
              return node && node.scrollHeight - node.scrollTop - node.clientHeight < 5;
            });
            await assertLayout();
            await capture("live-fence");
            assert.equal(stub.advanceControlledStream(), true);
            assert.equal(stub.advanceControlledStream(), true);
            await page.getByText("Quote two", { exact: true }).waitFor();
            await page.evaluate(() => {
              navigator.clipboard.writeText = async (text) => {
                window.__sf6Copied = text;
              };
            });
            await page.getByRole("button", { name: "Copy answer so far", exact: true }).click();
            assert.equal(await page.evaluate(() => window.__sf6Copied), chunks.slice(0, 6).join(""));
            // Reconnect through retained Gateway signals while the provider is
            // still paused. The preview remains a transient projection.
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.getByText("Quote two", { exact: true }).waitFor();
            assert.equal(await answerHeading().count(), 1);
            await page.evaluate(() => {
              navigator.clipboard.writeText = async (text) => {
                window.__sf6Copied = text;
              };
            });
            assert.equal(stub.advanceControlledStream(), true);
            assert.equal(stub.advanceControlledStream(), false);
            await page.getByText("SF6 exact final answer.", { exact: false }).last().waitFor();
            await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden" });
            const completed = (await thread()).turns.at(-1);
            assert.equal(completed.trace.status, "completed");
            assert.equal(completed.assistantMessage.content, chunks.join(""));
            assert.equal(
              await messages
                .getByText("x".repeat(1024), { exact: true })
                .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
              true,
              "Uninterrupted prose wraps within its own paragraph",
            );
            assert.equal(await answerHeading().count(), 1);
            await page.getByRole("button", { name: "Copy answer", exact: true }).click();
            assert.equal(await page.evaluate(() => window.__sf6Copied), chunks.join(""));
            await capture("complete");
            await navigate(other.sessionId);
            await messages.getByText("No messages yet. Write the first message below.", { exact: true }).waitFor();
            assert.equal(await answerHeading().count(), 0);
            await navigate(session.sessionId);
            await answerHeading().waitFor();
            assert.equal(await answerHeading().count(), 1);
            assert.equal(await page.locator('article[aria-label="Conversation turn"] table').count(), 1);
            assert.equal(await page.locator('article[aria-label="Conversation turn"] pre').count(), 1);
            assert.equal(await page.locator(".mc-assistant-streaming-tail").count(), 0);
            await assertLayout();
            await capture("refreshed");
            await page.addScriptTag({ path: axeSourcePath });
            const accessibility = await auditPageAccessibility(page);
            const blockingAccessibility = accessibility.violations.filter(
              ({ impact }) => impact === "critical" || impact === "serious",
            );
            assert.deepEqual(
              blockingAccessibility.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
              [],
              "Default Cockpit has no blocking accessibility violations",
            );

            stub.replaceDispatchPlan([{ type: "success", replyText: "SF6 retry branch answer." }]);
            await page.getByRole("button", { name: "Retry", exact: true }).click();
            await page.getByText("SF6 retry branch answer.", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden" });
            const retryThread = await thread();
            const retryTurn = retryThread.turns.find(
              (turn) => turn.branch.isSelectedPath && turn.turnId !== completed.turnId,
            );
            assert.equal(retryTurn.trace.status, "completed");
            await answerHeading().waitFor({ state: "hidden" });
            const originalBranchIndex = retryTurn.branch.siblingTurnIds.indexOf(completed.turnId);
            assert.ok(originalBranchIndex >= 0);
            await page
              .getByRole("button", { name: `Switch to branch ${originalBranchIndex + 1}`, exact: true })
              .click();
            await answerHeading().waitFor();
            await messages.getByText("SF6 retry branch answer.", { exact: true }).waitFor({ state: "hidden" });
            assert.equal(await messages.locator(".mc-assistant-streaming-tail").count(), 0);
            await returnToLatest();

            stub.replaceDispatchPlan([
              { type: "tool_call", name: "fs_read", arguments: { path: "SF6-missing-fixture.txt" } },
            ]);
            await composer.fill("SF6_FAILURE: Read SF6-missing-fixture.txt with fs.read and explain any failure.");
            await send.click();
            const allowOnce = page.getByRole("button", { name: "Approve once", exact: true });
            await allowOnce.waitFor();
            assert.ok(await allowOnce.isEnabled());
            await allowOnce.click();
            await allowOnce.waitFor({ state: "hidden" });
            await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden" });
            const failure = (await thread()).turns.at(-1);
            assert.equal(failure.toolRuns.at(-1).status, "failed");
            const failedActivity = messages
              .locator('article[aria-label="Conversation turn"]')
              .filter({ hasText: "SF6_FAILURE:" })
              .getByLabel("Tool activity for this turn", { exact: true });
            // The Stop control follows execution state; canonical tool evidence
            // hydrates separately. Require the failed summary before inspecting it.
            await failedActivity.locator("summary").filter({ hasText: "1 failed" }).waitFor();
            assert.match(
              await messages
                .locator('article[aria-label="Conversation turn"]')
                .filter({ hasText: "SF6_FAILURE:" })
                .textContent(),
              /1 failed/,
            );
            await capture("approved-failure");

            // Inspecting/revisiting an older branch can leave follow disabled.
            // Explicitly return to the current tail before the cancellation case.
            await returnToLatest();
            // Release a visible prefix through ordinary token-sized frames,
            // then hold the next phase. A single tiny stalled frame can remain
            // undecided in the real stream's public-text projection.
            stub.replaceDispatchPlan([
              {
                type: "stream_controlled",
                chunks: [
                  "SF6 stopped partial answer.\n\n" + "Bounded cancellation fixture prose.\n".repeat(16),
                  "Continuation after the held checkpoint.\n",
                ],
              },
            ]);
            await composer.fill("SF6_STOP: Give a direct answer without tools.");
            await send.click();
            await page.getByText("SF6 stopped partial answer.", { exact: false }).last().waitFor();
            await page.getByRole("button", { name: "Stop response", exact: true }).click();
            await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden" });
            await waitForTurnStatus("SF6_STOP: Give a direct answer without tools.", "cancelled");
            await navigate(session.sessionId);
            await returnToLatest();
            await page.getByText("SF6 stopped partial answer.", { exact: false }).last().waitFor();
            assert.equal(await page.locator(".mc-assistant-streaming-tail").count(), 0);
            assertBrowserConsoleHealthy(log, undefined, NEXT_UI_PACKAGE);
            return {
              status: "passed",
              metrics: {
                exactFinalSource: true,
                retainedManualScroll: true,
                bottomFollow: true,
                resizedFenceAndTable: true,
                retainedDisclosureAndFocus: true,
                noDuplicateAfterRefresh: true,
                noCrossSessionAnswer: true,
                confirmedCancellation: true,
                optimisticAdmission: true,
                liveReconnect: true,
                retryAndBranchSwitch: true,
                approvalAndFailedTool: true,
                blockingAccessibilityViolations: blockingAccessibility.length,
                accessibilityViolationIds: accessibility.violations.map(({ id }) => id),
                retainedProseSpacing: true,
                readableLongLine: true,
              },
              artifacts: captures,
            };
          } catch (error) {
            const canonicalTurns = (await thread()).turns.map(({ turnId, parentTurnId, branch, trace }) => ({
              turnId,
              parentTurnId,
              branch,
              status: trace.status,
            }));
            const measurements = await scroller
              .evaluate((node) => ({
                scrollTop: node.scrollTop,
                scrollHeight: node.scrollHeight,
                viewportHeight: node.clientHeight,
              }))
              .catch(() => null);
            await capture("failure");
            return {
              status: "failed",
              error: error.stack ?? String(error),
              metrics: { measurements, canonicalTurns },
              artifacts: captures,
            };
          } finally {
            for (const turn of (await thread()).turns ?? [])
              if (
                ["queued", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"].includes(
                  turn.trace.status,
                )
              ) {
                await api(`${route}/turns/${encodeURIComponent(turn.turnId)}/cancel`, { method: "POST", body: {} });
              }
            await browserContext.close();
          }
        },
      );
    }
  } finally {
    await browser?.close();
    if (stack || runtimeRoot) await stopVerificationStack(stack ?? { runtimeRoot });
    await stub?.close();
  }
}
