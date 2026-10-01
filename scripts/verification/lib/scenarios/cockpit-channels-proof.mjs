import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";

export function assertChannelDraftSaved({ before, request, receipt, owner, label, baseUrl, topic }) {
  assert.equal(request.expectedRevision, before.revision);
  assert.equal(request.label, label); assert.equal(request.enabled, false);
  assert.equal(receipt.draftId, before.draftId); assert.equal(owner.draftId, before.draftId);
  assert.equal(owner.catalogId, "channel.ntfy"); assert.ok(owner.revision > before.revision);
  assert.equal(owner.label, label); assert.equal(owner.enabled, false);
  assert.equal(owner.draft.baseUrl, baseUrl); assert.equal(owner.draft.topic, topic);
  assert.deepEqual(receipt, owner);
}
export function assertChannelFinalizationPlan({ plan, draft, definition, connections }) {
  assert.equal(plan.kind, "channel_connection"); assert.equal(plan.origin.workspaceId, "default");
  assert.equal(plan.origin.surface, "settings"); assert.equal(plan.target.expectedRevision, draft.revision);
  assert.deepEqual(plan.request, { kind: "channel_connection", channelKind: draft.catalogId, draftId: draft.draftId });
  assert.equal(plan.target.ownerId, "channel_setup_draft"); assert.equal(plan.target.resourceId, draft.draftId);
  // The registered channel adapter first reviews public fields, including saved values.
  assert.equal(plan.status, "awaiting_input"); assert.equal(plan.requiredAction.kind, "public_form");
  const registered = new Map();
  for (const field of definition.wizard.steps.flatMap(step => step.fields ?? [])) {
    if (!registered.has(field.key) && !definition.adapter.secretFieldKeys.includes(field.key) && field.type !== "secret" && !field.sensitive) registered.set(field.key, field);
  }
  assert.deepEqual(plan.requiredAction.fields.map(field => field.fieldId), [...registered.keys()]);
  for (const field of plan.requiredAction.fields) {
    const schema = registered.get(field.fieldId), initial = draft.draft[field.fieldId] ?? schema.defaultValue;
    assert.equal(field.type, ["boolean", "select", "url"].includes(schema.type) ? schema.type : "text");
    assert.equal(field.required, schema.required); assert.equal(field.label, schema.label);
    assert.deepEqual(field.initialValue, ["string", "boolean", "number"].includes(typeof initial) ? initial : undefined);
  }
  assert.equal(connections.some((item) => item.label === draft.label), false, "Preparing a plan finalized its channel without confirmation.");
}

/** Only a unique disabled draft and this helper's own loopback notification receiver are mutated. */
export async function runCockpitChannelsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Channel proof requires a disposable runtime.");
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `Channel owner request failed (${response.status}).`); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-channels.${variant}`, lane: "ux-budgets",
      title: `Native channel draft, live-test review and governed finalization ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const screenshots = [], diagnostics = [], writes = [], received = [];
      let page, browserContext, receiver, stage = "start isolated notification receiver";
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12), label = `Channel proof ${variant} ${suffix}`, topic = `proof-${suffix}`;
      try {
        receiver = createServer((request, response) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => {
            received.push({ method: request.method, path: request.url, bytes: Buffer.concat(chunks).length });
            if (request.method !== "POST" || request.url !== `/${topic}`) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ id: `fixture-${suffix}`, event: "message", topic, time: Math.floor(Date.now() / 1000) }));
          });
        });
        await new Promise((resolve, reject) => { receiver.once("error", reject); receiver.listen(0, "127.0.0.1", resolve); });
        const baseUrl = `http://127.0.0.1:${receiver.address().port}`;
        const definition = (await api("/api/v1/channels/setup-definitions")).items.find((item) => item.catalog.catalogId === "channel.ntfy");
        assert.ok(definition, "The matching Gateway must advertise ntfy setup.");
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const route = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && route.startsWith("/api/v1/"))
            writes.push({ method: request.method(), route }); // Never collect submitted credentials.
        });
        const settingsUrl = buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#channels");
        await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Channel setup", exact: true });
        await panel.getByRole("button", { name: "Connect channel", exact: true }).click();
        await panel.getByRole("combobox", { name: "Channel definition", exact: true }).selectOption("channel.ntfy");
        stage = "create the advertised channel draft";
        const creation = responseFor("POST", "/api/v1/channels/drafts");
        await panel.getByRole("button", { name: "Start guided setup", exact: true }).click();
        const createdResponse = await creation; assert.equal(createdResponse.status(), 201);
        const created = await createdResponse.json(); assert.equal(created.catalogId, "channel.ntfy");
        const route = `/api/v1/channels/drafts/${encodeURIComponent(created.draftId)}`;
        await panel.getByLabel("Connection label", { exact: true }).fill(label);
        await panel.getByRole("checkbox", { name: "Enable this connection after governed finalization", exact: true }).uncheck();
        await panel.getByRole("button", { name: /Configure outbound delivery/u }).click();
        await panel.getByLabel("Base URL (required)", { exact: true }).fill(baseUrl);
        await panel.getByLabel("Topic (required)", { exact: true }).fill(topic);
        stage = "save exact reviewed public draft";
        const save = responseFor("PATCH", route);
        await panel.getByRole("button", { name: "Save draft", exact: true }).click();
        const savedResponse = await save; assert.equal(savedResponse.status(), 200);
        let owner = await api(route);
        assertChannelDraftSaved({ before: created, request: savedResponse.request().postDataJSON(), receipt: await savedResponse.json(), owner, label, baseUrl, topic });
        await panel.getByText("Channel draft saved.", { exact: true }).waitFor();
        stage = "review and cancel an external-effect test";
        const countBeforeReview = writes.length;
        await panel.getByRole("button", { name: "Review live test", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Run a live channel test?", exact: true });
        await review.getByText(/may send a sandbox message/u).waitFor(); await capture("test-review");
        await review.getByRole("button", { name: "Cancel test", exact: true }).click();
        assert.equal(writes.length, countBeforeReview); assert.equal(received.length, 0);
        assert.deepEqual(await api(route), owner);
        stage = "perform a deliberately approved loopback sandbox test";
        await panel.getByRole("button", { name: "Review live test", exact: true }).click();
        const test = responseFor("POST", `${route}/test`);
        await review.getByRole("button", { name: "Run reviewed live test", exact: true }).click();
        const testResponse = await test; assert.equal(testResponse.status(), 200);
        const testReceipt = await testResponse.json(); assert.equal(testReceipt.draftId, owner.draftId); assert.equal(testReceipt.status, "ok");
        assert.equal(received.length, 1); assert.deepEqual(received[0], { method: "POST", path: `/${topic}`, bytes: received[0].bytes }); assert.ok(received[0].bytes > 0);
        owner = await api(route); assert.equal(owner.revision, testReceipt.draftRevision);
        await panel.getByRole("region", { name: "Channel check result", exact: true }).getByText("Live test: ok", { exact: true }).waitFor();
        await capture("live-test-result");
        stage = "prepare a bound plan without finalizing the connection";
        const preparation = responseFor("POST", "/api/v1/change-plans");
        await panel.getByRole("button", { name: "Prepare finalization plan", exact: true }).click();
        const prepared = await preparation; assert.equal(prepared.status(), 201);
        const plan = await prepared.json();
        assertChannelFinalizationPlan({ plan, draft: owner, definition, connections: (await api("/api/v1/integrations/connections?kind=channel&limit=300")).items });
        await page.waitForURL((url) => url.pathname === "/chat");
        assert.equal(writes.some((item) => item.route.endsWith("/finalize") || item.route.endsWith("/confirmations")), false);
        stage = "withhold a stale edit before mutation";
        await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
        await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
        await panel.getByLabel("Connection label", { exact: true }).fill(`${label} retained`);
        owner = await api(route, { method: "PATCH", body: { expectedRevision: owner.revision, label: `${label} peer` } });
        const beforeStale = writes.length;
        await panel.getByRole("button", { name: "Save draft", exact: true }).click();
        await panel.getByText("Channel draft changed", { exact: true }).waitFor(); assert.equal(writes.length, beforeStale);
        assert.equal(await panel.getByLabel("Connection label", { exact: true }).inputValue(), `${label} retained`);
        await capture("stale-draft");
        stage = "retain a committed but lost save result across a Settings page remount";
        await panel.getByRole("button", { name: "Apply retained input to current revision", exact: true }).click();
        await page.route(`**${route}`, async (intercept) => {
          if (intercept.request().method() !== "PATCH") { await intercept.continue(); return; }
          const response = await intercept.fetch(); assert.equal(response.status(), 200); await intercept.abort("failed");
        });
        await panel.getByRole("button", { name: "Save draft", exact: true }).click();
        await panel.getByText(/Outcome uncertain/u).waitFor();
        const committed = await api(route); assert.equal(committed.label, `${label} retained`); assert.ok(committed.revision > owner.revision);
        assert.ok(Number.isSafeInteger(committed.revision));
        assert.equal(committed.draftId, created.draftId); assert.equal(committed.catalogId, "channel.ntfy");
        // The failure cleanup reads the saved owner independently. Wait for that exact revision before leave review.
        await panel.getByText(`Your input is retained. Saved revision ${committed.revision} must be reviewed before retrying.`, { exact: true }).waitFor();
        const sourceUrl = page.url(), retainedWrites = structuredClone(writes), retainedMessages = structuredClone(received);
        const documentMarker = await page.evaluate(() => { window.__channelProofDocument = crypto.randomUUID(); return window.__channelProofDocument; });
        const readFields = () => panel.getByRole("region", { name: `${definition.catalog.label} guided setup`, exact: true })
          .locator("input,select,textarea").evaluateAll(fields => fields.map(field => ({
            id: field.id, type: field.type, checked: field.type === "checkbox" ? field.checked : undefined,
            // This fixture never enters credentials. Never put any password value in proof evidence.
            value: field.type === "password" ? { empty: field.value === "" } : field.value,
          })));
        const retainedFields = await readFields();
        assert.equal(await panel.getByLabel("Connection label", { exact: true }).inputValue(), `${label} retained`);
        assert.equal(await panel.getByRole("checkbox", { name: "Enable this connection after governed finalization", exact: true }).isChecked(), false);
        // This leg followed a full reload, so the wizard is on its introduction step; configuration inputs
        // are not mounted. Inspect the actual current-revision disclosure without changing the locked step.
        assert.equal(committed.draft.baseUrl, baseUrl); assert.equal(committed.draft.topic, topic);
        const publicFields = Object.entries(committed.draft).map(([key, value]) => ({ key,
          value: typeof value === "object" ? "Structured value; inspect in advanced editor after discarding or rebasing" : String(value) }));
        const assertPublicReview = async () => {
          const details = panel.locator("details").filter({ has: page.getByText("Current saved public fields", { exact: true }) });
          if (await details.getAttribute("open") === null) await details.getByText("Current saved public fields", { exact: true }).click();
          await details.locator("dl").waitFor({ state: "visible" });
          assert.deepEqual(await details.locator("dl > div").evaluateAll(rows => rows.map(row => ({
            key: row.querySelector("dt")?.textContent?.trim(), value: row.querySelector("dd")?.textContent?.trim(),
          }))), publicFields);
        };
        await assertPublicReview();
        const pages = page.getByRole("navigation", { name: "Settings pages", exact: true });
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        const reviewLeave = async decision => {
          await pages.getByRole("link", { name: "General", exact: true }).click();
          await leave.waitFor();
          await leave.getByText(`You have unsaved changes in ${committed.label}.`, { exact: true }).waitFor();
          assert.equal(await leave.count(), 1); assert.equal(page.url(), sourceUrl);
          assert.deepEqual(writes, retainedWrites); assert.deepEqual(received, retainedMessages);
          assert.deepEqual(await api(route), committed);
          await leave.getByRole("button", { name: decision, exact: true }).click();
          await leave.waitFor({ state: "hidden" });
        };
        await reviewLeave("Cancel");
        assert.equal(page.url(), sourceUrl); assert.deepEqual(await readFields(), retainedFields);
        await assertPublicReview();
        await panel.getByText(/Outcome uncertain/u).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Save draft", exact: true }).isDisabled(), true);
        assert.deepEqual(writes, retainedWrites); assert.deepEqual(received, retainedMessages);
        await reviewLeave("Keep draft and close");
        await page.waitForURL(url => url.pathname === "/settings/general" && url.search === "?shell=cockpit" && !url.hash);
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await pages.getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "Channels", exact: true }).click();
        await page.waitForURL(sourceUrl);
        assert.equal(await page.evaluate(() => window.__channelProofDocument), documentMarker, "The retained-lock proof must keep the same browser document.");
        await panel.getByText(/Outcome uncertain/u).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Connect channel", exact: true }).isEnabled(), false);
        // The selected draft identity is retained; opening its editor is observational even while writes are locked.
        await panel.getByRole("button", { name: `Edit ${committed.label}`, exact: true }).click();
        await panel.getByLabel("Connection label", { exact: true }).waitFor();
        await panel.getByText(`Your input is retained. Saved revision ${committed.revision} must be reviewed before retrying.`, { exact: true }).waitFor();
        assert.deepEqual(await readFields(), retainedFields);
        await assertPublicReview();
        assert.equal(await panel.getByRole("button", { name: "Save draft", exact: true }).isDisabled(), true);
        assert.equal(await panel.getByRole("button", { name: "Prepare finalization plan", exact: true }).isDisabled(), true);
        assert.deepEqual(await api(route), committed); assert.deepEqual(writes, retainedWrites); assert.deepEqual(received, retainedMessages);
        await capture("unknown-remount");
        return { status: "passed", metrics: { draftId: created.draftId, exactRevisionSave: true, cancelledTestWrites: 0,
          loopbackSandboxMessages: received.length, finalizationPlanId: plan.planId, finalized: false, staleWriteWithheld: true,
          uncertainResultRetained: true, canceledLeavePreservesFields: true, explicitKeepBeforeRemount: true, visibleDraftFieldsRetained: true, savedPublicFieldsRetained: true, remountMutationWrites: 0, sameDocumentRemount: true, blockingAxe: 0, limitation: "No external OAuth, channel credentials, Discord reconnect/pairing or approval-effect execution was performed." }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };

        function responseFor(method, pathname) { return page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === pathname); }
      } catch (error) {
        if (page && !page.isClosed()) try { await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-channels-${variant}-failure.png`); await page.screenshot({ path: file, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, file)); } catch { /* Preserve the original failure. */ }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserWrites: writes, loopbackSandboxMessages: received.length }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); if (receiver) await new Promise((resolve) => receiver.close(resolve)); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page), blocking = audit.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true }); const file = path.join(directory, `cockpit-channels-${variant}-${name}-axe.json`); await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map((item) => item.id), []); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const file = path.join(screenshotDir, `ux-budgets-cockpit-channels-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
