import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";

export function assertNotificationRoutingSaved({ receipt, canonical, submitted, previous, kind }) {
  assert.deepEqual(receipt, canonical, "Notification receipt differs from its canonical archived-inclusive read.");
  assert.equal(receipt.workspaceId, submitted.workspaceId);
  const input = submitted[kind];
  for (const [key, value] of Object.entries(input)) assert.deepEqual(receipt[key], value, `Notification ${key} differs from review.`);
  assert.equal(receipt.revision, previous ? previous.revision + 1 : 1);
  assert.ok(receipt[`${kind}Id`]);
  if (previous) { assert.equal(submitted.expectedRevision, previous.revision); assert.equal(receipt[`${kind}Id`], previous[`${kind}Id`]); }
}
const observed = promise => { void promise.catch(() => {}); return promise; };
export function assertNotificationFixtureGrant(grant, workspaceId) {
  assert.equal(grant.toolPattern, "channel.send"); assert.equal(grant.decision, "allow");
  assert.equal(grant.scope, "workspace"); assert.equal(grant.scopeRef, workspaceId);
  assert.equal(grant.grantType, "one_time"); assert.equal(grant.usesRemaining, 1);
  assert.deepEqual(grant.constraints, { allowedHosts: ["127.0.0.1"], mutationAllowed: true });
  assert.ok(grant.grantId && grant.createdBy); assert.equal(grant.revokedAt, undefined);
}

export function assertNotificationFixtureChannel({ created, canonical, runtime, workspaceId, baseUrl, topic }) {
  assert.deepEqual(canonical, created, "The fixture connection changed before its notification test.");
  assert.equal(canonical.catalogId, "channel.ntfy"); assert.equal(canonical.kind, "channel");
  assert.equal(canonical.key, "ntfy"); assert.equal(canonical.enabled, true);
  assert.equal(canonical.status, "connected"); assert.equal(canonical.workspaceId, workspaceId);
  assert.deepEqual(canonical.config, { baseUrl, topic });
  assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
  assert.equal(runtime.connectionId, canonical.connectionId); assert.equal(runtime.channelKey, "ntfy");
  assert.equal(runtime.enabled, true); assert.equal(runtime.metadata.setupReady, true);
  assert.equal(runtime.metadata.connectionStatus, "connected");
  // ready includes evidence of a prior live probe. It is not fabricated here;
  // the exact delivery below must establish the actual notification outcome.
}

/** This successful fixture may start queued; only a bound canonical delivered record completes its proof. */
export function assertNotificationDeliveryObserved({ result, canonical, previous, workspaceId, targetId, requireDelivered = false }) {
  assert.equal(result.event.workspaceId, workspaceId); assert.equal(result.event.source, "operator_test");
  assert.equal(result.event.eventType, "durable.attention_required");
  assert.ok(result.event.eventId); assert.equal(result.deliveries.length, 1);
  const initial = result.deliveries[0], before = previous ?? initial;
  assert.equal(initial.deliveryId, canonical.deliveryId); assert.equal(initial.eventId, result.event.eventId);
  assert.equal(initial.workspaceId, workspaceId); assert.equal(initial.targetId, targetId);
  assert.equal(initial.ruleId, "operator_test"); assert.equal(result.status, initial.status);
  assert.equal(initial.idempotencyKey, `notification:${result.event.eventId}:operator_test:${targetId}`);
  const identity = ({ status: _status, attemptCount: _attemptCount, lastError: _lastError, updatedAt: _updatedAt, ...record }) => record;
  assert.deepEqual(identity(canonical), identity(initial)); assert.deepEqual(identity(before), identity(initial));
  for (const record of [initial, before, canonical]) {
    assert.ok(["pending", "delivered"].includes(record.status), `Unexpected test delivery status: ${record.status}`);
    assert.ok(Number.isSafeInteger(record.attemptCount) && record.attemptCount >= 0);
    assert.ok(Number.isFinite(Date.parse(record.createdAt)) && Number.isFinite(Date.parse(record.updatedAt)));
    assert.ok(Date.parse(record.updatedAt) >= Date.parse(record.createdAt));
  }
  assert.ok(canonical.attemptCount >= before.attemptCount);
  assert.ok(Date.parse(canonical.updatedAt) >= Date.parse(before.updatedAt));
  if (before.status === "delivered" || requireDelivered) assert.equal(canonical.status, "delivered");
  return canonical.status === "delivered";
}

export function notificationFailureProjection({ delivery, queue, runtime, approvals, grant }) {
  return {
    delivery: delivery && { deliveryId: delivery.deliveryId, eventId: delivery.eventId, targetId: delivery.targetId,
      workspaceId: delivery.workspaceId, status: delivery.status, attemptCount: delivery.attemptCount,
      createdAt: delivery.createdAt, updatedAt: delivery.updatedAt, hasError: Boolean(delivery.lastError) },
    queue: queue?.deliveries?.map(item => ({ deliveryId: item.deliveryId, connectionId: item.connectionId,
      status: item.status, deliveryStatus: item.deliveryStatus, attempts: item.attempts, maxAttempts: item.maxAttempts,
      nextAttemptAt: item.nextAttemptAt, createdAt: item.createdAt, updatedAt: item.updatedAt,
      hasError: Boolean(item.error), hasStaleReason: Boolean(item.staleReason), hasFallbackReason: Boolean(item.fallbackReason),
      ...(String(item.error).includes("grant host constraints blocked this action") ? { policyReasonCode: "grant_host_constraints_block" } : {}) })),
    runtime: runtime && { connectionId: runtime.connectionId, channelKey: runtime.channelKey,
      enabled: runtime.enabled, ready: runtime.ready, hasError: Boolean(runtime.lastError),
      policy: runtime.runtimePolicy && Object.fromEntries(["pairing", "allowlist", "mentionGating", "typing", "activity", "presence"]
        .map(key => [key, runtime.runtimePolicy[key]])) },
    approvals: approvals?.items?.map(item => ({ approvalId: item.approvalId, status: item.status,
      kind: item.kind, createdAt: item.createdAt })),
    grant: grant && { grantId: grant.grantId, usesRemaining: grant.usesRemaining, revoked: Boolean(grant.revokedAt) },
  };
}

/** All actual deliveries terminate at this helper's unique task-owned loopback receiver. */
export async function runCockpitNotificationRoutingProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Requires disposable notification runtime.");
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(result.ok, `Notification owner request failed (${result.status}).`); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-notification-routing.${variant}`, lane: "ux-budgets",
      title: `Native routing review, loopback test delivery and revision checks ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let page, browserContext, receiver, grantId, workspaceId, connectionId, tested, retained, stage = "seed isolated outbound channel";
      const screenshots = [], diagnostics = [], writes = [], deliveries = [];
      const suffix = randomUUID().slice(0, 8), label = `Routing ${variant} ${suffix}`, ruleLabel = `Rule ${suffix}`, topic = `routing-${suffix}`;
      try {
        receiver = createServer((request, response) => {
          const chunks = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => {
            deliveries.push({ method: request.method, path: request.url, bytes: Buffer.concat(chunks).length });
            if (request.method !== "POST" || request.url !== `/${topic}`) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ id: `routing-${suffix}`, event: "message", topic, time: Math.floor(Date.now() / 1000) }));
          });
        });
        await new Promise((resolve, reject) => { receiver.once("error", reject); receiver.listen(0, "127.0.0.1", resolve); });
        const definition = (await api("/api/v1/integrations/catalog")).items.find(item => item.catalogId === "channel.ntfy");
        assert.equal(definition?.kind, "channel");
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Notification fixture ${suffix}`, ...(citadelId ? { citadelId } : {}) } });
        workspaceId = workspace.workspaceId;
        assert.ok(workspaceId && workspaceId !== "default");
        const baseUrl = `http://127.0.0.1:${receiver.address().port}`;
        const channel = await api("/api/v1/integrations/connections", { method: "POST", body: { catalogId: definition.catalogId,
          workspaceId, label: `Loopback ${suffix}`, enabled: true, status: "connected", config: { baseUrl, topic } } });
        connectionId = channel.connectionId;
        assertNotificationFixtureChannel({ created: channel,
          canonical: await api(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`),
          runtime: await api(`/api/v1/comms/runtime/${encodeURIComponent(connectionId)}`), workspaceId, baseUrl, topic });
        // One explicit operator grant for the isolated workspace and loopback host.
        // Shipped approval policy remains enabled; no global allow or profile bypass.
        const grant = await api("/api/v1/tools/grants", { method: "POST", body: { toolPattern: "channel.send", decision: "allow",
          scope: "workspace", scopeRef: workspaceId, grantType: "one_time", usesRemaining: 1,
          constraints: { allowedHosts: ["127.0.0.1"], mutationAllowed: true } } });
        grantId = grant.grantId; assertNotificationFixtureGrant(grant, workspaceId);
        const readGrant = async () => (await api(`/api/v1/tools/grants?scope=workspace&scopeRef=${encodeURIComponent(workspaceId)}&limit=100`)).items.find(item => item.grantId === grantId);
        assert.deepEqual(await readGrant(), grant);
        const readTargets = () => api(`/api/v1/notifications/targets?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`);
        const readRules = () => api(`/api/v1/notifications/rules?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => { const route = new URL(request.url()).pathname;
          if (["POST", "PATCH", "DELETE"].includes(request.method()) && route.startsWith("/api/v1/notifications/")) writes.push({ method: request.method(), route }); });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#integration-connections"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.getByRole("button", { name: "Add and manage integrations", exact: true }).click();
        await page.getByRole("region", { name: "Integration management", exact: true }).getByRole("button", { name: "Notification routing", exact: true }).click();
        const panel = page.getByRole("region", { name: "Notification routing", exact: true });
        stage = "create reviewed destination without premature mutation";
        await panel.getByRole("button", { name: "New destination", exact: true }).click();
        await panel.getByLabel("Destination label", { exact: true }).fill(label);
        await panel.getByRole("combobox", { name: "Notification channel", exact: true }).selectOption(channel.connectionId);
        await panel.getByRole("button", { name: "Review notification destination", exact: true }).click();
        let dialog = page.getByRole("dialog", { name: "Create notification destination?", exact: true });
        await dialog.waitFor(); assert.equal(writes.length, 0); await capture("destination-review");
        await dialog.getByRole("button", { name: "Cancel notification action", exact: true }).click();
        assert.equal(writes.length, 0); assert.equal((await readTargets()).items.some(item => item.label === label), false);
        await panel.getByRole("button", { name: "Review notification destination", exact: true }).click();
        const createdResponse = responseFor("POST", "/api/v1/notifications/targets");
        await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        const createdHttp = await createdResponse; assert.equal(createdHttp.status(), 201); const target = await createdHttp.json();
        assertNotificationRoutingSaved({ kind: "target", receipt: target, canonical: (await readTargets()).items.find(item => item.targetId === target.targetId), submitted: createdHttp.request().postDataJSON() });
        await panel.getByText(`Destination ${label}: active, revision 1, confirmed by the Gateway.`, { exact: true }).waitFor();
        stage = "create reviewed future-event rule";
        await panel.getByRole("button", { name: "New rule", exact: true }).click();
        await panel.getByLabel("Notification rule label", { exact: true }).fill(ruleLabel);
        const events = panel.getByRole("group", { name: "Events", exact: true });
        for (const box of await events.getByRole("checkbox").all()) await box.uncheck();
        await events.getByRole("checkbox", { name: "turn.failed", exact: true }).check();
        await panel.getByRole("group", { name: "Active destinations", exact: true }).getByRole("checkbox", { name: label, exact: true }).check();
        await panel.getByRole("button", { name: "Review notification rule", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Create notification rule?", exact: true });
        const ruleResponse = responseFor("POST", "/api/v1/notifications/rules");
        await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        const ruleHttp = await ruleResponse; assert.equal(ruleHttp.status(), 201); const rule = await ruleHttp.json();
        assertNotificationRoutingSaved({ kind: "rule", receipt: rule, canonical: (await readRules()).items.find(item => item.ruleId === rule.ruleId), submitted: ruleHttp.request().postDataJSON() });
        await panel.getByText(`Rule ${ruleLabel}: active, revision 1, confirmed by the Gateway.`, { exact: true }).waitFor();
        stage = "cancel a real delivery review then send once to loopback";
        await panel.getByText(`${label} · active`, { exact: true }).click();
        await panel.getByRole("button", { name: `Review test for ${label}`, exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Send test notification?", exact: true });
        await dialog.waitFor(); assert.ok((await dialog.innerText()).includes("real notification"));
        const prior = writes.length; await dialog.getByRole("button", { name: "Cancel notification action", exact: true }).click();
        assert.equal(writes.length, prior); assert.equal(deliveries.length, 0); assertNotificationFixtureGrant(await readGrant(), workspaceId);
        await panel.getByRole("button", { name: `Review test for ${label}`, exact: true }).click(); await capture("test-review");
        const testResponse = responseFor("POST", `/api/v1/notifications/targets/${target.targetId}/test`);
        await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        const testHttp = await testResponse; assert.equal(testHttp.status(), 200); tested = await testHttp.json();
        assert.deepEqual(testHttp.request().postDataJSON(), { workspaceId });
        const deliveryId = tested.deliveries?.[0]?.deliveryId;
        assert.ok(deliveryId);
        stage = "observe the exact queued delivery until canonical delivered settlement";
        const deadline = Date.now() + 30_000;
        let observations = 0;
        do {
          const items = (await api(`/api/v1/notifications/deliveries?workspaceId=${encodeURIComponent(workspaceId)}&limit=50`)).items;
          const matches = items.filter(item => item.deliveryId === deliveryId);
          assert.equal(matches.length, 1, "The exact test delivery is missing or duplicated in its canonical list.");
          const previous = retained; retained = matches[0]; observations++;
          const done = assertNotificationDeliveryObserved({ result: tested, canonical: retained, previous, workspaceId, targetId: target.targetId });
          if (done) break;
          await page.waitForTimeout(250);
        } while (Date.now() < deadline);
        assertNotificationDeliveryObserved({ result: tested, canonical: retained, workspaceId, targetId: target.targetId, requireDelivered: true });
        const deliveryDiagnosticDirectory = path.join(context.artifactRoot, "diagnostics");
        await mkdir(deliveryDiagnosticDirectory, { recursive: true });
        const deliveryDiagnostic = path.join(deliveryDiagnosticDirectory, `cockpit-notification-routing-${variant}-delivery.json`);
        await writeFile(deliveryDiagnostic, JSON.stringify({ status: tested.status, eventId: tested.event?.eventId,
          initial: notificationFailureProjection({ delivery: tested.deliveries[0] }).delivery,
          canonical: notificationFailureProjection({ delivery: retained }).delivery,
          observations, loopback: deliveries }, null, 2));
        diagnostics.push(relativeToRun(context, deliveryDiagnostic));
        assert.equal(deliveries.length, 1); assert.equal(deliveries[0].path, `/${topic}`); assert.ok(deliveries[0].bytes > 0);
        assert.equal((await readGrant()).usesRemaining, 0, "The exact one-time grant must be consumed by this send.");
        stage = "read-only native refresh settles the retained test evidence";
        const writesBeforeRefresh = writes.length;
        await panel.getByRole("button", { name: "Refresh notification routing", exact: true }).click();
        await panel.getByText(`Latest test for ${label}: delivered. Confirmed by the Gateway.`, { exact: true }).waitFor();
        assert.equal(writes.length, writesBeforeRefresh); assert.equal(deliveries.length, 1);
        assert.equal(writes.filter(item => item.method === "POST" && item.route.endsWith("/test")).length, 1);
        stage = "withhold stale archive and then apply the current exact revision";
        await panel.getByRole("button", { name: `Archive destination ${label}`, exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Archive notification destination?", exact: true });
        await dialog.waitFor();
        const targetRoute = `/api/v1/notifications/targets/${target.targetId}`;
        const peer = await api(targetRoute, { method: "PATCH", body: { workspaceId, expectedRevision: target.revision,
          target: { label, kind: target.kind, channelConnectionId: target.channelConnectionId, lifecycleState: "disabled" } } });
        const beforeStale = writes.length;
        await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        await panel.getByText("The reviewed notification configuration changed. Refresh and review it again.", { exact: true }).waitFor();
        assert.equal(writes.length, beforeStale);
        await panel.getByRole("button", { name: "Refresh notification routing", exact: true }).click();
        await panel.getByText(`${label} · disabled`, { exact: true }).waitFor();
        await panel.getByRole("button", { name: `Archive destination ${label}`, exact: true }).click();
        const archive = responseFor("PATCH", targetRoute); await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        const archivedHttp = await archive; assert.equal(archivedHttp.status(), 200); const archived = await archivedHttp.json();
        assertNotificationRoutingSaved({ kind: "target", previous: peer, receipt: archived, canonical: (await readTargets()).items.find(item => item.targetId === target.targetId), submitted: archivedHttp.request().postDataJSON() });
        await panel.getByText(`Destination ${label}: archived, revision ${archived.revision}, confirmed by the Gateway.`, { exact: true }).waitFor();
        await panel.getByText(`${ruleLabel} · active`, { exact: true }).click();
        await panel.getByRole("button", { name: `Archive rule ${ruleLabel}`, exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Archive notification rule?", exact: true });
        const ruleArchive = responseFor("PATCH", `/api/v1/notifications/rules/${rule.ruleId}`);
        await dialog.getByRole("button", { name: "Apply reviewed notification action", exact: true }).click();
        const archivedRuleHttp = await ruleArchive; assert.equal(archivedRuleHttp.status(), 200); const archivedRule = await archivedRuleHttp.json();
        assertNotificationRoutingSaved({ kind: "rule", previous: rule, receipt: archivedRule, canonical: (await readRules()).items.find(item => item.ruleId === rule.ruleId), submitted: archivedRuleHttp.request().postDataJSON() });
        await panel.getByText(`Rule ${ruleLabel}: archived, revision ${archivedRule.revision}, confirmed by the Gateway.`, { exact: true }).waitFor();
        await panel.scrollIntoViewIfNeeded(); await capture("saved");
        assert.equal(deliveries.length, 1); assert.equal((await readGrant()).usesRemaining, 0);
        return { status: "passed", metrics: { targetId: target.targetId, ruleId: rule.ruleId, workspaceId, oneTimeGrantId: grantId,
          fixtureAuthorization: "Canonical workspace grant, one channel.send use, loopback host only", cancellationWrites: 0, realLoopbackDeliveries: deliveries.length,
          initialDeliveryStatus: tested.status, finalDeliveryStatus: retained.status, deliveryObservations: observations,
          exactNumericCas: true, staleArchiveWithheld: true, independentDeliveryReadback: true, archivedReadback: true }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
        function responseFor(method, route) { return observed(page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === route)); }
      } catch (error) {
        if (workspaceId && connectionId) await captureFailureEvidence();
        if (page && !page.isClosed()) try { await screenshot("failure"); } catch { /* Keep primary failure. */ }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, writes, loopbackDeliveries: deliveries.length }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { try { await browserContext?.close();
        if (grantId) await api(`/api/v1/tools/grants/${grantId}/revoke`, { method: "POST", body: {} });
      } finally { if (receiver) { receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); } } }
      async function captureFailureEvidence() {
        try {
          const scope = encodeURIComponent(workspaceId), connection = encodeURIComponent(connectionId);
          const reads = await Promise.allSettled([
            api(`/api/v1/comms/deliveries?connectionId=${connection}&limit=50`),
            api(`/api/v1/comms/runtime/${connection}`),
            api(`/api/v1/approvals?workspaceId=${scope}&limit=100`),
            api(`/api/v1/tools/grants?scope=workspace&scopeRef=${scope}&limit=100`),
          ]);
          const value = index => reads[index].status === "fulfilled" ? reads[index].value : undefined;
          const projection = notificationFailureProjection({ delivery: retained ?? tested?.deliveries?.[0],
            queue: value(0), runtime: value(1), approvals: value(2), grant: value(3)?.items?.find(item => item.grantId === grantId) });
          const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-notification-routing-${variant}-failure-evidence.json`);
          await writeFile(file, JSON.stringify({ stage, workspaceId, connectionId, reads: reads.map(item => item.status), ...projection }, null, 2));
          diagnostics.push(relativeToRun(context, file));
        } catch { /* Diagnostics must not replace the original browser failure. */ }
      }
      async function screenshot(name) { const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const file = path.join(directory, `cockpit-notification-routing-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); }
      async function capture(name) { await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true }); const file = path.join(directory, `cockpit-notification-routing-${variant}-${name}-axe.json`);
          await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map(item => item.id), []); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); await screenshot(name); }
    });
  }
}
