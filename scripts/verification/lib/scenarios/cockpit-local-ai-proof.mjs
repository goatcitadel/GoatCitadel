import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { classifyCockpitProofWrite } from "./cockpit-proof-writes.mjs";
import { selectCockpitSettingsPage } from "./cockpit-settings-page-navigation.mjs";
import { retainOwnerReadDiagnostic } from "./cockpit-approval-mode-proof.mjs";

export function projectLocalAiAuditDiagnostic(input) {
  let gap = Boolean(input?.diagnosticGap), dropped = 0;
  const rows = Array.isArray(input?.violations) ? input.violations : [];
  if (!Array.isArray(input?.violations)) gap = true;
  const stage = ["readiness", "hardware", "review", "retained-intent", "unknown-locked"].includes(input?.stage) ? input.stage : "other";
  if (stage === "other") gap = true;
  const number = value => { if (!Number.isFinite(value) || Math.abs(value) > 100_000) { gap = true;return null; }return value; };
  const rect = value => Object.fromEntries(["x", "y", "width", "height"].map(key => { const result = number(value?.[key]);if (["width", "height"].includes(key) && result !== null && result < 0) { gap = true;return [key, null]; }return [key, result]; }));
  const violationCount = Number.isSafeInteger(input?.violationCount) && input.violationCount >= rows.length ? input.violationCount : rows.length;
  dropped += Math.max(0, violationCount - 16);
  const violations = rows.slice(0, 16).map(row => {
    const id = ["link-in-text-block", "target-size", "color-contrast"].includes(row?.id) ? row.id : "other";
    const impact = ["minor", "moderate", "serious", "critical"].includes(row?.impact) ? row.impact : "other";
    if (id === "other" || impact === "other") gap = true;
    const rawNodes = Array.isArray(row?.nodes) ? row.nodes : [];if (!Array.isArray(row?.nodes)) gap = true;
    const nodeCount = Number.isSafeInteger(row?.nodeCount) && row.nodeCount >= rawNodes.length ? row.nodeCount : rawNodes.length;
    dropped += Math.max(0, nodeCount - 8);
    return { id, impact, nodeCount: Math.min(10_000, nodeCount), nodes: rawNodes.slice(0, 8).map(node => {
      const role = ["local_ai_setup_link", "local_ai_owner_link"].includes(node?.role) ? node.role : "other";
      if (role === "other") gap = true;return { role, rect: rect(node?.rect) };
    }) };
  });
  if (dropped) gap = true;
  return { format: "local-ai-audit-diagnostic.v1", stage, violationCount: Math.min(10_000, violationCount), violations, dropped: Math.min(10_000, dropped), diagnosticGap: gap };
}
export async function retainLocalAiAuditDiagnostic(input, filePath, options) {
  try { return await retainOwnerReadDiagnostic(projectLocalAiAuditDiagnostic(input), filePath, options); }
  catch { return { retained: false, writeFailure: true }; }
}

export async function captureLocalAiAuditDiagnostic(page, audit, stage) {
  const rules = Array.isArray(audit?.violations) ? audit.violations : [];
  const selected = rules.slice(0, 16), targets = selected.flatMap(rule => (Array.isArray(rule.nodes) ? rule.nodes : []).slice(0, 8).map(node =>
    Array.isArray(node.target) && node.target.length === 1 && typeof node.target[0] === "string" && node.target[0].length <= 512 ? node.target[0] : null));
  let classified = [], diagnosticGap = !Array.isArray(audit?.violations);
  try {
    classified = await page.evaluate(targets => targets.map(target => {
      let element;
      try { element = typeof target === "string" ? document.querySelector(target) : null; } catch { element = null; }
      let role = "other";
      if (element instanceof window.HTMLAnchorElement && element.closest('[aria-label="Local AI readiness"]')) {
        const url = new URL(element.href);
        if (url.origin === location.origin && url.pathname === "/settings/models" && url.search === "?shell=cockpit" && url.hash === "#onboarding") role = "local_ai_setup_link";
        else if (url.origin === location.origin && url.pathname === "/inbox" && url.searchParams.get("shell") === "cockpit" && url.searchParams.getAll("approvalId").length === 1) role = "local_ai_owner_link";
      }
      const box = element?.getBoundingClientRect();
      return { role, rect: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null };
    }), targets);
  } catch { diagnosticGap = true; }
  let index = 0;
  const violations = selected.map(rule => {
    const nodes = Array.isArray(rule.nodes) ? rule.nodes : [];
    if (!Array.isArray(rule.nodes)) diagnosticGap = true;
    return { id: rule.id, impact: rule.impact, nodeCount: nodes.length, nodes: nodes.slice(0, 8).map(() => classified[index++] ?? { role: "other", rect: null }) };
  });
  return { stage, diagnosticGap, violationCount: rules.length, violations };
}

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
      const screenshots = [], diagnostics = [], writes = [], unrelatedWrites = [];
      let diagnosticWriteFailure = false;
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
          if (classifyCockpitProofWrite(request.method(), pathname) !== "owner") return;
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
        await hardware.waitFor();
        await hardware.getByText("Hardware measurements", { exact: true }).click();
        assert.ok((await hardware.innerText()).includes(before.hardware.os.platform));
        await capture("hardware"); await hardware.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "review and cancel with no request";
        await panel.getByText("Advisory approval requests (no execution)", { exact: true }).click();
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
        const job = jobs.getByRole("region", { name: "Downloads", exact: true }).getByRole("listitem")
          .filter({ has: page.locator("code").and(page.getByText(receipt.jobId, { exact: true })) });
        const approvalHref = `/inbox?approvalId=${encodeURIComponent(receipt.approvalId)}&shell=cockpit#local-ai`;
        assert.equal(await job.getByRole("link", { name: "Review required approval", exact: true }).getAttribute("href"), approvalHref);
        await capture("retained-intent"); await jobs.getByRole("button", { name: "Close sheet", exact: true }).click();
        stage = "retain lost-response uncertainty without retry";
        const advisory = panel.getByText("Advisory approval requests (no execution)", { exact: true });
        if (await advisory.locator("..").getAttribute("open") === null) await advisory.click();
        let serveReceipt;
        const loseResponse = async (route) => { if (route.request().method() !== "POST") return route.continue();
          const result = await route.fetch(); assert.equal(result.status(), 201); serveReceipt = await result.json(); await route.abort("failed"); };
        await page.route("**/api/v1/local-ai/serve", loseResponse);
        await panel.getByRole("button", { name: "Request serve approval", exact: true }).click();
        await dialog.getByRole("button", { name: "Record approval request", exact: true }).click();
        const uncertain = panel.getByRole("alert").filter({ hasText: /^Request outcome is unconfirmed\./ });
        await uncertain.first().waitFor();
        assert.equal(writes.length, 2);
        assertLocalAiIntentAgreement({ kind: "serve", selected, request: writes[1].body, receipt: serveReceipt,
          owner: await api("/api/v1/local-ai/readiness"), replay: await api(`/api/v1/approvals/${serveReceipt.approvalId}/replay`) });
        await page.unroute("**/api/v1/local-ai/serve", loseResponse);
        await selectCockpitSettingsPage(page, { label: "General", href: "/settings/general" });
        await selectCockpitSettingsPage(page, { label: "Models", href: "/settings/models" });
        await page.getByRole("tab", { name: "Local AI", exact: true }).click();
        await uncertain.first().waitFor();
        await panel.getByText("Advisory approval requests (no execution)", { exact: true }).click();
        assert.equal(await panel.getByRole("button", { name: "Request serve approval", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 2); assert.deepEqual(unrelatedWrites, []);
        await capture("unknown-locked");
        return { status: "passed", metrics: { modelId: selected.modelId, backend: selected.backend, cancelWrites: 0, approvalIntentWrites: 2,
          exactOwnerAgreement: true, lostResponseInjected: true, appSessionRemountLock: true, blockingAxe: 0,
          diagnosticWriteFailure, limitation: "Actual host scan and actual approval intent in an isolated runtime. No approval resolution, model download, server start, provider configuration or inference." }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-local-ai-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve the original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, approvalIntentWrites: writes.length, diagnosticWriteFailure }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page); const blocking = audit.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        const diagnosticPath = path.join(context.artifactRoot, "diagnostics", `cockpit-local-ai-${variant}-${name}.json`);
        let snapshot;
        try { snapshot = await captureLocalAiAuditDiagnostic(page, audit, name); }
        catch { snapshot = { stage: name, diagnosticGap: true }; }
        const retained = await retainLocalAiAuditDiagnostic(snapshot, diagnosticPath);
        diagnosticWriteFailure ||= retained.writeFailure;
        if (retained.retained) diagnostics.push(relativeToRun(context, diagnosticPath));
        assert.deepEqual(blocking.map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-local-ai-${variant}-${name}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      }
    });
  }
}
