import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

/** Full default-Cockpit journey against isolated durable Gateway state and a loopback provider. */
export async function runChatAsyncClarificationProof(context, deps) {
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
    NEXT_UI_PACKAGE,
  } = deps;
  let stub, stack, runtimeRoot, browser;
  try {
    stub = await startDeterministicLlmStub({
      replyText: "CLARIFICATION_MISSING",
      dispatchPlanRequiredTool: "user_input_request",
    });
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-async-input`, stub.baseUrl);
    // Explicitly allow this new safe tool in the disposable fixture only.
    // The shipped allowlist and operator policy still govern real installations.
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.toolPolicy.tools.allow.push("user_input.request");
    delete config.generation;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(runtimeRoot, "config", "tool-policy.json"),
      `${JSON.stringify(config.toolPolicy, null, 2)}\n`,
    );
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      gatewayMode: "built",
      uiMode: "preview",
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "verification-optional-input-operator-token",
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
        GOATCITADEL_FEATURE_CHAT_ASYNC_CLARIFICATION_V1_ENABLED: "true",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: "verification-stub-key",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-optional-input");
    const api = async (route, init) => {
      const response = await requestJson(stack.gatewayUrl, route, init);
      assert.ok(response.ok, `${route}: HTTP ${response.status}`);
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
          id: `async-clarification.chat.${variant}`,
          lane: "usability",
          subsystem: "mission-control",
          title: `Optional question continues work and incorporates the answer in default Cockpit ${variant}`,
        },
        async () => {
          const reply = `Concise aqua style ${variant}`,
            final = `OPTIONAL_REPLY_USED_${variant}`;
          stub.replaceDispatchPlan([
            {
              type: "tool_call",
              name: "user_input_request",
              arguments: { title: "Style preference", question: "Which style should I use?" },
            },
            { type: "tool_call", name: "session_status", arguments: {}, delayMs: 20_000 },
          ]);
          stub.replacePromptReplyRules([{ ruleId: `reply-${variant}`, userContentIncludes: reply, replyText: final }]);
          const session = await api("/api/v1/chat/sessions", {
            method: "POST",
            body: { title: `Optional input ${variant}` },
          });
          // Safe-profile approval posture remains in force. Admit just these two
          // fixture tools through the normal expiring, session-scoped grant owner.
          for (const toolPattern of ["user_input.request", "session.status"])
            await api("/api/v1/tools/grants", {
              method: "POST",
              body: {
                toolPattern,
                decision: "allow",
                scope: "session",
                scopeRef: session.sessionId,
                grantType: "ttl",
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            });
          const sessionRoute = `/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}`;
          const prefs = await api(`${sessionRoute}/prefs`);
          await api(`${sessionRoute}/prefs`, {
            method: "PATCH",
            body: {
              expectedRevision: prefs.revision,
              providerId: stub.providerId,
              model: stub.model,
              webMode: "off",
              memoryMode: "off",
              subagentPolicy: "off",
              toolAutonomy: "safe_auto",
              orchestrationEnabled: false,
            },
          });
          const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
          await installMissionControlNextBrowserState(browserContext, session.workspaceId, session.citadelId);
          const page = await browserContext.newPage(),
            log = attachBrowserLogging(page);
          let artifacts;
          try {
            await page.goto(`${stack.uiUrl}/chat?sessionId=${encodeURIComponent(session.sessionId)}`, {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(
              page,
              { href: "/chat", readySelector: 'section[aria-label="Chat"] [aria-label="Messages"]' },
              NEXT_UI_PACKAGE,
            );
            assert.equal(new URL(page.url()).searchParams.has("shell"), false);
            await page
              .getByRole("combobox", { name: "Message", exact: true })
              .fill(
                "Ask one optional style question with user_input.request, continue by checking session.status, then finish using the reply if available.",
              );
            await page.getByRole("button", { name: "Send", exact: true }).click();
            const form = page.getByRole("form", { name: "Pending question" });
            await form.getByText("Optional · Work continues", { exact: true }).waitFor();
            const deadline = Date.now() + 20_000;
            while (stub.dispatchPlanDispatches() < 2 && Date.now() < deadline) await page.waitForTimeout(100);
            assert.equal(
              stub.dispatchPlanDispatches(),
              2,
              "Independent status work must begin before the operator answers",
            );
            const thread = await api(`${sessionRoute}/thread`),
              turn = thread.turns.at(-1),
              prompt = turn.trace.pendingUserInput;
            assert.ok(["running", "waiting_for_tool"].includes(turn.trace.status));
            assert.equal(prompt.delivery, "background");
            assert.equal(prompt.required, false);
            const runRoute = `/api/v1/durable/runs/${encodeURIComponent(turn.trace.durable.runId)}`;
            const before = await api(runRoute);
            assert.equal(before.status, "running");
            assert.ok(before.leaseOwnerId);
            assert.ok(await page.getByRole("button", { name: /^Stop response$/ }).isEnabled());
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
              false,
            );
            artifacts = await captureBrowserArtifacts(context, {
              slug: `async-clarification-${variant}-pending`,
              page,
              browserLog: log,
              gatewayUrl: stack.gatewayUrl,
            });
            await form.getByRole("textbox", { name: "Your response" }).fill(reply);
            const answerRoute = `${sessionRoute}/turns/${encodeURIComponent(turn.trace.turnId)}/user-input/${encodeURIComponent(prompt.promptId)}/respond`;
            const responsePromise = page
              .waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === answerRoute && response.request().method() === "POST",
              )
              .catch(() => null);
            await form.getByRole("button", { name: /Submit/ }).click();
            const response = await responsePromise;
            assert.ok(response);
            assert.equal(response.status(), 200);
            const receipt = await response.json();
            assert.equal(receipt.resumed, false);
            const after = await api(runRoute);
            assert.equal(after.status, "running");
            assert.equal(after.leaseOwnerId, before.leaseOwnerId);
            assert.equal(after.payload.optionalUserInputReplies[0].response.text, reply);
            await page.getByText(final, { exact: false }).first().waitFor({ timeout: 30_000 });
            await form.waitFor({ state: "hidden" });
            const completed = await api(runRoute);
            assert.equal(completed.status, "completed");
            const exactReplay = await api(answerRoute, {
              method: "POST",
              body: { response: { kind: "text", text: reply } },
            });
            assert.equal(exactReplay.replayed, true);
            assert.equal((await api(runRoute)).version, completed.version);
            assert.ok(
              stub.requestSummaries().some((entry) => entry.promptReplyRuleId === `reply-${variant}`),
              "The provider must actually receive the ordinary reply",
            );
            assertBrowserConsoleHealthy(log, undefined, NEXT_UI_PACKAGE);
            const finalArtifacts = await captureBrowserArtifacts(context, {
              slug: `async-clarification-${variant}-complete`,
              page,
              browserLog: log,
              gatewayUrl: stack.gatewayUrl,
            });
            return {
              status: "passed",
              metrics: {
                preservedRunningLease: true,
                exactTerminalReplay: true,
                providerReceivedReply: true,
                horizontalOverflow: false,
              },
              artifacts: Object.fromEntries(
                Object.keys(finalArtifacts).map((key) => [key, [...(artifacts[key] ?? []), ...finalArtifacts[key]]]),
              ),
            };
          } catch (error) {
            artifacts = await captureBrowserArtifacts(context, {
              slug: `async-clarification-${variant}-failure`,
              page,
              browserLog: log,
              gatewayUrl: stack.gatewayUrl,
            });
            return { status: "failed", error: error.stack ?? String(error), artifacts };
          } finally {
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
