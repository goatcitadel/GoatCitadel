import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { startBackgroundChildProvider } from "./cockpit-chat-background-fixture.mjs";
import { readConsistentBackgroundIdentity, assertBackgroundControl, assertBackgroundCancellationConflict, assertBackgroundLeaseAdvance, assertProviderBaseUrlChange } from "./cockpit-chat-background-assertions.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";

const TOKEN = "verification-ux-budgets-operator-token";
const encoded = encodeURIComponent;
const terminal = status => ["completed", "cancelled", "failed", "dead_lettered"].includes(status);
async function poll(read, accepts, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Actual local Chat admission, child stream and canonical watcher controls; no seeded execution or remote authority. */
export async function runCockpitChatBackgroundActiveProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "A disposable verification runtime is required.");
  const api = async (route, init = {}) => { const response = await requestJson(stack.gatewayUrl, route, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` },
  }); assert.ok(response.ok, `${route}: HTTP ${response.status}`); return response.body; };
  for (const { variant, viewport } of viewports) await runScenario(context, {
    id: `ux-budgets.cockpit-chat-background-active.${variant}`, lane: "ux-budgets", subsystem: "mission-control-ux",
    title: `Active local background child detach, reload, reattach and cancel ${variant}`,
  }, async () => {
    const writes = [], presence = [], observers = [], screenshots = [], controlAttempts = [], refreshReads = [];
    const scope = {}, suffix = `${variant}-${randomUUID()}`, marker = `LOCAL_CHILD_HOLD_${suffix}`;
    let fixture, configBefore, browserContext, page, acceptance, acceptSettled, watcher, result;
    let changed = false, stage = "prepare loopback provider", parent, detail, child, rail, lastControl, staleReviewEvidence;
    const readConfig = () => api("/api/v1/llm/config");
    const sessionRoute = () => `/api/v1/chat/sessions/${encoded(scope.sessionId)}`;
    const runRoute = id => `/api/v1/durable/runs/${encoded(id)}`;
    const railRoute = () => `${runRoute(scope.parentRunId)}/background-tasks?workspaceId=${encoded(scope.workspaceId)}&sessionId=${encoded(scope.sessionId)}`;
    const controlRoute = () => `${runRoute(scope.parentRunId)}/background-tasks/${encoded(watcher.watcherId)}/control`;
    const readBound = (isTerminal = false) => readConsistentBackgroundIdentity(async () => {
      const watchers = (await api(`${runRoute(scope.parentRunId)}/child-watchers`)).items;
      assert.equal(watchers.length, 1); watcher = watchers[0];
      detail = await api(`${sessionRoute()}/delegations/${encoded(watcher.metadata.delegationRunId)}`);
      child = await api(runRoute(watcher.childRunId)); rail = await api(railRoute());
      return { scope, parent, watcher, detail, child, rail, terminal: isTerminal };
    });
    try {
      configBefore = await readConfig();
      const providerId = configBefore.activeProviderId, model = configBefore.activeModel;
      const profile = configBefore.providerConfigs.find(item => item.providerId === providerId);
      assert.equal(providerId, "verification-stub"); assert.equal(profile.apiStyle, "openai-chat-completions");
      assert.equal(new URL(profile.baseUrl).hostname, "127.0.0.1");
      fixture = await startBackgroundChildProvider({ marker, model });
      changed = true;
      const configReceipt = await api("/api/v1/llm/config", { method: "PATCH", body: {
        expectedRevision: configBefore.revision, upsertProvider: { providerId, baseUrl: fixture.baseUrl },
      } });
      assertProviderBaseUrlChange({ before: configBefore, receipt: configReceipt, after: await readConfig(), providerId, baseUrl: fixture.baseUrl });
      const workspace = await api("/api/v1/workspaces", { method: "POST", body: {
        citadelId, name: `Background proof ${suffix}`, slug: `background-${suffix}`,
      } });
      scope.workspaceId = workspace.workspaceId; assert.equal(workspace.citadelId, citadelId);
      const session = await api("/api/v1/chat/sessions", { method: "POST", body: {
        workspaceId: scope.workspaceId, citadelId, title: `Active background ${variant}`,
      } });
      scope.sessionId = session.sessionId; assert.equal(session.workspaceId, scope.workspaceId);
      stage = "complete actual parent Chat stream";
      const content = "Reply PARENT_BACKGROUND_READY. Do not use tools.";
      const preflight = await api(`${sessionRoute()}/route-preflight`, { method: "POST", body: {
        action: "send", content, subagentPolicy: "off", webMode: "off", memoryMode: "off",
      } });
      assert.equal(preflight.blockedReason, undefined);
      assert.equal(preflight.decision.effectiveProviderId, providerId); assert.equal(preflight.decision.effectiveModel, model);
      await api(`${sessionRoute()}/agent-send/stream`, { method: "POST", body: {
        content, providerId, model, routeDecision: preflight.decision, subagentPolicy: "off", webMode: "off", memoryMode: "off",
      } });
      const parentThread = await api(`${sessionRoute()}/thread`);
      assert.equal(parentThread.turns.length, 1);
      const parentTurn = parentThread.turns[0]; assert.equal(parentTurn.trace.status, "completed");
      scope.parentRunId = parentTurn.trace.durable.runId; parent = await api(runRoute(scope.parentRunId));
      assert.equal(fixture.counts().streams, 1);
      stage = "admit one real local child";
      const input = { objective: `${marker}: produce one short analysis without tools.`, roles: ["Researcher"], mode: "sequential" };
      const suggestion = await api(`${sessionRoute()}/delegate/suggest`, { method: "POST", body: input });
      assert.equal(suggestion.suggestion.sessionId, scope.sessionId);
      acceptance = api(`${sessionRoute()}/delegate/accept`, { method: "POST", body: {
        ...input, suggestionId: suggestion.suggestion.suggestionId, policyRunId: scope.parentRunId, providerId, model,
      } }).then(value => { acceptSettled = { value }; }, error => { acceptSettled = { error }; });
      await poll(async () => {
        const items = (await api(`${runRoute(scope.parentRunId)}/child-watchers`)).items;
        if (items.length === 1) watcher = items[0];
        if (acceptSettled?.error) throw acceptSettled.error;
        return items;
      }, items => items.length === 1 && fixture.counts().childStreams === 1, "exact live child stream and watcher");
      let current = await readBound();
      assert.equal(current.controls.detach.enabled, true); assert.equal(current.controls.cancel.enabled, true);
      const activeIdentity = { watcherId: watcher.watcherId, childRunId: child.runId, stepId: detail.steps[0].stepId,
        childSessionId: child.payload.sessionId, childTurnId: child.payload.turnId, delegationRunId: detail.run.runId };
      const streamsBeforeControls = fixture.counts().streams;
      const prefsBefore = await api(`${sessionRoute()}/prefs`);
      const observerScope = { sessionId: scope.sessionId, prefsOverride: {
        mode: "chat", providerId, model, webMode: "off", memoryMode: "off", thinkingLevel: "standard", speedMode: "standard", subagentPolicy: "off",
      } };
      const theme = variant === "mobile" ? "light" : "dark";
      browserContext = await browser.newContext({ viewport, colorScheme: theme });
      await browserContext.addInitScript(({ theme, token }) => {
        window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "session");
        window.sessionStorage.setItem("goatcitadel.gateway.auth", JSON.stringify({ mode: "token", token }));
      }, { theme, token: TOKEN });
      await installMissionControlNextBrowserState(browserContext, scope.workspaceId, citadelId);
      page = await browserContext.newPage();
      page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
        if (recordCockpitObserverRequest(request, observers, observerScope)) return;
        const entry = { method: request.method(), pathname, body: request.postDataJSON() };
        if (entry.method === "PUT" && pathname === "/api/v1/notifications/presence") {
          entry.completed = request.response().then(async response => { assert.ok(response);
            entry.status = response.status(); entry.receipt = await response.json(); }).catch(error => { entry.error = error; });
          presence.push(entry);
        } else writes.push(entry);
      });
      const href = buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encoded(scope.sessionId)}&shell=cockpit`);
      const openBackground = async () => {
        await page.locator('[aria-label="Messages"]').waitFor({ timeout: 30_000 });
        if (variant === "mobile") {
          await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
          await page.getByRole("menuitem", { name: "Inspect conversation", exact: true }).click();
        } else await page.getByRole("button", { name: "Inspect", exact: true }).click();
        await page.getByRole("tab", { name: "Background", exact: true }).click();
        await page.getByRole("region", { name: "Background work", exact: true }).getByRole("heading", { name: current.label, exact: true }).waitFor();
      };
      const section = () => page.getByRole("region", { name: "Background work", exact: true });
      const capture = async name => {
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        assert.deepEqual(axe.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const folder = path.join(context.artifactRoot, "screenshots"); await mkdir(folder, { recursive: true });
        const screenshot = path.join(folder, `ux-budgets-cockpit-chat-background-active-${variant}-${name}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      };
      const control = async (action, click, reviewed) => {
        const before = reviewed ?? await readBound();
        const [response] = await Promise.all([page.waitForResponse(response => response.request().method() === "POST"
          && new URL(response.url()).pathname === controlRoute()), click()]);
        // Persist the exact owner response before any assertion can reject it.
        lastControl = { before, status: response.status(), request: response.request().postDataJSON(), action, scope };
        controlAttempts.push(lastControl);
        lastControl.receipt = await response.json();
        if (lastControl.status !== 200) {
          current = await readBound(); lastControl.after = current;
          assertBackgroundCancellationConflict(lastControl);
          return false;
        }
        current = await readBound(action === "cancel");
        lastControl.after = current;
        assertBackgroundControl(lastControl);
        return true;
      };
      stage = "detach then reload canonical background work";
      await page.goto(href, { waitUntil: "domcontentloaded" }); await openBackground(); await capture("active");
      assert.equal(await control("detach", () => section().getByRole("button", { name: "Continue in background", exact: true }).click()), true);
      await page.reload({ waitUntil: "domcontentloaded" }); await openBackground();
      await section().getByRole("button", { name: "Bring to foreground", exact: true }).waitFor();
      current = await readBound(); assert.equal(current.watcherState, "detached");
      assert.equal(current.watcherId, activeIdentity.watcherId); assert.equal(current.childRunId, activeIdentity.childRunId);
      assert.equal(fixture.counts().childStreams, 1); assert.equal(fixture.counts().streams, streamsBeforeControls);
      await capture("detached-reloaded");
      stage = "reattach same child and cancel review without a write";
      assert.equal(await control("reattach", () => section().getByRole("button", { name: "Bring to foreground", exact: true }).click()), true);
      await section().getByRole("button", { name: "Cancel child", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Cancel this child run?", exact: true });
      await dialog.waitFor();
      assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons: {
        keep: await dialog.getByRole("button", { name: "Keep running", exact: true }).boundingBox(),
        cancel: await dialog.getByRole("button", { name: "Cancel child", exact: true }).boundingBox(),
      } });
      await capture("cancel-review");
      assert.equal(writes.length, 2);
      await dialog.getByRole("button", { name: "Keep running", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(writes.length, 2); await readBound(); assert.equal(fixture.counts().held, 1);
      const readReviewed = async () => {
        // The response may belong to a concurrently finishing poll. Bind the
        // actual frozen dialog versions, not that transport, to the live owner.
        const shown = /Child version (\d+) · Watcher revision (\d+)/.exec(await dialog.innerText());
        assert.ok(shown, "The review must show its exact child and watcher versions.");
        current = await readBound();
        const reviewed = { ...current, watcherRevision: Number(shown[2]), childVersion: Number(shown[1]) };
        assert.equal(reviewed.watcherRevision, current.watcherRevision);
        assert.ok(reviewed.childVersion <= current.childVersion);
        return reviewed;
      };
      const confirmReviewed = async (reviewed) => {
        const originalWrites = writes.length;
        // A concurrent poll can prove the frozen review stale before dispatch. Record
        // that zero-write refusal separately; it is not an HTTP acknowledgement.
        let response;
        const observe = item => { if (item.request().method() === "POST" && new URL(item.url()).pathname === controlRoute()) response = item; };
        page.on("response", observe);
        try {
          await dialog.getByRole("button", { name: "Cancel child", exact: true }).click();
          await poll(async () => response || (await dialog.getByRole("alert").allTextContents()).some(text => text.includes("changed before")), Boolean, "explicit cancellation outcome");
          if (response) {
            lastControl = { before: reviewed, status: response.status(), request: response.request().postDataJSON(), action: "cancel", scope };
            controlAttempts.push(lastControl); lastControl.receipt = await response.json();
            current = await readBound(response.status() === 200); lastControl.after = current;
            if (response.status() === 200) { assertBackgroundControl(lastControl); return true; }
            assertBackgroundCancellationConflict(lastControl);
          } else {
            assert.equal(writes.length, originalWrites);
            current = await readBound();
            assert.equal(current.watcherRevision, reviewed.watcherRevision);
            assert.ok(current.childVersion > reviewed.childVersion);
            controlAttempts.push({ before: reviewed, after: current, status: null, action: "cancel", outcome: "locally_withheld_stale_review", writes: 0 });
          }
        } finally { page.off("response", observe); }
        return false;
      };
      const closeRejectedReview = async (name) => {
        await dialog.getByRole("alert").filter({ hasText: "Close this review" }).waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Cancel child", exact: true }).isDisabled(), true);
        await capture(name);
        await dialog.getByRole("button", { name: "Keep running", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
        assert.equal(fixture.counts().childStreams, 1); assert.equal(fixture.counts().held, 1);
      };
      stage = "real lease advancement invalidates an explicit cancellation review";
      await section().getByRole("button", { name: "Cancel child", exact: true }).click(); await dialog.waitFor();
      const staleReview = await readReviewed();
      const leaseBefore = await api(runRoute(activeIdentity.childRunId));
      const leaseAfter = await poll(() => api(runRoute(activeIdentity.childRunId)), run =>
        run.status === "running" && run.version > leaseBefore.version && Date.parse(run.leaseHeartbeatAt) > Date.parse(leaseBefore.leaseHeartbeatAt),
      "actual child lease heartbeat advances while review remains open");
      current = await readBound();
      staleReviewEvidence = { reviewed: staleReview, before: leaseBefore, after: leaseAfter, current, providerCounts: fixture.counts() };
      assertBackgroundLeaseAdvance(staleReviewEvidence);
      assert.equal(await confirmReviewed(staleReview), false, "The original reviewed version must not cancel the advanced owner.");
      assert.equal(controlAttempts.filter(item => item.status === 200).length, 2);
      await closeRejectedReview("cancel-stale-review");

      stage = "confirmed cancellation and executor settlement";
      let cancelled = false;
      for (let reviewIndex = 0; reviewIndex < 3 && !cancelled; reviewIndex += 1) {
        // A new explicit Refresh and review, never a replay of the old confirmation.
        const [freshResponse] = await Promise.all([page.waitForResponse(response => response.request().method() === "GET"
          && new URL(response.url()).pathname === `${runRoute(scope.parentRunId)}/background-tasks`),
        section().getByRole("button", { name: "Refresh", exact: true }).click()]);
        const observedRead = { status: freshResponse.status(), url: freshResponse.url(), method: freshResponse.request().method() };
        refreshReads.push(observedRead);
        observedRead.body = await freshResponse.json();
        assert.equal(observedRead.status, 200);
        const freshRail = observedRead.body;
        assert.deepEqual(freshRail.scope, { workspaceId: scope.workspaceId, sessionId: scope.sessionId, verified: true });
        assert.equal(freshRail.tasks[0].watcherId, activeIdentity.watcherId); assert.equal(freshRail.tasks[0].childRunId, activeIdentity.childRunId);
        await section().getByRole("button", { name: "Cancel child", exact: true }).click(); await dialog.waitFor();
        cancelled = await confirmReviewed(await readReviewed());
        if (!cancelled) {
          await closeRejectedReview(`cancel-conflict-${reviewIndex}`);
        }
      }
      assert.equal(cancelled, true, "Cancellation never received an applied canonical receipt after bounded fresh reviews.");
      await poll(() => Promise.resolve(fixture.counts()), counts => counts.held === 0 && counts.childClosed === 1, "cancelled executor closes child stream");
      await poll(() => Promise.resolve(acceptSettled), Boolean, "delegation acceptance settlement");
      await acceptance;
      if (acceptSettled.error) throw acceptSettled.error;
      assert.equal(acceptSettled.value.runId, activeIdentity.delegationRunId);
      current = await readBound(true);
      assert.equal(child.lastError, `cancelled by background-task-rail:${child.payload.requestActor.actorId}`);
      assert.equal(fixture.counts().childStreams, 1); assert.equal(fixture.counts().streams, streamsBeforeControls);
      const applied = controlAttempts.filter(item => item.status === 200);
      assert.deepEqual(applied.map(item => item.action), ["detach", "reattach", "cancel"]);
      assert.deepEqual(writes.map(({ method, pathname, body }) => ({ method, pathname, body })),
        controlAttempts.filter(item => item.status !== null).map(item => ({ method: "POST", pathname: controlRoute(), body: item.request })));
      await dialog.waitFor({ state: "hidden" }); await capture("cancelled");
      const expectedPresence = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
        clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
      await Promise.all(presence.map(item => item.completed));
      for (const item of presence) { if (item.error) throw item.error; assertCitadelPresenceHeartbeat(item, expectedPresence); }
      await assertCockpitObserverRequests(observers);
      assert.deepEqual(await api(`${sessionRoute()}/prefs`), prefsBefore, "Background inspection changed saved Chat preferences.");
      const controlsPath = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-background-active-${variant}-controls.json`);
      await mkdir(path.dirname(controlsPath), { recursive: true });
      await writeFile(controlsPath, `${JSON.stringify({ scope, controlAttempts, refreshReads, staleReviewEvidence, providerCounts: fixture.counts() }, null, 2)}\n`);
      result = { status: "passed", metrics: { ...scope, ...activeIdentity, actualLocalAdmission: true, seededExecution: false,
        childProviderStreams: 1, reviewCancelWrites: 0, controlWrites: writes.length, appliedControls: 3,
        realLeaseStaleReviewObserved: true,
        precommitConflicts: controlAttempts.filter(item => item.status === 409).length,
        locallyWithheldReviews: controlAttempts.filter(item => item.status === null).length, executorCancellationObserved: true,
        profileFreeLocalOnly: true, observerRequests: observers.length, blockingAxe: 0, overflow: 0 },
        artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, controlsPath)] }) };
    } catch (error) {
      if (page && !page.isClosed()) {
        const folder = path.join(context.artifactRoot, "screenshots"); await mkdir(folder, { recursive: true });
        const screenshot = path.join(folder, `ux-budgets-cockpit-chat-background-active-${variant}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      }
      const diagnosticPath = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-background-active-${variant}-failure.json`);
      await mkdir(path.dirname(diagnosticPath), { recursive: true });
      await writeFile(diagnosticPath, `${JSON.stringify({ stage, writes, lastControl, controlAttempts, refreshReads, staleReviewEvidence, parent, watcher, detail, child, rail, providerCounts: fixture?.counts(),
        error: String(error?.stack ?? error) }, null, 2)}\n`);
      result = { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack : String(error)}`,
        artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnosticPath)] }) };
    } finally {
      const failures = [];
      try {
        if (scope.parentRunId) {
          const remaining = await api(railRoute());
          for (const task of remaining.tasks) if (!terminal(task.canonicalStatus)) {
            assert.equal(task.delegationRunId, watcher?.metadata.delegationRunId);
            await api(`${runRoute(scope.parentRunId)}/background-tasks/${encoded(task.watcherId)}/control`, { method: "POST", body: {
              workspaceId: scope.workspaceId, sessionId: scope.sessionId, action: "cancel",
              expectedWatcherRevision: task.watcherRevision, expectedChildVersion: task.childVersion, reason: "Task-owned verification cleanup",
            } });
          }
        }
      } catch (error) { failures.push(`child cleanup: ${error.message}`); }
      await fixture?.close();
      if (acceptance) {
        try { await poll(() => Promise.resolve(acceptSettled), Boolean, "owned acceptance cleanup", 10_000); }
        catch (error) { failures.push(error.message); }
      }
      try {
        if (changed) {
          const before = await readConfig(), providerId = configBefore.activeProviderId;
          const current = before.providerConfigs.find(item => item.providerId === providerId);
          const original = configBefore.providerConfigs.find(item => item.providerId === providerId);
          if (current.baseUrl !== original.baseUrl) {
            assert.deepEqual(current, { ...original, baseUrl: fixture.baseUrl }, "Refusing to overwrite a foreign provider change.");
            const receipt = await api("/api/v1/llm/config", { method: "PATCH", body: {
              expectedRevision: before.revision, upsertProvider: { providerId, baseUrl: original.baseUrl },
            } });
            assertProviderBaseUrlChange({ before, receipt, after: await readConfig(), providerId, baseUrl: original.baseUrl });
          }
        }
      } catch (error) { failures.push(`provider restoration: ${error.message}`); }
      await browserContext?.close();
      if (failures.length) result = { ...result, status: "failed", error: `${result?.error ?? ""}\n${failures.join("\n")}` };
    }
    return result;
  });
}
