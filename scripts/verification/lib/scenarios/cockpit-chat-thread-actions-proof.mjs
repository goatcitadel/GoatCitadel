import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertIndependentFork, assertSiblingSelection, assertTimerMutation, providerSnapshot } from "./cockpit-chat-thread-actions-assertions.mjs";
import { clickTurnAction, waitForTurnAction } from "./cockpit-turn-actions.mjs";

const prefix = "/api/v1/chat/sessions/";
const pathOf = (url) => new URL(url).pathname;

async function waitUntil(read, predicate, page, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function lastTurn(page, content) {
  const messages = page.locator('[aria-label="Messages"]');
  const scroller = messages.locator('[data-testid="virtuoso-scroller"]');
  await scroller.waitFor();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new element.ownerDocument.defaultView.Event("scroll", { bubbles: true }));
  });
  const turn = messages.getByRole("article", { name: "Conversation messages", exact: true }).filter({ hasText: content });
  await turn.waitFor();
  return turn;
}

async function dialogBounds(dialog, viewport, names) {
  await dialog.waitFor();
  for (const locator of [dialog, ...names.map((name) => dialog.getByRole("button", { name, exact: true }))]) {
    await locator.waitFor();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1, "Review or action extends outside the viewport.");
  }
}

async function threadActions({ api, page, scope, writes, capture, viewport, providerStub }) {
  const { sessionId, workspaceId } = scope;
  const threadRoute = `${prefix}${encodeURIComponent(sessionId)}/thread`;
  const listRoute = `/api/v1/chat/sessions?workspaceId=${encodeURIComponent(workspaceId)}&view=all&limit=1000`;
  const initial = await api(threadRoute);
  const list = await api(listRoute);
  const sourceSession = list.items.find((item) => item.sessionId === sessionId);
  assert.ok(sourceSession && Number.isInteger(sourceSession.revision));
  const sourceTurn = initial.turns.find((turn) => turn.turnId === initial.activeLeafTurnId);
  assert.ok(sourceTurn?.assistantMessage && sourceTurn.trace.status === "completed");
  const forkRoute = `${prefix}${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(sourceTurn.turnId)}/fork`;
  const forkWrites = () => writes.filter((write) => write.pathname.endsWith("/fork"));
  const providersBefore = providerSnapshot(providerStub);
  await clickTurnAction(await lastTurn(page, sourceTurn.userMessage.content), "New conversation from here");
  const dialog = page.getByRole("dialog", { name: "Start a new conversation from this message?", exact: true });
  await dialogBounds(dialog, viewport, ["Create conversation", "Cancel"]);
  assert.ok((await dialog.innerText()).includes("read-only provenance, not replayed"));
  await capture("fork-review");
  assert.equal(forkWrites().length, 0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await api(listRoute)).items.map((item) => item.sessionId).sort(), list.items.map((item) => item.sessionId).sort());
  assert.deepEqual(await api(threadRoute), initial);
  assert.equal(forkWrites().length, 0, "Cancel created a fork.");
  await clickTurnAction(await lastTurn(page, sourceTurn.userMessage.content), "New conversation from here");
  await dialogBounds(dialog, viewport, ["Create conversation", "Cancel"]);
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && pathOf(response.url()) === forkRoute);
  await dialog.getByRole("button", { name: "Create conversation", exact: true }).click();
  const reply = await responsePromise;
  assert.equal(reply.status(), 201);
  const response = await reply.json();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(forkWrites().length, 1);
  assert.equal(forkWrites()[0].pathname, forkRoute);
  const forkId = response.session.sessionId;
  const forkThreadRoute = `${prefix}${encodeURIComponent(forkId)}/thread`;
  const forkThread = await api(forkThreadRoute);
  const afterList = await api(listRoute);
  assertIndependentFork({ sourceSession, sourceThread: initial, sourceTurnId: sourceTurn.turnId, response,
    ownerSession: afterList.items.find((item) => item.sessionId === forkId), forkThread, request: forkWrites()[0].body });
  assert.equal(afterList.items.length, list.items.length + 1);
  assert.deepEqual(await api(threadRoute), initial, "Fork modified the source transcript.");
  assert.deepEqual(providerSnapshot(providerStub), providersBefore, "Fork replayed a provider request.");
  if (scope.variant === "mobile") {
    const chooser = page.getByRole("combobox", { name: "Choose conversation", exact: true });
    await waitUntil(() => chooser.inputValue(), value => value === forkId, page, "selected fork conversation");
    assert.equal(await chooser.locator("option:checked").innerText(), response.session.title);
  } else {
    await page.getByRole("heading", { name: response.session.title, level: 1, exact: true }).waitFor();
  }
  await lastTurn(page, sourceTurn.userMessage.content);
  await capture("fork-created");

  const copied = forkThread.turns.find((turn) => turn.turnId === forkThread.activeLeafTurnId);
  await clickTurnAction(await lastTurn(page, copied.userMessage.content), "Edit and resend");
  const revised = `Independent fork sibling ${scope.variant} ${forkId}.`;
  await page.getByRole("combobox", { name: "Message", exact: true }).fill(revised);
  const send = page.getByRole("button", { name: "Send edited message", exact: true });
  await waitUntil(() => send.isEnabled(), Boolean, page, "reviewed branch readiness");
  await send.click();
  await waitUntil(() => api(forkThreadRoute), (thread) => thread.turns.some((turn) =>
    turn.userMessage.content === revised && turn.trace.status === "completed" && turn.branch.isSelectedPath), page, "completed edit sibling");
  // Canonical completion can precede the browser's stream settlement. Wait for
  // the normal composer and settled turn actions before switching branches.
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await waitForTurnAction(await lastTurn(page, revised), "Edit and resend");
  await waitUntil(() => page.getByRole("combobox", { name: "Message", exact: true }).inputValue(), (value) => value === "", page, "settled branch composer");
  const branched = await api(forkThreadRoute);
  const newTurn = branched.turns.find((turn) => turn.userMessage.content === revised);
  assert.ok(newTurn && newTurn.turnId !== copied.turnId && newTurn.parentTurnId === copied.parentTurnId);
  assert.equal(branched.turns.length, forkThread.turns.length, "An edited leaf must replace the selected leaf in this projection.");
  assert.deepEqual(branched.turns.slice(0, -1).map(({ branch: _branch, ...turn }) => turn),
    forkThread.turns.slice(0, -1).map(({ branch: _branch, ...turn }) => turn));
  assert.equal(branched.activeLeafTurnId, newTurn.turnId);
  assert.ok(!branched.turns.some((turn) => turn.turnId === copied.turnId));
  assert.deepEqual([...newTurn.branch.siblingTurnIds].sort(), [copied.turnId, newTurn.turnId].sort());
  const knownTargets = new Map([[copied.turnId, copied], [newTurn.turnId, newTurn]]);
  const dispatchesAfterEdit = providerSnapshot(providerStub);
  assert.ok(dispatchesAfterEdit.completions > providersBefore.completions, "The edit did not reach the deterministic provider.");
  let current = branched;
  for (const [targetId, otherId] of [[copied.turnId, newTurn.turnId], [newTurn.turnId, copied.turnId]]) {
    const displayed = current.turns.find((turn) => turn.turnId === current.activeLeafTurnId);
    const index = displayed.branch.siblingTurnIds.indexOf(targetId);
    assert.ok(index >= 0);
    const selectRoute = `${prefix}${encodeURIComponent(forkId)}/turns/${encodeURIComponent(targetId)}/select`;
    const selectionResponse = page.waitForResponse((result) => result.request().method() === "POST" && pathOf(result.url()) === selectRoute);
    await (await lastTurn(page, displayed.userMessage.content)).getByRole("button", { name: `Switch to version ${index + 1}`, exact: true }).click();
    const selection = await selectionResponse;
    assert.equal(selection.status(), 200);
    const after = await api(forkThreadRoute);
    const expectedTarget = knownTargets.get(targetId);
    assertSiblingSelection({ before: current, after, targetId, otherId, expectedTarget });
    assertSiblingSelection({ before: current, after: await selection.json(), targetId, otherId, expectedTarget });
    const selected = after.turns.find((turn) => turn.turnId === targetId);
    await lastTurn(page, selected.userMessage.content);
    assert.equal(await page.locator('[aria-label="Messages"]').getByText(displayed.userMessage.content, { exact: true }).count(), 0);
    current = after;
  }
  const selections = writes.filter((write) => write.pathname.endsWith("/select"));
  assert.equal(selections.length, 2);
  for (const write of selections) assert.deepEqual(write.body, {});
  assert.deepEqual(providerSnapshot(providerStub), dispatchesAfterEdit, "Selecting siblings dispatched a provider request.");
  assert.deepEqual(await api(threadRoute), initial, "Working in the fork modified its source transcript.");
  await capture("siblings-selected");
  return { sourceSessionId: sessionId, forkSessionId: forkId, forkId: response.manifest.forkId,
    originalSourceSeeded: true, newBranchExecuted: true, cancelledForkWrites: 0, siblingSelections: 2, forkProviderDispatches: 0 };
}

async function timerActions({ api, page, scope, writes, capture, viewport, providerStub, navigate }) {
  const route = `${prefix}${encodeURIComponent(scope.sessionId)}/timers`;
  const threadRoute = `${prefix}${encodeURIComponent(scope.sessionId)}/thread`;
  const before = await api(threadRoute);
  const initialTimers = await api(route);
  assert.deepEqual(initialTimers.items, []);
  const providerBefore = providerSnapshot(providerStub);
  const timerWrites = () => writes.filter((write) => write.pathname.includes("/timers"));
  const open = async () => {
    await page.getByRole("combobox", { name: "Message", exact: true }).fill("/timer");
    await page.getByRole("button", { name: "Open timer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Set a Chat timer", exact: true });
    await dialog.waitFor();
    return dialog;
  };
  let dialog = await open();
  await dialog.getByRole("textbox", { name: "Reminder message", exact: true }).fill("Cancelled review must not save");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(timerWrites().length, 0);
  assert.deepEqual(await api(route), initialTimers);
  dialog = await open();
  const due = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 16);
  const expected = { dueAt: `${due}:00.000Z`, timezone: "UTC", message: `Provider-free reminder ${scope.variant} ${scope.sessionId}`, cancelOnNextReply: false };
  await dialog.getByLabel("Due date and time", { exact: true }).fill(due);
  await dialog.getByRole("textbox", { name: "Timezone", exact: true }).fill("UTC");
  await dialog.getByRole("textbox", { name: "Reminder message", exact: true }).fill(expected.message);
  await dialog.getByRole("checkbox", { name: "Cancel only after my next message commits successfully", exact: true }).uncheck();
  await dialogBounds(dialog, viewport, ["Create timer"]);
  await capture("timer-review");
  assert.equal(timerWrites().length, 0);
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && pathOf(response.url()) === route);
  await dialog.getByRole("button", { name: "Create timer", exact: true }).click();
  const created = await createResponse; assert.equal(created.status(), 201);
  const receipt = await created.json();
  await dialog.waitFor({ state: "hidden" });
  const active = (await api(route)).items.find((item) => item.timerId === receipt.item.timerId);
  assert.equal(timerWrites().length, 1);
  assertTimerMutation({ receipt, owner: active, request: timerWrites()[0].body, scope, expected });
  dialog = await open();
  const row = dialog.getByRole("region", { name: "Session timers", exact: true }).getByRole("article").filter({ hasText: expected.message });
  await row.waitFor();
  assert.ok((await row.innerText()).includes("active"));
  const cancelRoute = `${route}/${encodeURIComponent(active.timerId)}`;
  const cancelResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && pathOf(response.url()) === cancelRoute);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancelled = await cancelResponse; assert.equal(cancelled.status(), 200);
  const final = (await api(route)).items.find((item) => item.timerId === active.timerId);
  assert.equal(timerWrites().length, 2);
  assert.equal(timerWrites()[1].pathname, cancelRoute);
  assertTimerMutation({ receipt: await cancelled.json(), owner: final, request: timerWrites()[1].body, scope, expected, previous: active });
  await navigate();
  dialog = await open();
  const reloadedRow = dialog.getByRole("region", { name: "Session timers", exact: true }).getByRole("article").filter({ hasText: expected.message });
  await reloadedRow.waitFor();
  assert.ok((await reloadedRow.innerText()).includes("cancelled"));
  assert.equal(await reloadedRow.getByRole("button", { name: "Cancel", exact: true }).count(), 0);
  assert.deepEqual((await api(route)).items, [final]);
  assert.deepEqual(await api(threadRoute), before, "Timer create/cancel changed the Chat transcript.");
  assert.deepEqual(providerSnapshot(providerStub), providerBefore, "Timer lifecycle invoked the deterministic provider.");
  const modelWrites = writes.filter((write) => /\/(agent-send|send|retry|edit)(\/|$)/.test(write.pathname));
  assert.deepEqual(modelWrites, []);
  await capture("timer-cancelled-reloaded");
  return { timerId: active.timerId, workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    createRevision: active.revision, cancelRevision: final.revision, cancelledReviewWrites: 0,
    timerWrites: 2, providerDispatches: 0, newChatTurns: 0, timerDeliveryProven: false };
}

/** Uses seeded original turns; fork/edit/select and timer mutations run through browser and canonical owners. */
export async function runCockpitChatThreadActionsProof({ context, browser, stack, citadelId, viewports, deps, providerStub }) {
  const { requestJson, assertOk, runScenario, emptyArtifacts, installMissionControlNextBrowserState,
    buildVerificationUiUrl, path, relativeToRun, axeSourcePath, auditPageAccessibility } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Chat actions require an isolated verification runtime.");
  providerSnapshot(providerStub);
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, "Chat thread-action owner request"); return result.body; };
  for (const { variant, viewport } of viewports) {
    for (const [name, action] of [["thread-actions", threadActions], ["timer", timerActions]]) {
      await runScenario(context, { id: `ux-budgets.cockpit-chat-${name}.${variant}`, lane: "ux-budgets",
        title: `Cockpit Chat ${name} ${variant}`, subsystem: "mission-control-ux" }, async () => {
        const seed = await api("/api/v1/dev/verification/seed", { method: "POST", body: {
          workspaceName: `Chat ${name} ${variant}`, sessionTitle: `Chat ${name} ${variant}`, sessionCount: 1, longThreadTurns: 2,
        } });
        assert.ok(seed.workspaceId && seed.sessionId);
        const theme = variant === "mobile" ? "light" : "dark";
        const browserContext = await browser.newContext({ viewport, colorScheme: theme });
        const screenshots = [], writes = [];
        let page;
        try {
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, seed.workspaceId, citadelId);
          page = await browserContext.newPage();
          page.on("request", (request) => {
            if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathOf(request.url()).startsWith("/api/v1/")) {
              writes.push({ method: request.method(), pathname: pathOf(request.url()), body: request.postDataJSON() });
            }
          });
          const navigate = async () => {
            await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(seed.sessionId)}&shell=cockpit`), { waitUntil: "domcontentloaded" });
            await page.locator('[aria-label="Messages"]').waitFor({ timeout: 30_000 });
          };
          await navigate();
          const capture = async (stage) => {
            await page.addScriptTag({ path: axeSourcePath });
            const axe = await auditPageAccessibility(page);
            assert.deepEqual(axe.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
            const folder = path.join(context.artifactRoot, "screenshots"); await mkdir(folder, { recursive: true });
            const screenshot = path.join(folder, `ux-budgets-cockpit-chat-${name}-${variant}-${stage}.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          };
          const metrics = await action({ api, page, scope: { ...seed, variant }, writes, capture, viewport, providerStub, navigate });
          return { status: "passed", metrics: { ...metrics, blockingAxe: 0, overflow: 0 }, artifacts: emptyArtifacts({ screenshots }) };
        } catch (error) {
          if (page && !page.isClosed()) {
            const folder = path.join(context.artifactRoot, "screenshots"); await mkdir(folder, { recursive: true });
            const screenshot = path.join(folder, `ux-budgets-cockpit-chat-${name}-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          }
          return { status: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error), artifacts: emptyArtifacts({ screenshots }) };
        } finally { await browserContext.close(); }
      });
    }
  }
}
