import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

export function assertMasonStagingOwner({ before, blueprint, summary, request, receipt, owner }) {
  assert.deepEqual(request, { blueprint, expectedRevision: before.revision });
  assert.deepEqual(receipt.citadel, owner); assert.deepEqual(receipt.review, summary);
  assert.equal(owner.citadelId, before.citadelId); assert.notEqual(owner.revision, before.revision);
  assert.deepEqual({ ...owner.record, hasCharter: undefined }, { ...before.record, hasCharter: undefined });
  for (const [key, value] of Object.entries(blueprint.charter)) assert.deepEqual(owner.charter[key], value);
  assert.equal(owner.charter.defaultChamberId, undefined);
  for (const chamber of before.chambers) assert.deepEqual(owner.chambers.find(item => item.chamberId === chamber.chamberId), chamber);
  const prior = new Set(before.chambers.map(item => item.chamberId));
  const fields = list => list.map(({ name, sensitivity, sealed }) => ({ name, sensitivity, sealed })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(fields(owner.chambers.filter(item => !prior.has(item.chamberId))), fields(blueprint.chambers));
}
export function assertMasonSessionOwner({ before, patch, receipt, owner }) {
  assert.deepEqual(receipt, owner); assert.equal(owner.sessionId, before.sessionId); assert.equal(owner.createdAt, before.createdAt);
  assert.equal(owner.status, before.status); assert.deepEqual(owner.answers, { ...before.answers, ...patch });
  assert.ok(Date.parse(owner.updatedAt) >= Date.parse(before.updatedAt));
}
export function assertMasonAccessPreserved({ before, after, structure }) {
  assert.equal(after.citadelId, before.citadelId);
  assert.deepEqual(after.structure, structure);
  for (const field of ["wards", "council", "passages", "members", "integrations"]) assert.deepEqual(after[field], before[field]);
}

/** Real deterministic session/draft/stage owners on new disposable Citadels; no model interpretation. */
export async function runCockpitCitadelMasonProof({ context, browser, stack, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Mason proof needs a disposable runtime.");
  const api = async (route, init) => { const reply = await requestJson(stack.gatewayUrl, route, init); assert.ok(reply.ok, `${route}: ${reply.status}`); return reply.body; };
  for (const { variant, viewport } of viewports) await runScenario(context, {
    id: `ux-budgets.cockpit-citadel-mason.${variant}`, lane: "ux-budgets", title: `Native deterministic Mason setup and exact staging ${variant}`, subsystem: "mission-control-ux",
  }, async () => {
    const writes = [], screenshots = []; let page, browserContext, panel, stage = "create isolated owner fixture";
    const screenshotDir = path.join(context.artifactRoot, "screenshots");
    try {
      const suffix = `${variant}-${randomUUID().slice(0, 8)}`, id = `ux-mason-${suffix}`;
      const prior = (await api("/api/v1/citadels?view=all&limit=500")).items;
      const record = await api("/api/v1/citadels", { method: "POST", body: { name: `Mason ${suffix}`, slug: id, kind: "team" } }); assert.equal(record.citadelId, id);
      const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId: id, name: `Mason workspace ${suffix}` } });
      const ownerPath = `/api/v1/citadels/${encodeURIComponent(id)}`, original = await api(`${ownerPath}/structure`);
      const accessBefore = await api(`${ownerPath}/access`);
      browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
      await browserContext.addInitScript(theme => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", theme); }, variant === "mobile" ? "light" : "dark");
      await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, id); page = await browserContext.newPage();
      page.on("request", request => { const pathname = new URL(request.url()).pathname; if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) writes.push({ pathname, body: request.postDataJSON() }); });
      await page.route("**/api/v1/mason/sessions/*/message", route => route.abort("failed"));
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-mason"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 }); panel = page.getByRole("region", { name: "Citadel Mason", exact: true });
      const replyFor = async (pathname, action) => {
        const [reply] = await Promise.all([page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === pathname), action()]);
        assert.ok(reply.ok(), `${pathname}: ${reply.status()}`); return { receipt: await reply.json(), request: reply.request().postDataJSON() };
      };
      stage = "create and read the global Mason session";
      const created = await replyFor("/api/v1/mason/sessions", () => panel.getByRole("button", { name: "Start setup", exact: true }).click());
      const sessionPath = `/api/v1/mason/sessions/${encodeURIComponent(created.receipt.sessionId)}`;
      const beforeSession = await api(sessionPath); assert.deepEqual(beforeSession, created.receipt); assert.deepEqual(beforeSession.answers, {});
      await panel.getByRole("combobox", { name: "Kind", exact: true }).selectOption("team");
      const purpose = `Native Mason purpose ${suffix}`; await panel.getByRole("textbox", { name: "Purpose", exact: true }).fill(purpose);
      stage = "review and cancel structured answers without model dispatch";
      await panel.getByRole("button", { name: "Review answers", exact: true }).click();
      let dialog = page.getByRole("dialog", { name: "Save these Mason answers?", exact: true }); await dialog.waitFor(); await capture("answers-review", dialog, ["Save reviewed answers", "Cancel"]);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(writes.filter(item => item.pathname.endsWith("/answers")).length, 0);
      await panel.getByRole("button", { name: "Review answers", exact: true }).click();
      const saved = await replyFor(`${sessionPath}/answers`, () => dialog.getByRole("button", { name: "Save reviewed answers", exact: true }).click());
      await dialog.waitFor({ state: "hidden" }); assertMasonSessionOwner({ before: beforeSession, patch: { kind: "team", purpose }, receipt: saved.receipt, owner: await api(sessionPath) });
      stage = "draft and review through canonical deterministic owners";
      const drafted = await replyFor(`${sessionPath}/draft`, () => panel.getByRole("button", { name: "Draft & review Blueprint", exact: true }).click());
      await panel.getByRole("button", { name: "Review staging", exact: true }).waitFor();
      const summary = await api("/api/v1/mason/review", { method: "POST", body: drafted.receipt });
      const reviewedSession = await api(sessionPath); assert.equal(reviewedSession.status, "drafted"); assert.deepEqual(reviewedSession.answers, saved.receipt.answers);
      stage = "cancel staging then withhold stale structure without a stage write";
      await panel.getByRole("button", { name: "Review staging", exact: true }).click(); dialog = page.getByRole("dialog", { name: "Stage this Blueprint?", exact: true }); await dialog.waitFor();
      await capture("stage-review", dialog, ["Stage reviewed Blueprint", "Cancel"]); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.deepEqual(await api(`${ownerPath}/structure`), original); assert.equal(writes.filter(item => item.pathname.endsWith("/mason/stage")).length, 0);
      await panel.getByRole("button", { name: "Review staging", exact: true }).click(); await dialog.waitFor();
      const peer = await api(`${ownerPath}/charter`, { method: "PUT", body: { ...drafted.receipt.charter, purpose: `Peer purpose ${suffix}`, expectedRevision: original.revision } });
      await dialog.getByRole("button", { name: "Stage reviewed Blueprint", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      await panel.getByText("The Citadel changed. Review staging again before applying.", { exact: true }).waitFor(); assert.equal(writes.filter(item => item.pathname.endsWith("/mason/stage")).length, 0);
      stage = "confirm exact stage and independently read Charter and Chambers";
      await panel.getByRole("button", { name: "Review staging", exact: true }).click(); await dialog.waitFor();
      const staged = await replyFor(`${ownerPath}/mason/stage`, () => dialog.getByRole("button", { name: "Stage reviewed Blueprint", exact: true }).click());
      await panel.getByText("Blueprint staged and confirmed. No accounts were connected and no Gates were opened.", { exact: true }).waitFor();
      const after = await api(`${ownerPath}/structure`); assertMasonStagingOwner({ before: peer, blueprint: drafted.receipt, summary, request: staged.request, receipt: staged.receipt, owner: after });
      const accessAfterStage = await api(`${ownerPath}/access`); assertMasonAccessPreserved({ before: accessBefore, after: accessAfterStage, structure: after }); await capture("staged");
      stage = "retain intercepted staging uncertainty across native navigation";
      let intercepted = 0; await page.route(`**${ownerPath}/mason/stage`, route => { intercepted++; return route.abort("failed"); });
      await panel.getByRole("button", { name: "Review staging", exact: true }).click(); await dialog.getByRole("button", { name: "Stage reviewed Blueprint", exact: true }).click();
      await panel.getByText(/^Citadel staging outcome is unconfirmed/).waitFor();
      const navigation = page.getByRole("navigation", { name: "Settings pages", exact: true }); await navigation.getByRole("link", { name: "General", exact: true }).click(); await navigation.getByRole("link", { name: "Citadel", exact: true }).click();
      await page.getByRole("tab", { name: "Citadel setup", exact: true }).click(); await panel.getByText(/^Citadel staging outcome is unconfirmed/).waitFor();
      assert.equal(intercepted, 1); assert.deepEqual(await api(`${ownerPath}/structure`), after); assert.deepEqual(await api(`${ownerPath}/access`), accessAfterStage);
      assert.equal(writes.filter(item => /\/(message|agent-send|send)$/.test(item.pathname)).length, 0);
      assert.equal(writes.filter(item => item.pathname.endsWith("/mason/stage")).length, 2);
      const finalRecords = (await api("/api/v1/citadels?view=all&limit=500")).items; for (const item of prior) assert.deepEqual(finalRecords.find(current => current.citadelId === item.citadelId), item);
      await capture("uncertain");
      return { status: "passed", metrics: { actualSessionCreate: true, actualStructuredAnswerSave: true, actualDeterministicDraft: true, actualRevisionedStage: true,
        cancelledStageWrites: 0, staleStageWrites: 0, interceptedStageWrites: 1, uncertainLockAcrossRemount: true, modelInterpretationDispatched: false, accessRecordsUnchanged: true, blockingAxe: 0,
        limitation: "New disposable Citadel only; intercepted unknown stage was not forwarded. Mason session API has no CAS. No model inference or external account connection." }, artifacts: emptyArtifacts({ screenshots }) };
    } catch (error) {
      if (page && !page.isClosed()) try { await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-citadel-mason-${variant}-failure.png`); await page.screenshot({ path: screenshot }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve source failure. */ }
      return { status: "failed", error: `${stage}: ${error?.stack ?? error}`, metrics: { failedStage: stage }, artifacts: emptyArtifacts({ screenshots }) };
    } finally { await browserContext?.close(); }
    async function capture(name, target = panel, actions = []) {
      if (actions.length) { const buttons = {}; for (const action of actions) buttons[action] = await target.getByRole("button", { name: action, exact: true }).boundingBox(); assertIntegrationDialogBounds({ viewport, dialog: await target.boundingBox(), buttons }); }
      else await target.scrollIntoViewIfNeeded();
      await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page); assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
      await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-citadel-mason-${variant}-${name}.png`); await page.screenshot({ path: screenshot }); screenshots.push(relativeToRun(context, screenshot));
    }
  });
}
