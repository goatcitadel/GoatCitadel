import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function withNativeRecallPage({ app, root, runtimeEnv, uiPort, debugPort, poll, visit }) {
  const require = createRequire(path.join(app, "gateway", "package.json"));
  const { chromium } = require("playwright");
  const host = spawn(path.join(app, "desktop", "GoatCitadel-Mission-Control-Windows.exe"), [], {
    cwd: root,
    env: {
      ...runtimeEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}`,
    },
    stdio: "ignore",
  });
  const closed = once(host, "close").then(() => true, () => true);
  let browser;
  try {
    await once(host, "spawn");
    const endpoint = `http://127.0.0.1:${debugPort}`;
    const uiOrigin = `http://127.0.0.1:${uiPort}/`;
    await poll(async () => {
      if (host.exitCode !== null) throw new Error(`Native recall host exited ${host.exitCode}`);
      const targets = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.json()).catch(() => []);
      return targets.some((target) => target.type === "page" && target.url.startsWith(uiOrigin));
    }, "the installed native WebView", 65000);
    browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts().flatMap((context) => context.pages()).find((entry) => entry.url().startsWith(uiOrigin));
    assert.ok(page);
    page.setDefaultTimeout(20000);
    const tokenField = page.getByLabel("Gateway token", { exact: true });
    await tokenField.fill(runtimeEnv.GOATCITADEL_AUTH_TOKEN);
    await page.getByLabel("Remember credentials on this browser", { exact: true }).check();
    await page.getByRole("button", { name: "Connect to gateway", exact: true }).click();
    await tokenField.waitFor({ state: "hidden" });
    return await visit(page);
  } finally {
    try {
      await browser?.close();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      assert.ok(await Promise.race([closed, delay(8000, false, { ref: false })]), "Native recall host did not exit");
    }
  }
}

export function installedRecall(root, evidence, withStub, poll) {
  return withStub(root, { recall: true }, ({ api, send, waitForTurn, restart, withNative }) => withNative(async (page) => {
    const settle = async (title, content) => {
      const chat = await send(title, content, page);
      const turn = await waitForTurn(chat, "completed");
      const receipt = () => api(`${chat.route}/turns/${turn.turnId}/learning-receipt?workspaceId=default`);
      return { chat, turn, receipt };
    };
    const decision = "Project Aurora deployment decision: use the violet harbor route for the rollout.";
    const answer = "The earlier chat chose the violet harbor route.";
    const source = await settle("Aurora decision", decision);
    const recalled = await settle("Fresh-chat recall", "What did we decide about the Aurora rollout in an earlier chat?");
    const lookup = recalled.turn.toolRuns.find((run) => run.toolName === "session.search" && run.status === "executed");
    assert.equal(lookup?.result?.scope, "prior");
    assert.ok(lookup.result.hits.some((hit) => hit.messageId === source.turn.userMessage.messageId));
    assert.ok(lookup.result.hits.every((hit) => hit.sessionId !== recalled.chat.id));
    const answerText = page.locator('[aria-label="Messages"]').getByText(answer, { exact: true });
    await answerText.waitFor();
    await page.locator("summary").filter({ hasText: /^\d+ sources?$/u }).last().click();
    const target = page.getByRole("listitem").filter({ hasText: decision }).getByRole("link", { name: "Open matching message" });
    const href = new URL(await target.getAttribute("href"), page.url());
    assert.equal(href.searchParams.get("sessionId"), source.chat.id);
    assert.equal(href.searchParams.get("messageId"), source.turn.userMessage.messageId);
    await page.screenshot({ path: path.join(evidence, "recall-sources.png") });
    await target.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("messageId") === source.turn.userMessage.messageId);
    await page.getByText(decision, { exact: true }).first().waitFor();
    await page.goBack();
    await answerText.waitFor();

    const noMatch = await settle("Unverified decision", "What did we decide about the Zephyr permit deadline?");
    const noMatchSearches = noMatch.turn.toolRuns.filter((run) => run.toolName === "session.search");
    assert.equal(noMatchSearches.length, 2);
    for (const search of noMatchSearches) {
      assert.equal(search.status, "executed");
      assert.equal(search.result?.scope, "prior");
      assert.deepEqual(search.result?.hits, []);
    }
    assert.equal(noMatch.turn.citations?.length ?? 0, 0);
    await page.locator('[aria-label="Messages"]').getByText(
      "I couldn’t verify that from our earlier chats. The history search found no matching messages.", { exact: true },
    ).waitFor();
    await page.screenshot({ path: path.join(evidence, "recall-no-match.png") });

    const promote = async (state, screenshot) => {
      const candidate = await poll(async () => (await state.receipt()).proposals.find(
        (row) => row.kind === "memory" && row.candidate?.status === "proposed",
      )?.candidate, "the scoped preference proposal", 20000);
      await page.getByText("Memory and learning", { exact: true }).last().click();
      const promotion = page.waitForResponse((response) => response.url().includes(`/trace-candidates/${candidate.candidateId}/promote`));
      await page.getByRole("button", { name: "Save to memory", exact: true }).click();
      const accepted = await promotion;
      assert.ok(accepted.ok(), "The native preference review failed");
      await page.screenshot({ path: path.join(evidence, screenshot) });
      return accepted.json();
    };
    const first = await promote(await settle("Save preference", "Remember that I prefer a three-bullet weekly update."), "recall-preference-review.png");
    const preferencePrompt = "How should you format my weekly update?";
    const fresh = await settle("Recall preference", preferencePrompt);
    assert.ok((await fresh.receipt()).usedSources.some((item) => item.ref === first.learningId && item.sourceHash === first.sourceHash));
    const corrected = await promote(await settle("Correct preference", "Actually, I prefer a two-bullet weekly update."), "recall-correction-review.png");
    const revised = await settle("Recall correction", preferencePrompt);
    const revisedSources = (await revised.receipt()).usedSources;
    assert.ok(revisedSources.some((item) => item.ref === corrected.learningId && item.sourceHash === corrected.sourceHash));
    assert.ok(!revisedSources.some((item) => item.ref === first.learningId));
    await api(`/api/v1/memory/learnings/${corrected.learningId}/forget`, "POST", { workspaceId: "default" });
    const reconnect = page.waitForURL((url) => url.searchParams.get("tab") === "onboarding" || url.pathname === "/settings/onboarding", { timeout: 45000 });
    // Reconnect can restore Chat directly or return to the completed setup page.
    void reconnect.catch(() => undefined);
    await restart();
    if (await reconnect.then(() => true, () => false)) {
      await page.getByText("Setup is done and your first Chat answer is verified.", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Chat", exact: true }).click();
    }
    const forgotten = await settle("Verify forgotten preference", preferencePrompt);
    const forgottenSources = (await forgotten.receipt()).usedSources;
    assert.ok(!forgottenSources.some((item) => [first.learningId, corrected.learningId].includes(item.ref)));
    return {
      sourceMessageId: source.turn.userMessage.messageId,
      recallTurnId: recalled.turn.turnId,
      priorSearchRunId: lookup.toolRunId,
      noMatchTurnId: noMatch.turn.turnId,
      originalLearningId: first.learningId,
      correctedLearningId: corrected.learningId,
      correctedTurnId: revised.turn.turnId,
      postRestartTurnId: forgotten.turn.turnId,
      postRestartRecallExcluded: true,
    };
  }), {
    dispatchPlanStreamOnly: true,
    dispatchPlan: [
      { type: "success", replyText: "Recorded the Aurora rollout decision in this chat." },
      { type: "tool_call", name: "session_search", arguments: { scope: "prior", query: "Aurora rollout" } },
      { type: "success", replyText: "The earlier chat chose the violet harbor route." },
      { type: "tool_call", name: "session_search", arguments: { scope: "prior", query: "Zephyr permit deadline" } },
      { type: "tool_call", name: "session_search", arguments: { scope: "session", query: "Zephyr permit" } },
      { type: "success", replyText: "We haven't made a decision yet." },
    ],
  });
}
