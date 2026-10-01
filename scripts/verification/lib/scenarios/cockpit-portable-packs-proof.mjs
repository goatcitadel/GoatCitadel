import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export function assertPortablePackStage({ preview, receipt, staged, envelopes }) {
  assert.equal(receipt.packId, preview.manifest.packId);
  assert.equal(receipt.actorId, "operator"); assert.ok(receipt.evidenceEnvelopeId);
  assert.deepEqual(receipt.preview, preview); assert.deepEqual(receipt.stagedAssets, preview.installPlan);
  const records = staged.items.filter(item => item.evidenceEnvelopeId === receipt.evidenceEnvelopeId);
  assert.equal(records.length, 1);
  const manifest = preview.manifest;
  assert.deepEqual(records[0], { packId: manifest.packId, name: manifest.name, version: manifest.version,
    trustTier: manifest.trustTier, source: manifest.provenance.source, actorId: "operator", stagedAt: receipt.installedAt,
    status: "staged_for_review", reviewRequired: preview.reviewRequired, stagedAssets: preview.installPlan,
    evidenceEnvelopeId: receipt.evidenceEnvelopeId, contentHash: manifest.provenance.contentHash });
  const envelope = envelopes.items.find(item => item.envelopeId === receipt.evidenceEnvelopeId);
  assert.ok(envelope); assert.equal(envelope.eventKind, "capability_pack_install");
  assert.equal(envelope.publicProjection?.metadataRedacted ?? false, false);
  for (const key of ["workspaceId", "sessionId", "turnId", "runId"]) assert.equal(envelope[key], undefined);
  assert.equal(envelope.createdAt, receipt.installedAt);
  assert.deepEqual(envelope.metadata, { packId: manifest.packId, actorId: "operator", trustTier: manifest.trustTier,
    name: manifest.name, version: manifest.version, manifest, reviewRequired: preview.reviewRequired,
    status: "staged_for_review", installPlan: preview.installPlan, provenance: manifest.provenance });
  return records[0];
}
export function assertPortablePackReview({ source, receipt, staged, envelopes }) {
  assert.equal(receipt.packId, source.packId); assert.equal(receipt.sourceEvidenceEnvelopeId, source.evidenceEnvelopeId);
  assert.notEqual(receipt.evidenceEnvelopeId, source.evidenceEnvelopeId); assert.ok(receipt.evidenceEnvelopeId);
  assert.equal(receipt.actorId, "operator"); assert.equal(receipt.status, "materialization_recorded");
  assert.equal(receipt.assets.length, source.stagedAssets.length);
  assert.equal(new Set(receipt.assets.map(item => item.assetId)).size, receipt.assets.length);
  for (const asset of receipt.assets) {
    const original = source.stagedAssets.find(item => item.assetId === asset.assetId); assert.ok(original);
    assert.equal(asset.kind, original.kind); assert.equal(asset.requested, true); assert.equal(asset.callableState, "unchanged");
    const outcome = original.outcome === "unsupported" ? "blocked" : original.kind === "runtime_preset" ? "evidence_recorded" : "review_recorded";
    assert.equal(asset.outcome, outcome); assert.equal(asset.activationSemantics, outcome === "blocked" ? "blocked" : outcome === "evidence_recorded" ? "evidence_only" : "requires_existing_surface");
  }
  assert.deepEqual(staged.items.find(item => item.evidenceEnvelopeId === source.evidenceEnvelopeId), { ...source,
    latestMaterialization: { evidenceEnvelopeId: receipt.evidenceEnvelopeId, materializedAt: receipt.materializedAt,
      actorId: "operator", status: receipt.status, assetCount: receipt.assets.length } });
  const evidence = envelopes.items.find(item => item.envelopeId === receipt.evidenceEnvelopeId); assert.ok(evidence);
  assert.equal(evidence.eventKind, "capability_pack_materialization"); assert.equal(evidence.createdAt, receipt.materializedAt);
  assert.equal(evidence.publicProjection?.metadataRedacted ?? false, false);
  for (const key of ["workspaceId", "sessionId", "turnId", "runId"]) assert.equal(evidence[key], undefined);
  for (const [key, value] of Object.entries({ packId: source.packId, sourceEvidenceEnvelopeId: source.evidenceEnvelopeId,
    sourceContentHash: source.contentHash, actorId: "operator", status: receipt.status, assets: receipt.assets, limitations: receipt.limitations })) assert.deepEqual(evidence.metadata[key], value);
}
export function assertPortablePackSetup({ manifest, workspaceId, request, receipt, owner }) {
  assert.deepEqual(request, { workspaceId, surface: "settings", request: { kind: "capability_pack", packId: manifest.packId,
    manifestHash: manifest.provenance.contentHash, assetIds: manifest.assets.filter(asset => asset.binding).map(asset => asset.id) } });
  assert.deepEqual(receipt, owner); assert.equal(receipt.kind, "capability_pack"); assert.equal(receipt.scope, "capability");
  assert.equal(receipt.origin.workspaceId, workspaceId); assert.equal(receipt.origin.surface, "settings");
  assert.equal(receipt.origin.sessionId, undefined); assert.equal(receipt.origin.turnId, undefined);
  assert.deepEqual(receipt.request, request.request); assert.equal(receipt.status, "awaiting_confirmation");
  assert.equal(receipt.requiredAction.kind, "confirmation"); assert.notEqual(receipt.requiredAction.purpose, "rollback");
  assert.ok(receipt.requiredAction.actionNonce); assert.ok(receipt.requiredAction.actionId);
  assert.equal(receipt.adapter.adapterId, "capability-pack-execution"); assert.equal(receipt.adapter.version, 1);
  assert.equal(receipt.target.ownerId, "capability_pack"); assert.equal(receipt.target.resourceId, `${workspaceId}:${manifest.packId}`);
  assert.match(receipt.target.expectedHash, /^[a-f0-9]{64}$/u); assert.match(receipt.intentHash, /^[a-f0-9]{64}$/u);
  assert.ok(!receipt.evidenceRefs.some(ref => ref.startsWith("change_plan:")), "No child execution is expected before confirmation");
}

/** Real isolated Gateway evidence and unexecuted setup plans. Never confirms setup, connects transport or invokes tools. */
export async function runCockpitPortablePacksProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-portable-packs.${variant}`, lane: "ux-budgets",
      title: `Portable pack evidence and unexecuted setup review ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "read isolated owners", browserContext, page;
      const writes = [], unrelated = [], previews = [], screenshots = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const suffix = randomUUID().slice(0, 8), label = `Portable proof ${variant} ${suffix}`;
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId, name: label, slug: `portable-${suffix}` } });
        const catalog = await api("/api/v1/capability-packs"), bundled = catalog.items.find(item => item.assets.some(asset => asset.binding) && item.assets.filter(asset => asset.binding).length <= 32);
        assert.ok(bundled, "At least one actual bound bundled definition is required");
        const setupPreview = await api(`/api/v1/capability-packs/${encodeURIComponent(bundled.packId)}/preview`);
        const unchangedServers = await api("/api/v1/mcp/servers");
        const local = { packId: `portable-proof-${suffix}`, name: label, version: "1.0.0", description: "Disposable portable metadata; no execution bindings.", trustTier: "restricted", tags: ["verification"],
          assets: Array.from({ length: 31 }, (_, index) => ({ id: `asset-${index}`, label: `Reviewed metadata ${index + 1}`, kind: index === 30 ? "addon" : "runtime_preset", runtimeSupport: index === 30 ? "unsupported" : "available", installMode: index === 30 ? "unsupported" : "review_required" })),
          policyDefaults: { requireFirstUseApproval: true, memoryWriteAuthority: "operator_controlled", redactionMode: "strict", autoRunEnabled: false },
          provenance: { source: "local_file", publisher: "Disposable verification fixture" }, installWarnings: ["Metadata-only fixture; no capability execution."] };
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          const entry = { method: request.method(), pathname, body: request.postDataJSON() };
          if (request.method() === "POST" && pathname === "/api/v1/capability-packs/local/preview") previews.push(entry);
          else if (request.method() === "POST" && (pathname === "/api/v1/capability-packs/local/install" || /^\/api\/v1\/capability-packs\/staged\/[^/]+\/materialize$/u.test(pathname) || pathname === "/api/v1/change-plans" || /^\/api\/v1\/change-plans\/[^/]+\/cancellations$/u.test(pathname))) writes.push(entry);
          else unrelated.push(`${request.method()} ${pathname}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#addons"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Portable capability packs", exact: true });
        const sheet = () => page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Close pack inspection", exact: true }) });
        const dialog = name => page.getByRole("dialog", { name, exact: true });
        const waitPost = pathname => { const pending = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === pathname); void pending.catch(() => {}); return pending; };
        stage = "review bundled setup with no execution";
        await panel.getByRole("button", { name: `Inspect ${bundled.name}`, exact: true }).click();
        await sheet().getByRole("button", { name: "Review setup plan", exact: true }).click();
        await dialog("Create reviewed setup plan").waitFor(); await capture("setup-review", dialog("Create reviewed setup plan"));
        await dialog("Create reviewed setup plan").getByRole("button", { name: "Cancel setup review", exact: true }).click(); assert.equal(writes.length, 0);
        await sheet().getByRole("button", { name: "Review setup plan", exact: true }).click();
        const creation = waitPost("/api/v1/change-plans");
        await dialog("Create reviewed setup plan").getByRole("button", { name: "Create reviewed setup plan", exact: true }).click();
        const createdResponse = await creation; assert.equal(createdResponse.status(), 201); const plan = await createdResponse.json();
        await dialog("Create reviewed setup plan").waitFor({ state: "hidden" });
        const planPath = `/api/v1/change-plans/${encodeURIComponent(plan.planId)}`;
        assertPortablePackSetup({ manifest: setupPreview.manifest, workspaceId: workspace.workspaceId, request: writes[0].body, receipt: plan, owner: await api(`${planPath}?workspaceId=${encodeURIComponent(workspace.workspaceId)}`) });
        await sheet().getByRole("button", { name: "Cancel pending setup", exact: true }).click();
        const cancelResponse = waitPost(`${planPath}/cancellations`);
        await dialog("Cancel pending setup").getByRole("button", { name: "Submit reviewed plan action", exact: true }).click();
        const cancelledResponse = await cancelResponse; assert.equal(cancelledResponse.status(), 200); const cancelled = await cancelledResponse.json();
        assert.deepEqual(writes[1].body, { workspaceId: workspace.workspaceId, expectedRevision: plan.revision, actionNonce: plan.requiredAction.actionNonce });
        assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.planId, plan.planId); assert.deepEqual(cancelled.request, plan.request);
        assert.deepEqual(await api(`${planPath}?workspaceId=${encodeURIComponent(workspace.workspaceId)}`), cancelled);
        await dialog("Cancel pending setup").waitFor({ state: "hidden" });
        await sheet().getByRole("button", { name: "Close pack inspection", exact: true }).click();
        stage = "preview bounded portable manifest via actual file input";
        await panel.getByRole("button", { name: "Import portable pack", exact: true }).click();
        await sheet().getByLabel("Manifest file", { exact: true }).setInputFiles({ name: "portable.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(local)) });
        const previewResponse = waitPost("/api/v1/capability-packs/local/preview");
        await sheet().getByRole("button", { name: "Preview portable manifest", exact: true }).click();
        const previewResult = await previewResponse; assert.equal(previewResult.status(), 200); const preview = await previewResult.json();
        assert.equal(preview.manifest.provenance.source, "local_file");
        assert.equal(await sheet().getByRole("button", { name: "Review setup plan", exact: true }).count(), 0);
        await sheet().getByRole("button", { name: "Show more preview assets", exact: true }).click();
        await capture("portable-preview", sheet());
        stage = "cancel then stage exact reviewed installation evidence";
        await sheet().getByRole("button", { name: "Review pack staging", exact: true }).click();
        await dialog("Stage reviewed pack").getByRole("button", { name: "Cancel pack review", exact: true }).click(); assert.equal(writes.length, 2);
        await sheet().getByRole("button", { name: "Review pack staging", exact: true }).click();
        const stageResponse = waitPost("/api/v1/capability-packs/local/install");
        await dialog("Stage reviewed pack").getByRole("button", { name: "Stage reviewed pack", exact: true }).click();
        const stagedResult = await stageResponse; assert.equal(stagedResult.status(), 201); const receipt = await stagedResult.json();
        await sheet().getByText(`${label} staged and exact evidence confirmed. No capability was enabled or executed.`, { exact: true }).waitFor();
        assert.deepEqual(writes[2].body, { manifest: local, actorId: "operator" });
        const source = assertPortablePackStage({ preview, receipt, staged: await api("/api/v1/capability-packs/staged"), envelopes: await api("/api/v1/evidence/envelopes?limit=500") });
        await sheet().getByRole("button", { name: "Prepare read-only export", exact: true }).click();
        await sheet().getByText(`${label} export prepared. No mutation occurred.`, { exact: true }).waitFor();
        const exported = await api(`/api/v1/capability-packs/${encodeURIComponent(local.packId)}/export`);
        assert.deepEqual(exported.manifest, preview.manifest); assert.equal(exported.readOnly, true); assert.equal(exported.mutationSemantics, "none");
        await sheet().getByRole("button", { name: "Close pack inspection", exact: true }).click();
        stage = "materialize review evidence with unchanged callability";
        await panel.getByRole("button", { name: `Review evidence for ${label}`, exact: true }).click();
        const recordPath = `/api/v1/capability-packs/staged/${encodeURIComponent(receipt.evidenceEnvelopeId)}/materialize`, recordResponse = waitPost(recordPath);
        await dialog("Record pack review evidence").getByRole("button", { name: "Record reviewed evidence", exact: true }).click();
        const recordedResponse = await recordResponse; assert.equal(recordedResponse.status(), 200); const recorded = await recordedResponse.json();
        await panel.getByText("Review evidence recorded for 31 assets. Callable state and runtime policy are unchanged.", { exact: true }).waitFor();
        assertPortablePackReview({ source, receipt: recorded, staged: await api("/api/v1/capability-packs/staged"), envelopes: await api("/api/v1/evidence/envelopes?limit=500") });
        await capture("recorded", panel);
        stage = "retain unknown real stage acknowledgement across route remount";
        await panel.getByRole("button", { name: "Import portable pack", exact: true }).click();
        await sheet().getByRole("button", { name: "Preview portable manifest", exact: true }).click();
        await sheet().getByRole("button", { name: "Review pack staging", exact: true }).click();
        let lostReceipt, losses = 0;
        const lose = async route => { if (route.request().method() !== "POST") return route.continue(); losses++; const result = await route.fetch(); assert.equal(result.status(), 201); lostReceipt = await result.json(); await route.abort("failed"); };
        await page.route("**/api/v1/capability-packs/local/install", lose);
        await dialog("Stage reviewed pack").getByRole("button", { name: "Stage reviewed pack", exact: true }).click();
        await sheet().getByText(/^Pack action outcome is unconfirmed\./u).waitFor(); assert.equal(losses, 1);
        assertPortablePackStage({ preview, receipt: lostReceipt, staged: await api("/api/v1/capability-packs/staged"), envelopes: await api("/api/v1/evidence/envelopes?limit=500") });
        await page.unroute("**/api/v1/capability-packs/local/install", lose);
        await sheet().getByRole("button", { name: "Close pack inspection", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Connections", exact: true }).click();
        await page.getByRole("tab", { name: "Add-ons & packs", exact: true }).click();
        await panel.getByText(/^Pack action outcome is unconfirmed\./u).waitFor();
        assert.equal(await panel.getByRole("button", { name: `Review evidence for ${label}`, exact: true }).first().isDisabled(), true);
        assert.equal(writes.length, 5); assert.deepEqual(unrelated, []); assert.deepEqual(await api("/api/v1/mcp/servers"), unchangedServers);
        assert.ok(previews.length >= 3); await capture("unknown-locked", panel);
        return { status: "passed", metrics: { browserWrites: 5, readOnlyPreviewPosts: previews.length, cancelledReviewsZeroWrites: true,
          exactStageEvidence: true, exactMaterializationEvidence: true, unchangedCallability: true, exactUnexecutedSetupPlan: true,
          setupCancelled: true, lostResponseInjected: true, remountUnknownLock: true, unchangedMcpOwners: true, blockingAxe: 0,
          limitation: "Metadata staging/review and unexecuted bundled setup only. No setup confirmation, remote transport, provider request, skill activation or tool invocation." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await capture("failure", null, false); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserWrites: writes.length, unexpectedMutations: unrelated }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, target, audit = true) {
        await mkdir(screenshotDir, { recursive: true }); if (target) await target.scrollIntoViewIfNeeded();
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page);
          assert.deepEqual(result.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const file = path.join(screenshotDir, `ux-budgets-cockpit-portable-packs-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
