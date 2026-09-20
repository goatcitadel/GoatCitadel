import assert from "node:assert/strict";
import path from "node:path";
import { createRunContext, finalizeRunContext, releaseRunContext } from "./lib/shared.mjs";
import { runAccessibilitySmokeLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";

// Uses the normal isolated Gateway/a11y fixture and synthetic provider. No user
// runtime, credentials, conversations, or visual baselines are changed.
const formatted = "# Display proof\n\n- First item\n- Second item\n\n| Name | Value |\n| --- | --- |\n| Test | Safe |\n\n```js\nconst answer = 42;\n```\n\n[Safe link](https://example.com)";
// The stall fixture emits one provider frame. Keep it below the secret
// projector's oversized undecided-chunk boundary while creating scroll depth.
const partial = Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1}: saved.`).join("\n\n");

async function reloadFixturePage(page) {
  // The shared visual fixture hides blocking prompts unless explicitly opted
  // in. Retain that opt-in when Chat navigation replaces the query string.
  const url = new URL(page.url());
  url.searchParams.set("vr-blocked", "1");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
}

function gateRequest(page, pattern) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = new Set();
  const failures = [];
  const handler = (route) => {
    const work = gate.then(() => route.continue()).catch(error => { failures.push(error); });
    pending.add(work);
    return work.finally(() => pending.delete(work));
  };
  return page.route(pattern, handler).then(() => async () => {
    release();
    await Promise.all([...pending]);
    await page.unroute(pattern, handler);
    if (failures.length) throw new AggregateError(failures, "Could not release fixture request gate");
  });
}

async function prepare(page, { stub }) {
  const newChat = page.getByRole("button", { name: "New chat", exact: true });
  if (!(await newChat.isVisible())) await page.getByRole("button", { name: "Threads", exact: true }).click();
  const createdResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/chat/sessions"));
  await newChat.click();
  const createdHttp = await createdResponse;
  const gatewayUrl = new URL(createdHttp.url()).origin;
  const created = await createdHttp.json();
  assert.equal(typeof created.sessionId, "string", "fixture chat must be created");
  try {
  await page.getByRole("heading", { name: created.title ?? `Mission chat - ${created.sessionId.slice(-6)}`, exact: true }).waitFor();
  if (page.viewportSize().width < 700) await page.getByLabel("Threads", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".mc-next-composer-blocking-prompt").waitFor({ state: "hidden" });
  const composer = page.getByLabel("Message composer", { exact: true });
  const send = page.getByRole("button", { name: "Send", exact: true });
  stub.replaceDispatchPlan([{ type: "success", replyText: formatted }]);
  const releaseSend = await gateRequest(page, "**/agent-send/stream");
  try {
    await composer.fill("DISPLAY_SMOKE_FORMATTED: give a short formatted answer, without tools.");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Send" && !button.disabled));
    // Observe the very first rendering frame following the local click, while
    // admission is deliberately held. No provider timing enters this assertion.
    const feedback = await send.evaluate((button) => new Promise((resolve) => {
      button.click();
      requestAnimationFrame(() => resolve({
        users: [...document.querySelectorAll(".mc-next-thread-bubble.user")].filter((node) => node.textContent.includes("DISPLAY_SMOKE_FORMATTED")).length,
        pending: document.querySelectorAll(".mc-next-active-work-summary").length,
        label: document.querySelector(".mc-next-active-work-summary")?.textContent,
      }));
    }));
    assert.equal(feedback.users, 1, "optimistic message must render by the next frame");
    assert.equal(feedback.pending, 1, "exactly one work indicator before admission");
    assert.match(feedback.label, /Sending/);
  } finally { await releaseSend(); }
  await page.getByRole("heading", { name: "Display proof", exact: true }).waitFor();
  await page.locator(".mc-next-active-work-summary").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".mc-next-thread-bubble.user").filter({ hasText: "DISPLAY_SMOKE_FORMATTED" }).count(), 1);
  assert.equal(await page.locator(".mc-next-thread-bubble.assistant table").count(), 1);
  assert.equal(await page.locator(".mc-next-thread-bubble.assistant pre").count(), 1);

  stub.replaceDispatchPlan([
    { type: "tool_call", name: "fs_read", arguments: { path: "DISPLAY_SMOKE_MISSING_FILE.txt" } },
  ]);
  await composer.fill("DISPLAY_SMOKE_TOOL: use fs.read to read DISPLAY_SMOKE_MISSING_FILE.txt and explain if it is missing.");
  await send.click();
  // Exercise the fixture's real approval instead of weakening its read policy.
  await page.getByRole("button", { name: "Review approval", exact: true }).click();
  await page.getByRole("button", { name: "Approve now", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Open live session", exact: true }).click();
  await page.locator(".mc-next-thread-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
  try {
    await page.getByText("An approved tool action could not be completed. Open Activity to inspect the recovery details.", { exact: true }).waitFor();
  } catch (error) {
    const response = await page.request.get(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/thread?includeDecisionTrace=true`);
    const thread = await response.json();
    const turn = thread.turns?.find((item) => item.userMessage?.content?.startsWith("DISPLAY_SMOKE_TOOL:"));
    console.error(JSON.stringify({ turnId: turn?.turnId, status: turn?.trace?.status, failure: turn?.trace?.failure, tools: turn?.trace?.toolRuns, answer: turn?.assistantMessage?.content }));
    throw error;
  }
  await send.waitFor({ state: "visible" });
  await page.locator(".mc-next-turn-evidence-summary").filter({ hasText: "tool_failed" }).locator("summary").click();
  const failureRow = page.getByRole("button", { name: "Open execution detail for fs.read", exact: true });
  await failureRow.waitFor();
  assert.match(await failureRow.innerText(), /failed/i, "failed tool remains visible with its truthful failure answer");

  stub.replaceDispatchPlan([
    { type: "tool_call", name: "fs_read", arguments: { path: "DISPLAY_SMOKE_DENIED.txt" } },
    { type: "tool_call", name: "documents_create", arguments: { path: "should-not-exist.pdf", format: "pdf", body: "not authorized" } },
  ]);
  await composer.fill("DISPLAY_SMOKE_DENY: use fs.read to inspect DISPLAY_SMOKE_DENIED.txt.");
  await send.click();
  await page.getByRole("button", { name: "Review approval", exact: true }).click();
  await page.getByRole("button", { name: "Reject", exact: true }).waitFor();
  const streamingRequests = () => stub.requestSummaries().filter(request => request.stream === true).length;
  const requestsAtDenial = streamingRequests();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Confirm rejection", exact: true }).click();
  await page.getByRole("button", { name: "Confirm rejection", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("link", { name: "Open live session", exact: true }).click();
  await page.locator(".mc-next-thread-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByText("You denied the action. This turn will not start any more tools or request another approval. Send a new message to continue.", { exact: true }).waitFor();
  assert.equal(streamingRequests(), requestsAtDenial, "denial must finalize without another model or alternative tool request");
  const deniedThread = await (await page.request.get(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/thread?includeDecisionTrace=true`)).json();
  const deniedTurn = deniedThread.turns.find(item => item.userMessage?.content?.startsWith("DISPLAY_SMOKE_DENY:"));
  assert.equal(deniedTurn.trace.toolRuns.length, 1, "denied turn must not start an alternative tool");
  assert.equal(deniedTurn.trace.toolRuns[0].result.approvalOutcome, "denied");
  assert.equal(await page.getByRole("button", { name: "Allow once", exact: true }).count(), 0);
  const deniedRun = await (await page.request.get(`${gatewayUrl}/api/v1/durable/runs/${deniedTurn.trace.durable.runId}`)).json();
  console.log(JSON.stringify({ phase: "denied", viewport: page.viewportSize().width, runStatus: deniedRun.status }));

  stub.replaceDispatchPlan([{ type: "stream_stall", emittedText: partial }]);
  await composer.fill("DISPLAY_SMOKE_CANCEL: write a long answer without tools.");
  await send.click();
  await page.locator(".mc-next-thread-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  try { await page.getByText("Paragraph 1: saved.", { exact: false }).last().waitFor(); }
  catch (error) {
    const snapshot = await (await page.request.get(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/thread?includeDecisionTrace=true`)).json();
    console.error(JSON.stringify({ phase: "partial-missing", requests: stub.requestSummaries().slice(-3).map(request => ({ stream: request.stream, behavior: request.behavior, outcome: request.outcome })), turns: snapshot.turns?.map(turn => ({ turnId: turn.turnId, status: turn.trace.status })) }));
    throw error;
  }
  const scroller = page.locator(".mc-next-thread-scroll");
  await scroller.evaluate((node) => { node.scrollTop = 100; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.getByRole("button", { name: /Jump to latest/ }).waitFor();
  const beforeStop = await scroller.evaluate((node) => node.scrollTop);
  const stopResponse = page.waitForResponse(response => response.request().method() === "POST" && /\/turns\/[^/]+\/cancel$/.test(response.url()));
  const releaseCancel = await gateRequest(page, "**/turns/*/cancel");
  try {
    await page.getByRole("button", { name: /^Stop(?: turn)?$/ }).first().click();
    await page.getByLabel("Current work", { exact: true }).getByText("Stopping…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
  } finally { await releaseCancel(); }
  assert.equal((await (await stopResponse).json()).cancelled, true);
  await page.getByText("Stopping…", { exact: true }).waitFor({ state: "hidden" });
  assert.ok(Math.abs(await scroller.evaluate((node) => node.scrollTop) - beforeStop) < 4, "confirmation must preserve the reading position");
  await page.getByRole("button", { name: /Jump to latest/ }).click();
  await page.locator(".mc-next-thread-meta strong").filter({ hasText: /^Stopped$/ }).waitFor();
  await reloadFixturePage(page);
  await page.locator(".mc-next-thread-meta strong").filter({ hasText: /^Stopped$/ }).waitFor();
  await page.getByText("Paragraph 20: saved.", { exact: true }).waitFor();

  const thread = async () => await (await page.request.get(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/thread?includeDecisionTrace=true`)).json();
  const stopAndRead = async (marker) => {
    const cancellation = page.waitForResponse(response => response.request().method() === "POST" && /\/turns\/[^/]+\/cancel$/.test(response.url()));
    await page.getByLabel("Current work", { exact: true }).getByRole("button", { name: "Stop", exact: true }).click();
    assert.equal((await (await cancellation).json()).cancelled, true);
    await page.getByText("Stopping…", { exact: true }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector('.mc-next-active-work-summary.state-running'));
    const stopped = (await thread()).turns.find(turn => turn.userMessage?.content?.startsWith(marker));
    assert.equal(stopped?.trace.status, "cancelled");
    assert.ok(!stopped.assistantMessage?.content, "pre-output Stop must not invent retained output");
    return stopped;
  };
  stub.replaceDispatchPlan([{ type: "stream_stall" }]);
  await composer.fill("DISPLAY_SMOKE_BEFORE_TEXT: give a direct answer without tools.");
  await send.click();
  await stopAndRead("DISPLAY_SMOKE_BEFORE_TEXT:");

  stub.replaceDispatchPlan([{ type: "tool_call", name: "fs_read", arguments: { path: "DISPLAY_SMOKE_STOP_PENDING.txt" } }]);
  await composer.fill("DISPLAY_SMOKE_STOP_PENDING: use fs.read to inspect DISPLAY_SMOKE_STOP_PENDING.txt.");
  await send.click();
  await page.getByRole("button", { name: "Review approval", exact: true }).waitFor();
  await reloadFixturePage(page);
  await page.getByRole("button", { name: "Review approval", exact: true }).waitFor();
  const stoppedWaiting = await stopAndRead("DISPLAY_SMOKE_STOP_PENDING:");
  assert.equal(stoppedWaiting.trace.toolRuns[0].result.approvalOutcome, "withdrawn");
  await page.getByRole("button", { name: "Review approval", exact: true }).waitFor({ state: "hidden" });

  // Only this freshly created fixture session is changed. Exercise the real
  // user-input prompt and durable delegation service, with one specialist.
  const prefsUrl = `${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/prefs`;
  const currentPrefs = await (await page.request.get(prefsUrl)).json();
  const prefs = await page.request.patch(prefsUrl, {
    headers: { "Idempotency-Key": `chat-display-prefs:${created.sessionId}` },
    data: { expectedRevision: currentPrefs.revision, subagentPolicy: "ask_when_useful", memoryMode: "off", webMode: "off" },
  });
  assert.ok(prefs.ok(), `set isolated delegation test prefs: ${await prefs.text()}`);
  await reloadFixturePage(page);
  stub.replaceDispatchPlan([{ type: "success", replyText: "QA_DELEGATION_COMPLETE: The alphabetical card order is correct." }]);
  const beforeDelegation = streamingRequests();
  await composer.fill("DISPLAY_SMOKE_DELEGATE: Use one QA specialist to review this plan: sort three cards alphabetically and verify their order.");
  await send.click();
  const planChoice = page.getByRole("radio", { name: /^Run this plan/ });
  await planChoice.waitFor();
  assert.equal(streamingRequests(), beforeDelegation, "asking does not dispatch a planner or a child");
  await reloadFixturePage(page);
  await planChoice.check();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  try {
    await page.getByText("QA_DELEGATION_COMPLETE: The alphabetical card order is correct.", { exact: false }).first().waitFor({ timeout: 60_000 });
  } catch (error) {
    const parent = (await thread()).turns.find(turn => turn.userMessage?.content?.startsWith("DISPLAY_SMOKE_DELEGATE:"));
    const runId = parent?.trace.durable?.runId;
    const run = runId ? await (await page.request.get(`${gatewayUrl}/api/v1/durable/runs/${runId}`)).json() : undefined;
    const timeline = runId ? await (await page.request.get(`${gatewayUrl}/api/v1/durable/runs/${runId}/timeline`)).json() : undefined;
    console.error(JSON.stringify({ phase: "delegation-failure", turnId: parent?.turnId, traceStatus: parent?.trace.status,
      runStatus: run?.status, error: run?.lastError, summary: run?.metadata?.finalSummary,
      events: timeline?.items?.map(item => item.eventType),
      requests: stub.requestSummaries().slice(-3).map(request => ({ stream: request.stream, behavior: request.behavior, outcome: request.outcome })) }));
    throw error;
  }
  await page.locator(".mc-next-active-work-summary").waitFor({ state: "hidden", timeout: 60_000 });
  const delegated = (await thread()).turns.find(turn => turn.userMessage?.content?.startsWith("DISPLAY_SMOKE_DELEGATE:"));
  assert.equal(delegated?.trace.status, "completed", JSON.stringify(delegated?.trace.failure));
  assert.equal(streamingRequests(), beforeDelegation + 1, "one confirmed specialist dispatches once");
  await reloadFixturePage(page);
  await page.getByText("QA_DELEGATION_COMPLETE: The alphabetical card order is correct.", { exact: false }).first().waitFor();
  assert.equal(streamingRequests(), beforeDelegation + 1, "reload must not launch the plan again");
  return { nextFrameFeedback: true, reconciledWithoutDuplicates: true, formattedAnswer: true, failedToolVisible: true, deniedWithoutRedispatch: true, confirmedStop: true, retainedAfterReload: true, stopBeforeText: true, stopPendingApprovalAfterReload: true, exactSingleSpecialistConfirmation: true };
  } finally {
    // A failed scenario must not leave its stalled provider consuming the next
    // viewport's dispatch plan. Only cancel turns in this fresh fixture session.
    const snapshot = await (await page.request.get(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/thread`)).json();
    for (const turn of snapshot.turns ?? []) {
      if (["queued", "running", "waiting_for_tool", "waiting_for_approval", "waiting_for_user_input"].includes(turn.trace.status)) {
        const cancelled = await page.request.post(`${gatewayUrl}/api/v1/chat/sessions/${created.sessionId}/turns/${turn.turnId}/cancel`, {
          headers: { "Idempotency-Key": `chat-display-cleanup:${turn.turnId}` }, data: {},
        });
        assert.ok(cancelled.ok(), `clean up isolated turn ${turn.turnId}: ${await cancelled.text()}`);
      }
    }
  }
}

const context = await createRunContext("accessibility-smoke", { commandSelection: "chat-display" });
try {
  await runAccessibilitySmokeLane(context, { dispatchPlanStreamOnly: true, secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(context.repoRoot, "config")), scenarios: [
    { id: "chat-display-desktop", title: "Chat display lifecycle and Markdown", href: "/chat?vr-blocked=1", viewport: { width: 1440, height: 1024 }, route: { readySelector: '.mc-next-threaded-surface[data-mode="chat"]', expectedArea: "chat", expectedSection: "root" }, prepare },
    { id: "chat-display-narrow", title: "Narrow reduced-motion chat display", href: "/chat?vr-blocked=1", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", route: { readySelector: '.mc-next-threaded-surface[data-mode="chat"]', expectedArea: "chat", expectedSection: "root" }, prepare },
  ] });
  const result = await finalizeRunContext(context);
  console.log(`Chat display proof: ${context.artifactRoot}\nStatus: ${result.status}`);
  if (result.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally { await releaseRunContext(context); }
