import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { clickClassicOwnerNavigation } from "./classic-owner-navigation.mjs";

export function assertWardMutationOwner({ before, request, receipt, owner, added, removedId }) {
  assert.equal(request.expectedRevision, before.revision);
  assert.deepEqual(receipt, owner);
  assert.equal(owner.citadelId, before.citadelId);
  assert.notEqual(owner.revision, before.revision);
  const rest = value => { const { revision: _revision, wards: _wards, ...unchanged } = value; return unchanged; };
  assert.deepEqual(rest(owner), rest(before));
  if (added) {
    assert.deepEqual(request, { ...added, expectedRevision: before.revision });
    const created = owner.wards.filter(item => !before.wards.some(prior => prior.wardId === item.wardId));
    assert.equal(created.length, 1);
    assert.equal(created[0].citadelId, before.citadelId);
    for (const [field, value] of Object.entries(added)) assert.equal(created[0][field], value);
    assert.equal(owner.wards.length, before.wards.length + 1);
    for (const ward of before.wards) assert.deepEqual(owner.wards.find(item => item.wardId === ward.wardId), ward);
    return created[0];
  }
  assert.ok(before.wards.some(item => item.wardId === removedId));
  assert.deepEqual(request, { expectedRevision: before.revision });
  assert.deepEqual(owner.wards, before.wards.filter(item => item.wardId !== removedId));
}

export function assertWardProbe({ action, request, receipt, before, after }) {
  assert.deepEqual(request, { action });
  assert.deepEqual(receipt, { action, effect: "deny" });
  assert.deepEqual(after, before);
}

/** Real reviewed Ward owners in a disposable Citadel; probes never invoke the tested action. */
export async function runCockpitCitadelWardsProof({ context, browser, stack, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Wards proof needs a disposable runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.body;
  };
  for (const { variant, viewport } of viewports) await runScenario(context, {
    id: `ux-budgets.cockpit-citadel-wards.${variant}`, lane: "ux-budgets",
    title: `Native reviewed Wards, read-only probe and retained access lock ${variant}`, subsystem: "mission-control-ux",
  }, async () => {
    const writes = [], screenshots = [], presence = [];
    let stage = "prepare isolated Ward owner", page, browserContext, panel, navigations = 0;
    const screenshotDir = path.join(context.artifactRoot, "screenshots");
    try {
      const suffix = `${variant}-${randomUUID().slice(0, 8)}`, citadelId = `ux-wards-${suffix}`;
      const prior = (await api("/api/v1/citadels?view=all&limit=500")).items;
      const record = await api("/api/v1/citadels", { method: "POST", body: { name: `Wards ${suffix}`, slug: citadelId, kind: "team" } });
      assert.equal(record.citadelId, citadelId);
      const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId, name: `Wards workspace ${suffix}` } });
      const ownerPath = `/api/v1/citadels/${encodeURIComponent(citadelId)}`, wardPath = `${ownerPath}/wards`;
      const read = () => api(`${ownerPath}/access`), initial = await read();
      const theme = variant === "mobile" ? "light" : "dark";
      browserContext = await browser.newContext({ viewport, colorScheme: theme });
      await browserContext.addInitScript(value => {
        window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
        window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
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
      // An unexpected tool/chat dispatch is intercepted, recorded and fails the exact write allowlist below.
      await page.route("**/api/v1/tools/invoke", route => route.abort("failed"));
      await page.route("**/api/v1/chat/**/agent-send", route => route.abort("failed"));
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-wards"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
      panel = page.getByRole("region", { name: "Citadel Wards", exact: true });
      await panel.getByRole("button", { name: "Add Ward", exact: true }).waitFor();
      const selection = () => page.evaluate(() => ({ citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"), workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") }));
      const initialSelection = await selection();
      const replyFor = async (method, pathname, action) => {
        const [response] = await Promise.all([page.waitForResponse(reply => reply.request().method() === method && new URL(reply.url()).pathname === pathname), action()]);
        assert.ok(response.ok(), `${pathname}: ${response.status()}`);
        return { receipt: await response.json(), request: response.request().postDataJSON() };
      };
      const editor = page.getByRole("dialog", { name: "Add a Ward", exact: true });
      const review = page.getByRole("dialog", { name: "Add this Ward?", exact: true });
      const added = { name: `Reviewed allowance ${suffix}`, actionPattern: "ux.ward.action", effect: "allow" };
      stage = "review exact consequence and cancel without mutation";
      await panel.getByRole("button", { name: "Add Ward", exact: true }).click();
      await editor.getByRole("textbox", { name: "Name", exact: true }).fill(added.name);
      await editor.getByRole("textbox", { name: "Action pattern", exact: true }).fill(added.actionPattern);
      await editor.getByRole("button", { name: /^Allow Permit/ }).click();
      await editor.getByRole("button", { name: "Review Ward", exact: true }).click();
      await capture("add-review", review, ["Confirm add Ward", "Cancel"]);
      assert.match(await review.innerText(), /Deny-wins policy remains authoritative/);
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.deepEqual(await read(), initial); assert.equal(writes.length, 0);

      stage = "reject stale preflight with zero browser writes";
      await editor.getByRole("button", { name: "Review Ward", exact: true }).click();
      const peer = await api(wardPath, { method: "POST", body: { name: `Peer deny ${suffix}`, actionPattern: "ux.ward.*", effect: "deny", expectedRevision: initial.revision } });
      await review.getByRole("button", { name: "Confirm add Ward", exact: true }).click();
      await review.waitFor({ state: "hidden" });
      await editor.getByRole("button", { name: "Use current access review", exact: true }).waitFor();
      assert.equal(writes.length, 0); assert.deepEqual(await read(), peer);
      await editor.getByRole("button", { name: "Use current access review", exact: true }).click();

      stage = "save exact reviewed Ward and independently confirm owner";
      await editor.getByRole("button", { name: "Review Ward", exact: true }).click();
      const saved = await replyFor("POST", wardPath, () => review.getByRole("button", { name: "Confirm add Ward", exact: true }).click());
      const afterAdd = await read();
      const ward = assertWardMutationOwner({ before: peer, added, ...saved, owner: afterAdd });
      const rule = page.getByRole("dialog", { name: added.name, exact: true });
      await rule.waitFor(); await rule.getByRole("button", { name: "Close dialog", exact: true }).click();

      stage = "probe deny-wins policy without executing or changing owner";
      await panel.getByRole("button", { name: "Test an action", exact: true }).click();
      const probe = page.getByRole("dialog", { name: "Test an action", exact: true });
      await probe.getByRole("textbox", { name: "Action", exact: true }).fill(added.actionPattern);
      const evaluated = await replyFor("POST", `${ownerPath}/gatehouse/evaluate`, () => probe.getByRole("button", { name: "Evaluate", exact: true }).click());
      await probe.getByRole("status").filter({ hasText: `${added.actionPattern} → Deny` }).waitFor();
      assertWardProbe({ action: added.actionPattern, ...evaluated, before: afterAdd, after: await read() });
      await capture("probe", probe, ["Evaluate"]); await probe.getByRole("button", { name: "Close dialog", exact: true }).click();

      stage = "cancel then confirm exact Ward removal";
      await panel.getByRole("button", { name: `Inspect ${added.name}`, exact: true }).click();
      await rule.getByRole("button", { name: "Delete Ward", exact: true }).click();
      const deletion = page.getByRole("dialog", { name: "Delete this Ward?", exact: true });
      await capture("delete-review", deletion, ["Confirm delete Ward", "Cancel"]);
      await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(writes.filter(item => item.method === "DELETE").length, 0); assert.deepEqual(await read(), afterAdd);
      await rule.getByRole("button", { name: "Delete Ward", exact: true }).click();
      const removed = await replyFor("DELETE", `${wardPath}/${encodeURIComponent(ward.wardId)}`, () => deletion.getByRole("button", { name: "Confirm delete Ward", exact: true }).click());
      const afterDelete = await read(); assertWardMutationOwner({ before: afterAdd, removedId: ward.wardId, ...removed, owner: afterDelete });
      await deletion.waitFor({ state: "hidden" });

      stage = "retain actual committed-response uncertainty and original draft";
      const unknown = { name: `Unconfirmed Ward ${suffix}`, actionPattern: "ux.ward.unknown", effect: "deny" };
      await panel.getByRole("button", { name: "Add Ward", exact: true }).click();
      await editor.getByRole("textbox", { name: "Name", exact: true }).fill(unknown.name);
      await editor.getByRole("textbox", { name: "Action pattern", exact: true }).fill(unknown.actionPattern);
      await editor.getByRole("button", { name: "Review Ward", exact: true }).click();
      let lostReceipt, lostRequest;
      const lose = async route => {
        if (route.request().method() !== "POST") return route.continue();
        lostRequest = route.request().postDataJSON();
        const response = await route.fetch(); assert.ok(response.ok()); lostReceipt = await response.json();
        await route.abort("failed");
      };
      await page.route(`**${wardPath}`, lose);
      await review.getByRole("button", { name: "Confirm add Ward", exact: true }).click();
      await review.waitFor({ state: "hidden" });
      await editor.getByText(/^Citadel access outcome is unconfirmed/).waitFor();
      await page.unroute(`**${wardPath}`, lose);
      const committedUnknown = await read();
      assertWardMutationOwner({ before: afterDelete, added: unknown, request: lostRequest, receipt: lostReceipt, owner: committedUnknown });
      assert.equal(await editor.getByRole("button", { name: "Review Ward", exact: true }).isDisabled(), true);
      assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), unknown.name);
      await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
      await page.getByRole("dialog", { name: "Unsaved Ward draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
      await nav.getByRole("link", { name: "General", exact: true }).click();
      await nav.getByRole("link", { name: "Citadel", exact: true }).click();
      await page.getByRole("tab", { name: "Wards", exact: true }).click();
      await panel.getByText(/^Citadel access outcome is unconfirmed/).waitFor();
      await panel.getByRole("button", { name: "Add Ward · Unsaved", exact: true }).click();
      assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), unknown.name);
      assert.equal(await editor.getByRole("button", { name: "Review Ward", exact: true }).isDisabled(), true);
      await capture("native-locked", editor);
      await editor.getByRole("button", { name: "Close dialog", exact: true }).click();
      await page.getByRole("dialog", { name: "Unsaved Ward draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();

      stage = "retain shared lock through actual same-document classic handoff";
      await page.getByRole("tab", { name: "Workspaces", exact: true }).click();
      const documentCount = navigations, writeCount = writes.length;
      await page.evaluate(() => { window.__wardsDocument = {}; window.__wardsRoot = document.getElementById("root"); });
      await page.getByRole("link", { name: "Open Citadel governance", exact: true }).click();
      const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
      if (await leave.isVisible()) await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.shell === "classic");
      const openNavFor = target => clickClassicOwnerNavigation(page, target);
      await openNavFor(page.getByRole("navigation", { name: "Primary mission areas", exact: true }).getByRole("button", { name: "Settings", exact: true }));
      await openNavFor(page.getByRole("button", { name: /^Citadel: / }));
      await page.getByRole("navigation", { name: "Citadel sections", exact: true }).getByRole("button", { name: "Wards", exact: true }).click();
      await page.getByRole("button", { name: "Add Ward · Unsaved", exact: true }).click();
      const classic = page.locator(".mc-next-detail-inspector").filter({ has: page.getByRole("heading", { name: "Add a Ward", exact: true }) });
      await classic.getByText(/^Citadel access outcome is unconfirmed/).waitFor();
      assert.equal(await classic.getByRole("textbox", { name: "Name", exact: true }).inputValue(), unknown.name);
      assert.equal(await classic.getByRole("textbox", { name: "Action pattern", exact: true }).inputValue(), unknown.actionPattern);
      assert.equal(await classic.getByRole("button", { name: "Add Ward", exact: true }).isDisabled(), true);
      assert.equal(navigations, documentCount); assert.equal(writes.length, writeCount);
      assert.ok(await page.evaluate(() => Boolean(window.__wardsDocument) && window.__wardsRoot === document.getElementById("root")));
      assert.deepEqual(await selection(), initialSelection); assert.deepEqual(await read(), committedUnknown);
      assert.deepEqual(writes.map(({ method, pathname }) => `${method} ${pathname}`), [
        `POST ${wardPath}`, `POST ${ownerPath}/gatehouse/evaluate`, `DELETE ${wardPath}/${ward.wardId}`, `POST ${wardPath}`,
      ]);
      const final = (await api("/api/v1/citadels?view=all&limit=500")).items;
      for (const previous of prior) assert.deepEqual(final.find(item => item.citadelId === previous.citadelId), previous);
      await capture("classic-locked", classic);
      const expectedPresence = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
        clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
      const observedPresence = presence.slice(); await Promise.all(observedPresence.map(entry => entry.completed));
      for (const entry of observedPresence) { if (entry.error) throw entry.error; assertCitadelPresenceHeartbeat(entry, expectedPresence); }
      return { status: "passed", metrics: { actualWardCreateDelete: true, actualDenyWinsProbe: true, cancelWrites: 0, staleWrites: 0,
        exactRevisionAndReadback: true, lostCommittedResponse: true, nativeAndClassicUnknownLock: true, retainedOriginDraft: true,
        sameDocumentClassicOwner: true, selectionUnchanged: true, unrelatedAccessPreserved: true, blockingAxe: 0,
        systemPresenceHeartbeats: observedPresence.length, systemPresenceReceiptsConfirmed: true,
        systemPresenceEvidence: observedPresence.map(({ method, pathname, body, status, receipt }) => ({ method, pathname, body, status, receipt })),
        limitation: "New disposable Citadel rules only. One committed response is deliberately dropped. Policy evaluation does not execute the action; no live tool/provider enforcement claim." }, artifacts: emptyArtifacts({ screenshots }) };
    } catch (error) {
      if (page && !page.isClosed()) try {
        await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-wards-${variant}-failure.png`);
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
      await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-wards-${variant}-${name}.png`);
      await page.screenshot({ path: file }); screenshots.push(relativeToRun(context, file));
    }
  });
}
