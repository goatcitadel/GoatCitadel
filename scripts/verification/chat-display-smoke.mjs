/* global document, requestAnimationFrame, Event -- callbacks evaluated in the browser by Playwright. */
import assert from "node:assert/strict";
import path from "node:path";
import { createRunContext, finalizeRunContext, releaseRunContext } from "./lib/shared.mjs";
import { runAccessibilitySmokeLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";

// Uses the normal isolated Gateway/a11y fixture and synthetic provider. No user
// runtime, credentials, conversations, or visual baselines are changed.
const formatted = "# Display proof\n\n- First item\n- Second item\n\n| Name | Value |\n| --- | --- |\n| Test | Safe |\n\n```js\nconst answer = 42;\n```\n\n[Safe link](https://example.com)";
const partial = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}: retained display smoke output.`).join("\n\n");

function gateRequest(page, pattern) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = async (route) => { await gate; await route.continue(); };
  return page.route(pattern, handler).then(() => async () => {
    release();
    await page.unroute(pattern, handler);
  });
}

async function prepare(page, { stub }) {
  const newChat = page.getByRole("button", { name: "New chat", exact: true });
  if (!(await newChat.isVisible())) await page.getByRole("button", { name: "Threads", exact: true }).click();
  const createdResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/v1/chat/sessions"));
  await newChat.click();
  const created = await (await createdResponse).json();
  assert.equal(typeof created.sessionId, "string", "fixture chat must be created");
  await page.getByText(created.title ?? `Mission chat - ${created.sessionId.slice(-6)}`, { exact: true }).first().waitFor();
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
    { type: "success", replyText: "DISPLAY_SMOKE_RECOVERED: the missing fixture file could not be read." },
  ]);
  await composer.fill("DISPLAY_SMOKE_TOOL: read DISPLAY_SMOKE_MISSING_FILE.txt and explain if it is missing.");
  await send.click();
  await page.getByText("DISPLAY_SMOKE_RECOVERED: the missing fixture file could not be read.", { exact: true }).waitFor();
  await page.locator(".mc-next-active-work-summary").waitFor({ state: "hidden" });
  const failureRow = page.getByRole("button", { name: "Open execution detail for fs.read", exact: true });
  await failureRow.waitFor();
  assert.match(await failureRow.innerText(), /failed|blocked/i, "failed tool remains visible after the successful answer");

  stub.replaceDispatchPlan([{ type: "stream_stall", emittedText: partial }]);
  await composer.fill("DISPLAY_SMOKE_CANCEL: write a long answer without tools.");
  await send.click();
  await page.getByText("Paragraph 80: retained display smoke output.", { exact: true }).waitFor();
  const scroller = page.locator(".mc-next-thread-scroll");
  await scroller.evaluate((node) => { node.scrollTop = 100; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.getByRole("button", { name: /Jump to latest/ }).waitFor();
  const beforeStop = await scroller.evaluate((node) => node.scrollTop);
  const releaseCancel = await gateRequest(page, "**/turns/*/cancel");
  try {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByLabel("Current work", { exact: true }).getByText("Stopping…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
  } finally { await releaseCancel(); }
  await page.locator(".mc-next-thread-meta strong").filter({ hasText: /^Stopped$/ }).waitFor();
  assert.ok(Math.abs(await scroller.evaluate((node) => node.scrollTop) - beforeStop) < 4, "confirmation must preserve the reading position");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".mc-next-thread-meta strong").filter({ hasText: /^Stopped$/ }).waitFor();
  await page.getByText("Paragraph 80: retained display smoke output.", { exact: true }).waitFor();
  return { nextFrameFeedback: true, reconciledWithoutDuplicates: true, formattedAnswer: true, failedToolVisible: true, confirmedStop: true, retainedAfterReload: true };
}

const context = await createRunContext("accessibility-smoke", { commandSelection: "chat-display" });
try {
  await runAccessibilitySmokeLane(context, { dispatchPlanStreamOnly: true, secretEnvKeys: await collectVerificationSecretEnvKeys(path.join(context.repoRoot, "config")), scenarios: [
    { id: "chat-display-desktop", title: "Chat display lifecycle and Markdown", href: "/chat", viewport: { width: 1440, height: 1024 }, route: { readySelector: '.mc-next-threaded-surface[data-mode="chat"]', expectedArea: "chat", expectedSection: "root" }, prepare },
    { id: "chat-display-narrow", title: "Narrow reduced-motion chat display", href: "/chat", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", route: { readySelector: '.mc-next-threaded-surface[data-mode="chat"]', expectedArea: "chat", expectedSection: "root" }, prepare },
  ] });
  const result = await finalizeRunContext(context);
  console.log(`Chat display proof: ${context.artifactRoot}\nStatus: ${result.status}`);
  if (result.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally { await releaseRunContext(context); }
