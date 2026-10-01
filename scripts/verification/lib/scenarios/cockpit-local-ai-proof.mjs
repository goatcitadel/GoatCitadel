import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export function assertLocalAiIntentAgreement({ kind, selected, request, receipt, owner, replay }) {
  assert.ok(["download", "serve"].includes(kind));
  assert.deepEqual(request, { modelId: selected.modelId, backend: selected.backend, approvalMode: "request" });
  assert.equal(receipt.modelId, selected.modelId);
  assert.equal(receipt.backend, selected.backend);
  assert.equal(receipt.status, "requires_approval");
  assert.ok(receipt.jobId && receipt.approvalId);
  const records = (kind === "download" ? owner.downloads : owner.serveJobs).filter((item) => item.jobId === receipt.jobId);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], receipt);
  assert.equal(replay.approval.approvalId, receipt.approvalId);
  assert.equal(replay.approval.kind, `local_ai.${kind}`);
  assert.equal(replay.approval.riskLevel, kind === "download" ? "caution" : "danger");
  assert.equal(replay.approval.status, "pending");
  assert.equal(replay.approval.linkage.actionType, `local_ai.${kind}`);
  for (const [key, value] of Object.entries({ action: kind, jobId: receipt.jobId, modelId: selected.modelId, backend: selected.backend, approvalMode: "request" })) {
    assert.equal(replay.approval.payload[key], value);
  }
  assert.equal(receipt.processId, undefined);
  assert.equal(receipt.artifactPath, undefined);
  assert.equal(receipt.artifactHash, undefined);
  assertLocalAiApprovalInfrastructure(replay);
}

function assertLocalAiApprovalInfrastructure(replay) {
  const { approval, effects, durableRunId } = replay;
  const approvalId = approval.approvalId;
  assert.ok(typeof durableRunId === "string" && durableRunId.length > 0);
  assert.equal(approval.linkage.durableRunId, durableRunId);
  assert.equal(replay.pendingAction, undefined, "Local AI intent has no executable pending action");
  assert.equal(effects.length, 3, "Only wait materialization and the two approval-create signals are expected");
  assert.equal(new Set(effects.map((effect) => effect.effectId)).size, 3);
  assert.equal(new Set(effects.map((effect) => effect.idempotencyKey)).size, 3);
  for (const effect of effects) {
    assert.ok(typeof effect.effectId === "string" && effect.effectId.length > 0);
    assert.equal(effect.approvalId, approvalId);
    assert.equal(effect.status, "completed");
    assert.ok(Number.isSafeInteger(effect.version) && effect.version > 0);
    assert.ok(Number.isSafeInteger(effect.attemptCount) && effect.attemptCount > 0);
    for (const field of ["createdAt", "updatedAt", "completedAt"]) assert.ok(Number.isFinite(Date.parse(effect[field])));
  }
  const waits = effects.filter((effect) => effect.effectKind === "approval_wait_materialize");
  assert.equal(waits.length, 1);
  const wait = waits[0];
  assert.equal(wait.targetKind, "durable_run");
  assert.equal(wait.targetId, durableRunId);
  assert.equal(wait.idempotencyKey, `${approvalId}:approval_wait_materialize:durable_run:${durableRunId}`);
  assert.deepEqual(wait.payload, { approvalId, runId: durableRunId });
  assert.deepEqual(wait.result, { approvalId, runId: durableRunId, materialized: true, status: "waiting" });
  const common = { approvalId, kind: approval.kind, riskLevel: approval.riskLevel, status: "pending" };
  for (const [index, kind] of ["audit", "realtime"].entries()) {
    const operationId = `approval.create.${kind}`;
    const signals = effects.filter((effect) => effect.effectKind === "approval_observability" && effect.targetId === operationId);
    assert.equal(signals.length, 1);
    const signal = signals[0], envelope = signal.payload;
    const deliveryId = `approval-observability:${approvalId}:${operationId}`;
    assert.equal(signal.targetKind, "approval");
    assert.equal(signal.idempotencyKey, deliveryId);
    assert.equal(envelope.schemaVersion, "approval_observability.v1");
    assert.equal(envelope.operationId, operationId);
    assert.equal(envelope.deliveryId, deliveryId);
    assert.equal(envelope.orderIndex, index + 1);
    assert.ok(Number.isFinite(Date.parse(envelope.occurredAt)));
    assert.equal(envelope.predecessorDeliveryId, index ? `approval-observability:${approvalId}:approval.create.audit` : undefined);
    assert.deepEqual(envelope.delivery, kind === "audit"
      ? { kind, stream: "approvals", payload: { event: "approval.create", ...common } }
      : { kind, eventType: "approval_created", source: "approvals", payload: common,
        options: { correlationId: approvalId, eventAuthority: "retained_stream", eventClass: "domain_fact", links: { approvalId, runId: durableRunId } } });
    assert.deepEqual(signal.result, { delivered: true, deliveryId, deliveryKind: kind, deliveryState: "delivered", occurredAt: envelope.occurredAt, operationId });
  }
}

/** Uses real installation-scoped owners in the disposable stack. Records intent only; never approves or executes it. */
export async function runCockpitLocalAiProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Local AI proof needs an isolated runtime");
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-local-ai.${variant}`, lane: "ux-budgets",
      title: `Cockpit Local AI readiness and approval intent ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "prepare isolated browser";
      let browserContext, page;
      const screenshots = [], writes = [], unrelatedWrites = [];
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const suffix = randomUUID().slice(0, 8);
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId, name: `Local AI proof ${suffix}`, slug: `local-ai-proof-${suffix}` } });
        const before = await api("/api/v1/local-ai/readiness");
        const selected = before.recommendations[0];
        assert.ok(selected && before.catalog.some((model) => model.modelId === selected.modelId && model.preferredBackends.includes(selected.backend)));
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (["/api/v1/local-ai/downloads", "/api/v1/local-ai/serve"].includes(pathname)) writes.push({ pathname, body: request.postDataJSON() });
          else unrelatedWrites.push(`${request.method()} ${pathname}`);
        });
        stage = "compare readiness and fit";
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/models?shell=cockpit#local-ai"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Local AI readiness", exact: true });
        const choice = panel.getByRole("combobox", { name: /^Model and backend(?:\s|$)/ });
        await choice.selectOption(JSON.stringify([selected.modelId, selected.backend]));
        assert.equal(await choice.inputValue(), JSON.stringify([selected.modelId, selected.backend]));
        for (const text of [...selected.reasons, ...selected.limitations].slice(0, 12)) assert.ok((await panel.innerText()).includes(text.slice(0, 1600)));
        assert.ok((await panel.innerText()).includes(String(before.hardware.cpu.logicalCores)));
        await capture("readiness");
        await panel.getByRole("button", { name: "Hardware details", exact: true }).click();
        const hardware = page.getByRole("dialog", { name: "Local hardware", exact: true });
        await hardware.waitFor(); assert.ok((await hardware.innerText()).includes(before.hardware.os.platform));
        await capture("hardware"); await hardware.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "review and cancel with no request";
        await panel.getByRole("button", { name: "Request download approval", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Record Local AI approval request?", exact: true });
        await dialog.waitFor(); assert.ok((await dialog.innerText()).includes("does not download a model"));
        await capture("review");
        await dialog.getByRole("button", { name: "Keep Local AI unchanged", exact: true }).click();
        await dialog.waitFor({ state: "hidden" }); assert.deepEqual(writes, []);
        stage = "record exact download approval intent";
        await panel.getByRole("button", { name: "Request download approval", exact: true }).click();
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/local-ai/downloads");
        await dialog.getByRole("button", { name: "Record approval request", exact: true }).click();
        const response = await responsePromise; assert.equal(response.status(), 201); const receipt = await response.json();
        await panel.getByText("Download approval request recorded. No model download or server start was performed.", { exact: true }).waitFor();
        assert.equal(writes.length, 1);
        assertLocalAiIntentAgreement({ kind: "download", selected, request: writes[0].body, receipt,
          owner: await api("/api/v1/local-ai/readiness"), replay: await api(`/api/v1/approvals/${receipt.approvalId}/replay`) });
        await panel.getByRole("button", { name: "Jobs and endpoints", exact: true }).click();
        const jobs = page.getByRole("dialog", { name: "Jobs and endpoints", exact: true });
        await jobs.getByText(receipt.jobId, { exact: true }).waitFor();
        assert.ok(await jobs.locator(`a[href="/ops/approvals?shell=classic&approvalId=${receipt.approvalId}"]`).count());
        await capture("retained-intent"); await jobs.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "retain lost-response uncertainty without retry";
        let serveReceipt;
        const loseResponse = async (route) => { if (route.request().method() !== "POST") return route.continue();
          const result = await route.fetch(); assert.equal(result.status(), 201); serveReceipt = await result.json(); await route.abort("failed"); };
        await page.route("**/api/v1/local-ai/serve", loseResponse);
        await panel.getByRole("button", { name: "Request serve approval", exact: true }).click();
        await dialog.getByRole("button", { name: "Record approval request", exact: true }).click();
        await panel.getByText(/^Request outcome is unconfirmed\./).waitFor();
        assert.equal(writes.length, 2);
        assertLocalAiIntentAgreement({ kind: "serve", selected, request: writes[1].body, receipt: serveReceipt,
          owner: await api("/api/v1/local-ai/readiness"), replay: await api(`/api/v1/approvals/${serveReceipt.approvalId}/replay`) });
        await page.unroute("**/api/v1/local-ai/serve", loseResponse);
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Models", exact: true }).click();
        await page.getByRole("tab", { name: "Local AI", exact: true }).click();
        await panel.getByText(/^Request outcome is unconfirmed\./).waitFor();
        assert.equal(await panel.getByRole("button", { name: "Request serve approval", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 2); assert.deepEqual(unrelatedWrites, []);
        await capture("unknown-locked");
        return { status: "passed", metrics: { modelId: selected.modelId, backend: selected.backend, cancelWrites: 0, approvalIntentWrites: 2,
          exactOwnerAgreement: true, lostResponseInjected: true, appSessionRemountLock: true, blockingAxe: 0,
          limitation: "Actual host scan and actual approval intent in an isolated runtime. No approval resolution, model download, server start, provider configuration or inference." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-local-ai-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve the original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, approvalIntentWrites: writes.length }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page); const blocking = audit.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        assert.deepEqual(blocking.map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-local-ai-${variant}-${name}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      }
    });
  }
}
