import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { clickClassicOwnerNavigation } from "./classic-owner-navigation.mjs";

export function assertCouncilMutationOwner({ before, request, receipt, owner, agentId, remove = false }) {
  assert.deepEqual(request, remove ? { expectedRevision: before.revision } : { agentId, expectedRevision: before.revision });
  assert.deepEqual(receipt, owner);
  assert.equal(owner.citadelId, before.citadelId);
  assert.notEqual(owner.revision, before.revision);
  const rest = value => { const { revision: _revision, council: _council, ...unchanged } = value; return unchanged; };
  assert.deepEqual(rest(owner), rest(before));
  if (remove) {
    assert.ok(before.council.some(item => item.agentId === agentId));
    assert.deepEqual(owner.council, before.council.filter(item => item.agentId !== agentId));
    return;
  }
  assert.equal(before.council.some(item => item.agentId === agentId), false);
  const created = owner.council.filter(item => !before.council.some(prior => prior.assignmentId === item.assignmentId));
  assert.equal(created.length, 1);
  assert.equal(created[0].citadelId, before.citadelId); assert.equal(created[0].agentId, agentId);
  assert.ok(created[0].assignmentId); assert.ok(Number.isFinite(Date.parse(created[0].createdAt)));
  assert.equal(owner.council.length, before.council.length + 1);
  for (const seat of before.council) assert.deepEqual(owner.council.find(item => item.assignmentId === seat.assignmentId), seat);
}

/** Uses existing active profile references in a new disposable Citadel. Never starts or edits agents. */
export async function runCockpitCitadelCouncilProof({ context, browser, stack, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Council proof needs a disposable runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init); assert.ok(response.ok, `${route}: ${response.status}`); return response.body;
  };
  for (const { variant, viewport } of viewports) await runScenario(context, {
    id: `ux-budgets.cockpit-citadel-council.${variant}`, lane: "ux-budgets",
    title: `Native reviewed Council references and retained access lock ${variant}`, subsystem: "mission-control-ux",
  }, async () => {
    const writes = [], presence = [], screenshots = [];
    let stage = "prepare isolated Council owner", page, browserContext, panel, navigations = 0;
    const screenshotDir = path.join(context.artifactRoot, "screenshots");
    try {
      const suffix = `${variant}-${randomUUID().slice(0, 8)}`, citadelId = `ux-council-${suffix}`;
      const prior = (await api("/api/v1/citadels?view=all&limit=500")).items;
      const profiles = (await api("/api/v1/agents?view=active&limit=300")).items;
      assert.ok(profiles.length > 0, "The canonical active catalog must supply an existing profile.");
      const profile = profiles[0]; assert.equal(profile.lifecycleStatus, "active"); assert.ok(profile.agentId && profile.name);
      const record = await api("/api/v1/citadels", { method: "POST", body: { name: `Council ${suffix}`, slug: citadelId, kind: "team" } });
      assert.equal(record.citadelId, citadelId);
      const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId, name: `Council workspace ${suffix}` } });
      const ownerPath = `/api/v1/citadels/${encodeURIComponent(citadelId)}`, seatPath = `${ownerPath}/council`;
      const read = () => api(`${ownerPath}/access`), initial = await read();
      const theme = variant === "mobile" ? "light" : "dark";
      browserContext = await browser.newContext({ viewport, colorScheme: theme });
      await browserContext.addInitScript(value => {
        window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
      }, theme);
      await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, citadelId);
      page = await browserContext.newPage();
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
        const pathname = new URL(request.url()).pathname;
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) {
          const entry = { method: request.method(), pathname, body: request.postDataJSON() };
          if (entry.method === "PUT" && pathname === "/api/v1/notifications/presence") {
            entry.completed = request.response().then(async response => {
              assert.ok(response); entry.status = response.status(); entry.receipt = await response.json();
            }).catch(error => { entry.error = error; });
            presence.push(entry);
          } else writes.push(entry);
        }
      });
      // Unexpected agent/runtime dispatch is blocked before forwarding and fails the exact mutation assertion.
      await page.route("**/api/v1/agents/**", route => ["POST", "PATCH", "PUT", "DELETE"].includes(route.request().method()) ? route.abort("failed") : route.continue());
      await page.route("**/api/v1/chat/**/agent-send", route => route.abort("failed"));
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-council"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
      panel = page.getByRole("region", { name: "Citadel Council", exact: true });
      const selection = () => page.evaluate(() => ({ citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"), workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") }));
      const initialSelection = await selection();
      const manage = panel.locator("summary").filter({ hasText: /^Manage Council seats$/ });
      await manage.click(); await panel.getByRole("combobox", { name: "Council agent", exact: true }).selectOption(profile.agentId);
      const assign = page.getByRole("dialog", { name: "Seat this agent?", exact: true });
      const removal = page.getByRole("dialog", { name: "Remove Council seat?", exact: true });
      const replyFor = async (method, pathname, action) => {
        const [response] = await Promise.all([page.waitForResponse(reply => reply.request().method() === method && new URL(reply.url()).pathname === pathname), action()]);
        assert.ok(response.ok(), `${pathname}: ${response.status()}`); return { receipt: await response.json(), request: response.request().postDataJSON() };
      };
      stage = "review and cancel an existing profile reference without a write";
      await panel.getByRole("button", { name: "Review Council seat", exact: true }).click();
      await assign.waitFor(); assert.match(await assign.innerText(), /No agent is started/); assert.ok((await assign.innerText()).includes(profile.name));
      await capture("seat-review", assign, ["Confirm Council seat", "Cancel"]);
      await assign.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(writes.length, 0); assert.deepEqual(await read(), initial);

      stage = "reject stale access review before Council dispatch";
      await panel.getByRole("button", { name: "Review Council seat", exact: true }).click();
      const peer = await api(`${ownerPath}/wards`, { method: "POST", body: { name: `Peer deny ${suffix}`, actionPattern: "ux.council.*", effect: "deny", expectedRevision: initial.revision } });
      await assign.getByRole("button", { name: "Confirm Council seat", exact: true }).click(); await assign.waitFor({ state: "hidden" });
      await panel.getByRole("button", { name: "Use current access review", exact: true }).waitFor();
      assert.equal(writes.length, 0); assert.deepEqual(await read(), peer);
      await panel.getByRole("button", { name: "Use current access review", exact: true }).click();

      stage = "seat exact existing agent with CAS and independent readback";
      await panel.getByRole("button", { name: "Review Council seat", exact: true }).click();
      const saved = await replyFor("POST", seatPath, () => assign.getByRole("button", { name: "Confirm Council seat", exact: true }).click());
      await panel.getByText("Agent seated in this Citadel.", { exact: true }).waitFor();
      const afterAdd = await read(); assertCouncilMutationOwner({ before: peer, agentId: profile.agentId, ...saved, owner: afterAdd });
      await panel.getByRole("button", { name: `Inspect ${profile.name}`, exact: true }).waitFor();
      await capture("seated");

      stage = "cancel then confirm reference removal without deleting agent profile";
      await panel.getByRole("button", { name: "Review seat removal", exact: true }).click();
      await removal.waitFor(); assert.match(await removal.innerText(), /agent profile remains available/);
      await capture("remove-review", removal, ["Remove seat", "Cancel"]);
      await removal.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(writes.filter(item => item.method === "DELETE").length, 0); assert.deepEqual(await read(), afterAdd);
      await panel.getByRole("button", { name: "Review seat removal", exact: true }).click();
      const removed = await replyFor("DELETE", `${seatPath}/${encodeURIComponent(profile.agentId)}`, () => removal.getByRole("button", { name: "Remove seat", exact: true }).click());
      await panel.getByText("Agent removed from this Citadel Council.", { exact: true }).waitFor();
      const afterRemove = await read(); assertCouncilMutationOwner({ before: afterAdd, agentId: profile.agentId, remove: true, ...removed, owner: afterRemove });

      stage = "retain actual committed-response uncertainty across native remount";
      await panel.getByRole("combobox", { name: "Council agent", exact: true }).selectOption(profile.agentId);
      await panel.getByRole("button", { name: "Review Council seat", exact: true }).click();
      let lostReceipt, lostRequest;
      const lose = async route => {
        if (route.request().method() !== "POST") return route.continue();
        lostRequest = route.request().postDataJSON(); const response = await route.fetch(); assert.ok(response.ok());
        lostReceipt = await response.json(); await route.abort("failed");
      };
      await page.route(`**${seatPath}`, lose);
      await assign.getByRole("button", { name: "Confirm Council seat", exact: true }).click();
      await assign.waitFor({ state: "hidden" }); await panel.getByText(/^Citadel access outcome is unconfirmed/).waitFor();
      await page.unroute(`**${seatPath}`, lose);
      const committedUnknown = await read();
      assertCouncilMutationOwner({ before: afterRemove, agentId: profile.agentId, request: lostRequest, receipt: lostReceipt, owner: committedUnknown });
      const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
      await nav.getByRole("link", { name: "General", exact: true }).click(); await nav.getByRole("link", { name: "Citadel", exact: true }).click();
      await page.getByRole("tab", { name: "Council", exact: true }).click();
      await panel.getByText(/^Citadel access outcome is unconfirmed/).waitFor(); await manage.click();
      await panel.getByRole("combobox", { name: "Council agent", exact: true }).selectOption(profile.agentId);
      assert.equal(await panel.getByRole("button", { name: "Review Council seat", exact: true }).isDisabled(), true);
      assert.equal(await panel.getByRole("button", { name: "Review seat removal", exact: true }).isDisabled(), true);
      await capture("native-locked");

      stage = "preserve shared unknown lock through actual classic owner handoff";
      await page.getByRole("tab", { name: "Workspaces", exact: true }).click();
      const documentCount = navigations, writeCount = writes.length;
      await page.evaluate(() => { window.__councilDocument = {}; window.__councilRoot = document.getElementById("root"); });
      await page.getByRole("link", { name: "Open Citadel governance", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.shell === "classic");
      const openNavFor = target => clickClassicOwnerNavigation(page, target);
      await openNavFor(page.getByRole("navigation", { name: "Primary mission areas", exact: true }).getByRole("button", { name: "Settings", exact: true }));
      await openNavFor(page.getByRole("button", { name: /^Citadel: / }));
      await page.getByRole("navigation", { name: "Citadel sections", exact: true }).getByRole("button", { name: "Council", exact: true }).click();
      await page.getByText(/^Citadel access outcome is unconfirmed/).waitFor();
      await page.locator("summary").filter({ hasText: /^Manage Council seats$/ }).click();
      await page.getByRole("combobox", { name: "Council agent", exact: true }).selectOption(profile.agentId);
      assert.equal(await page.getByRole("button", { name: "Seat", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Remove", exact: true }).isDisabled(), true);
      assert.equal(navigations, documentCount); assert.equal(writes.length, writeCount);
      assert.ok(await page.evaluate(() => Boolean(window.__councilDocument) && window.__councilRoot === document.getElementById("root")));
      assert.deepEqual(await selection(), initialSelection); assert.deepEqual(await read(), committedUnknown);
      assert.deepEqual((await api("/api/v1/agents?view=active&limit=300")).items, profiles);
      assert.deepEqual(writes.map(({ method, pathname }) => `${method} ${pathname}`), [
        `POST ${seatPath}`, `DELETE ${seatPath}/${encodeURIComponent(profile.agentId)}`, `POST ${seatPath}`,
      ]);
      const final = (await api("/api/v1/citadels?view=all&limit=500")).items;
      for (const previous of prior) assert.deepEqual(final.find(item => item.citadelId === previous.citadelId), previous);
      await capture("classic-locked", page.getByRole("combobox", { name: "Council agent", exact: true }));
      const expectedPresence = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
        clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
      const observedPresence = presence.slice(); await Promise.all(observedPresence.map(entry => entry.completed));
      for (const entry of observedPresence) { if (entry.error) throw entry.error; assertCitadelPresenceHeartbeat(entry, expectedPresence); }
      return { status: "passed", metrics: { actualReferenceSeatAndRemoval: true, existingProfilesUnchanged: true, agentStarted: false,
        cancelWrites: 0, staleWrites: 0, exactRevisionAndReadback: true, lostCommittedResponse: true,
        nativeAndClassicUnknownLock: true, sameDocumentClassicOwner: true, selectionUnchanged: true, unrelatedAccessPreserved: true,
        systemPresenceHeartbeats: observedPresence.length, systemPresenceReceiptsConfirmed: true,
        systemPresenceEvidence: observedPresence.map(({ method, pathname, body, status, receipt }) => ({ method, pathname, body, status, receipt })),
        blockingAxe: 0, limitation: "Existing profile references in a new disposable Citadel only. One committed response is deliberately dropped. No agent execution, profile edits or grant changes; the API does not atomically freeze the agent catalog." }, artifacts: emptyArtifacts({ screenshots }) };
    } catch (error) {
      if (page && !page.isClosed()) try {
        await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-council-${variant}-failure.png`);
        await page.screenshot({ path: file }); screenshots.push(relativeToRun(context, file));
      } catch { /* Preserve original failure. */ }
      return { status: "failed", error: `${stage}: ${error?.stack ?? error}`, metrics: { failedStage: stage, writes: writes.map(({ method, pathname }) => `${method} ${pathname}`) }, artifacts: emptyArtifacts({ screenshots }) };
    } finally { await browserContext?.close(); }
    async function capture(name, target = panel, actions = []) {
      if (actions.length) {
        const buttons = {}; for (const action of actions) buttons[action] = await target.getByRole("button", { name: action, exact: true }).boundingBox();
        assertIntegrationDialogBounds({ viewport, dialog: await target.boundingBox(), buttons });
      } else await target.scrollIntoViewIfNeeded();
      await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
      assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
      await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-council-${variant}-${name}.png`);
      await page.screenshot({ path: file }); screenshots.push(relativeToRun(context, file));
    }
  });
}
