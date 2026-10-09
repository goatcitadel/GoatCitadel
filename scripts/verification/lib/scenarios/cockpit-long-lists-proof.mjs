import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { LONG_LIST_COUNT, assertExactRecords, seedLongListFixture, readLongListOwners, retireLongListFixture } from "./cockpit-long-list-fixture.mjs";
import { assertProjectReadRequests } from "./cockpit-chat-project-proof.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";
import { inboxOwnerHref } from "./classic-owner-navigation.mjs";

export function assertWindowedRecords({ total, rendered, keys, expectedKeys }) {
  assert.ok(total > 100); assert.equal(total, expectedKeys.length); assert.equal(new Set(expectedKeys).size, expectedKeys.length);
  assert.ok(rendered > 0 && rendered < 100);
  assert.equal(keys.length, rendered); assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every(key => expectedKeys.includes(key)));
}
export async function runCockpitLongListsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, assertOk, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState, auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  let fixture;
  try { fixture = await seedLongListFixture({ stack, citadelId, api }); }
  catch (error) {
    for (const { variant } of viewports) await runScenario(context, { id: "ux-budgets.cockpit-long-lists." + variant, lane: "ux-budgets", subsystem: "mission-control-ux", title: "Windowed canonical records " + variant }, async () => ({ status: "failed", error: "Owned fixture setup: " + (error?.stack ?? error), artifacts: emptyArtifacts() }));
    return;
  }
  let retired = false;
  const workspaceId = fixture.workspace.workspaceId, sessionId = fixture.sessions[0].sessionId;
  try {
    for (const [viewportIndex, { variant, viewport }] of viewports.entries()) await runScenario(context, { id: "ux-budgets.cockpit-long-lists." + variant, lane: "ux-budgets", subsystem: "mission-control-ux", title: "Windowed canonical records and scoped source context " + variant }, async () => {
      const screenshots = [], writes = [], presence = [], observers = [], statusIds = [], routingReads = [];
      const prefs = await api("/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/prefs");
      let page, browserContext, outcome, stage = "open scoped Inbox";
      try {
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          const match = /^\/api\/v1\/chat\/sessions\/([^/]+)\/status$/u.exec(pathname);
          if (match && request.method() === "GET") statusIds.push(decodeURIComponent(match[1]));
          if (!pathname.startsWith("/api/v1/") || !["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) return;
          if (recordCockpitObserverRequest(request, observers)) return;
          if (request.method() === "POST" && pathname === "/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/route-preflight") { routingReads.push({ method: request.method(), path: pathname, body: request.postDataJSON() }); return; }
          const entry = { method: request.method(), pathname, body: request.postDataJSON() };
          if (pathname === "/api/v1/notifications/presence") {
            entry.completed = request.response().then(async response => { assert.ok(response); entry.status = response.status(); entry.receipt = await response.json(); }).catch(error => { entry.error = error; }); presence.push(entry);
          } else writes.push(entry);
        });
        await page.route("**/api/v1/**", route => {
          const request = route.request(), pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && !["/api/v1/auth/sse-token", "/api/v1/notifications/presence", "/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/route-preflight"].includes(pathname)) return route.abort("failed");
          return route.continue();
        });
        await open("/inbox?shell=cockpit");
        const inboxBefore = await api("/api/v1/inbox?workspaceId=" + encodeURIComponent(workspaceId));
        const decisions = inboxBefore.items.filter(item => item.group === "needs_decision");
        assert.ok(decisions.length > 100);
        const list = page.getByRole("list", { name: "Needs decision", exact: true });
        await verifyWindow(list, decisions.map(item => item.id));
        const realm = await page.evaluate(() => performance.timeOrigin);
        await list.getByRole("button", { name: "Details", exact: true }).first().focus();
        for (const decision of decisions) {
          await page.keyboard.press("j");
          await page.waitForFunction(id => document.querySelector('[data-inbox-item][data-selected="true"] [data-record-key]')?.getAttribute("data-record-key") === id, decision.id);
        }
        await page.keyboard.press("e");
        const ownerHref = inboxOwnerHref(decisions.at(-1).href);
        await page.waitForFunction(href => document.activeElement?.getAttribute("href") === href, ownerHref);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), ownerHref);
        const last = page.locator('[data-inbox-item][data-selected="true"]');
        await last.getByRole("button", { name: "Show source context", exact: true }).click();
        const contextRegion = last.getByRole("region", { name: "Source conversation context" });
        const canonicalMessages = await api("/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/messages?limit=1");
        assert.equal(canonicalMessages.items.length, 1); assert.equal(canonicalMessages.items[0].sessionId, sessionId);
        await contextRegion.getByText(canonicalMessages.items[0].content.slice(0, 800), { exact: true }).waitFor();
        assert.ok((await api("/api/v1/chat/sessions/" + encodeURIComponent(sessionId) + "/status")).workspaceId === workspaceId);
        assert.deepEqual((await api("/api/v1/inbox?workspaceId=" + encodeURIComponent(workspaceId))).counts, inboxBefore.counts);
        assert.equal(await page.evaluate(() => performance.timeOrigin), realm);
        await capture("inbox");

        stage = "window task cards without creating or running work";
        await open("/work?shell=cockpit");
        await verifyWindow(page.getByRole("list", { name: "Waiting records", exact: true }), fixture.tasks.map(item => "task:" + item.taskId));
        await capture("tasks");
        stage = "window canonical saved history pages";
        await open("/work/history?shell=cockpit");
        await page.getByRole("button", { name: "Load older runs", exact: true }).click();
        await page.getByText("105 saved runs loaded.", { exact: false }).waitFor();
        await verifyWindow(page.getByRole("list", { name: "Durable run history", exact: true }), fixture.runs.map(item => item.runId));
        const history = page.getByRole("list", { name: "Conversations and activity", exact: true });
        const historyTotal = Number(await history.locator("li[aria-setsize]").first().getAttribute("aria-setsize"));
        assert.ok(historyTotal > 100, "Actual scoped conversation/event owner window must exceed 100.");
        assert.ok(await history.locator("li").count() < 100);
        await capture("history");
        stage = "window stored prompt-pack definitions without evaluation";
        await open("/system/quality?shell=cockpit");
        const snapshot = await api("/api/v1/ops/quality?packLimit=200&evalLimit=25");
        assert.ok(snapshot.promptPacks.items.length >= LONG_LIST_COUNT);
        await verifyWindow(page.getByRole("list", { name: "Prompt pack definitions", exact: true }), snapshot.promptPacks.items.map(item => item.packId));
        await capture("quality");
        stage = "bounded canonical conversation activity";
        statusIds.length = 0;
        await open("/chat?sessionId=" + encodeURIComponent(sessionId) + "&shell=cockpit");
        if (variant === "mobile") {
          const picker = page.getByRole("combobox", { name: "Choose conversation", exact: true });
          await picker.selectOption("history:load-more");
          await page.waitForFunction(ids => {
            const values = [...document.querySelectorAll('[aria-label="Choose conversation"] option')].map(option => option.value);
            return ids.every(id => values.includes(id));
          }, fixture.sessions.map(item => item.sessionId));
          assert.equal(await picker.inputValue(), sessionId);
          await page.getByLabel("Selected conversation activity").getByText("Last response completed", { exact: true }).waitFor();
          assert.ok(new Set(statusIds).size <= 1);
        } else {
          await page.getByRole("button", { name: "Load more", exact: true }).click();
          const threads = page.getByRole("list", { name: "Recent conversations", exact: true });
          await page.waitForFunction(() => document.querySelector('[aria-label="Recent conversations"] li')?.getAttribute("aria-setsize") === "105");
          await verifyWindow(threads, fixture.sessions.map(item => item.sessionId));
          assert.ok(new Set(statusIds).size <= 49, "Initial and appended owner windows plus selected session must not read all history.");
          await threads.getByRole("button").first().focus(); await page.keyboard.press("End");
          await page.waitForFunction(() => document.activeElement?.closest("li")?.getAttribute("aria-posinset") === "105");
          assert.equal(await page.evaluate(() => document.activeElement?.closest("li")?.getAttribute("aria-posinset")), "105");
          const endId = await page.evaluate(() => document.activeElement?.closest("[data-record-key]")?.getAttribute("data-record-key"));
          assert.ok(fixture.sessions.some(item => item.sessionId === endId));
          await threads.locator('li[aria-posinset="105"]').getByText(endId === sessionId ? "Last response completed" : "No messages yet", { exact: true }).waitFor();
          assert.ok(new Set(statusIds).size <= 73, "Settled initial/page/end windows plus selected session must stay within3*24+1 unique IDs.");
        }
        await capture("threads");
        const after = await readLongListOwners(fixture, api);
        for (const [family, key] of [["tasks", "taskId"], ["sessions", "sessionId"], ["approvals", "approvalId"], ["packs", "packId"], ["runs", "runId"]]) assertExactRecords(fixture.owner[family], after[family], key);
        assert.ok(new Set(statusIds).size <= (variant === "mobile" ? 1 : 73));
        assert.deepEqual(writes, []); assertProjectReadRequests(routingReads, { [sessionId]: prefs }); await assertCockpitObserverRequests(observers);
        const presenceIdentity = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"), clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
        await Promise.all(presence.map(entry => entry.completed));
        for (const entry of presence) { if (entry.error) throw entry.error; assertCitadelPresenceHeartbeat(entry, presenceIdentity); }
        outcome = { status: "passed", artifacts: emptyArtifacts({ screenshots }), metrics: { recordsPerFamily: LONG_LIST_COUNT, domainMutations: writes.length, uniqueStatusReads: new Set(statusIds).size, statusReadIdBound: variant === "mobile" ? 1 : 73, boundary: fixture.boundary } };
      } catch (error) {
        let screenshotError = "";
        if (page) { try { await capture("failure", false); } catch (captureError) { screenshotError = "; Screenshot unavailable: " + String(captureError); } }
        outcome = { status: "failed", error: stage + ": " + (error?.stack ?? error) + screenshotError, artifacts: emptyArtifacts({ screenshots }) };
      } finally {
        try { await browserContext?.close(); } catch (error) { failCleanup("Browser context close", error); }
        if (viewportIndex === viewports.length - 1) {
          retired = true;
          try { await retireLongListFixture(fixture, api); } catch (error) { failCleanup("Owned fixture cleanup", error); }
        }
      }
      return outcome;
      function failCleanup(label, error) {
        outcome = { ...outcome, status: "failed", error: [outcome?.error, label + ": " + (error?.stack ?? error)].filter(Boolean).join("\n"), artifacts: outcome?.artifacts ?? emptyArtifacts({ screenshots }) };
      }
      async function open(href) { await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30000 }); }
      async function verifyWindow(list, expectedKeys) {
        await list.locator("li[aria-setsize]").first().waitFor();
        const rows = await list.locator("li[aria-setsize]").evaluateAll(items => items.map(item => ({ total: Number(item.getAttribute("aria-setsize")), key: item.querySelector("[data-record-key]")?.getAttribute("data-record-key") })));
        assertWindowedRecords({ total: rows[0].total, rendered: rows.length, keys: rows.map(item => item.key), expectedKeys });
      }
      async function capture(label, audit = true) {
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page); assert.deepEqual(result.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true }); const file = path.join(directory, "cockpit-long-lists-" + variant + "-" + label + ".png"); await page.screenshot({ path: file }); screenshots.push(relativeToRun(context, file));
      }
    });
  } finally { if (!retired) await retireLongListFixture(fixture, api); }
}
