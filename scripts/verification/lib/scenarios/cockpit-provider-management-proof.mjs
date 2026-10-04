import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { DETERMINISTIC_LLM_MODEL, startDeterministicLlmStub } from "./deterministic-llm-stub.mjs";
import { buildClassicOwnerUrl } from "./classic-owner-navigation.mjs";

const providerAt = (config, providerId) => config.providerConfigs?.find((provider) => provider.providerId === providerId);
/** Keep a scheduled browser wait observed if its preceding UI action fails first. */
export function observeProviderResponse(response) {
  void response.catch(() => {});
  return response;
}
export function assertProviderRemovalApproval({ plan, replay, providerId, settingsRevision, status }) {
  assert.equal(plan.kind, "provider_connection");
  assert.equal(plan.origin.workspaceId, "default");
  assert.equal(plan.origin.surface, "settings");
  assert.equal(plan.origin.sessionId, undefined);
  assert.equal(plan.origin.turnId, undefined);
  assert.equal(plan.target.ownerId, "provider_connection");
  assert.equal(plan.target.resourceId, providerId);
  assert.equal(plan.target.expectedRevision, settingsRevision);
  assert.equal(plan.request.providerId, providerId);
  assert.equal(plan.request.credentialAction, "remove_api_key");
  assert.equal(plan.request.credentialDeleteScope, "all");
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(plan.requiredAction?.kind, "approval");
  const approval = replay.approval;
  assert.ok(plan.approvalRefs.includes(approval.approvalId));
  assert.equal(approval.approvalId, plan.requiredAction.approvalId);
  assert.equal(approval.kind, "change_plan_effect");
  assert.equal(approval.status, status);
  assert.equal(approval.linkage.workspaceId, "default");
  for (const [key, value] of Object.entries({ planId: plan.planId, kind: plan.kind, scope: plan.scope,
    intentHash: plan.intentHash, targetOwnerId: plan.target.ownerId, targetResourceId: plan.target.resourceId,
    targetRevision: plan.target.expectedRevision, targetHash: plan.target.expectedHash,
    adapterId: plan.adapter.adapterId, adapterVersion: plan.adapter.version })) assert.deepEqual(approval.payload[key], value);
}
function assertSavedSettingsUnchanged(before, after) {
  for (const field of ["revision", "activeProviderId", "activeModel", "providerConfigs"])
    assert.deepEqual(after[field], before[field], `Review changed saved ${field}.`);
}
export function assertProviderProfileReceipt({ before, after, submitted, plan, credentialStorage }) {
  assert.equal(plan.kind, "provider_connection");
  assert.equal(plan.origin?.workspaceId, "default");
  assert.equal(plan.origin?.surface, "settings");
  assert.equal(plan.target?.ownerId, "provider_connection");
  assert.equal(plan.target?.resourceId, submitted.providerId);
  const checkpoint = plan.result?.providerProfileCheckpoint;
  if (checkpoint) {
    assert.deepEqual(checkpoint, { version: "provider_profile_checkpoint.v1", providerId: submitted.providerId,
      originalRevision: before.revision, appliedRevision: plan.target.expectedRevision, intentHash: plan.intentHash });
    assert.ok(checkpoint.appliedRevision > before.revision);
    assert.ok(plan.evidenceRefs.includes(`provider_profile:${submitted.providerId}:settings_revision:${checkpoint.appliedRevision}`));
  } else assert.equal(plan.target?.expectedRevision, before.revision);
  const { providerId, ...profile } = submitted;
  assert.deepEqual(plan.request, { kind: "provider_connection", providerId, profile,
    ...(credentialStorage ? { credentialStorage, ...(credentialStorage === "env" ? { credentialEnvVar: submitted.apiKeyEnv } : {}) } : {}) });
  assert.ok(["completed", "applied"].includes(plan.status), "The reviewed Settings save did not complete its governed profile plan.");
  assertProviderManagementSaved({ before, after, submitted });
}
export function assertProviderManagementSaved({ before, after, submitted }) {
  assert.ok(after.revision > before.revision, "The provider owner revision did not advance.");
  assert.equal(after.activeProviderId, before.activeProviderId, "Profile management changed installation routing.");
  assert.equal(after.activeModel, before.activeModel, "Profile management changed the default model.");
  const saved = providerAt(after, submitted.providerId);
  assert.ok(saved, "The exact saved provider is absent.");
  for (const [key, value] of Object.entries(submitted)) assert.deepEqual(saved[key], value, `Saved ${key} differs from review.`);
}
export function assertProviderTransportSaved({ before, after, submitted, response }) {
  const { request, ...publicProfile } = submitted;
  assertProviderManagementSaved({ before, after, submitted: publicProfile });
  const receipt = response.providerTransportReceipt;
  assert.ok(receipt, "The Gateway did not attest the exact transport command.");
  assert.equal(receipt.version, "llm.provider_transport_receipt.v1");
  assert.equal(receipt.providerId, submitted.providerId);
  assert.equal(receipt.expectedRevision, before.revision);
  assert.equal(receipt.appliedRevision, before.revision + 1);
  assert.equal(response.revision, receipt.appliedRevision);
  assert.equal(after.revision, receipt.appliedRevision);
  assert.deepEqual(receipt.acceptedHeaderNames, [...new Set(Object.keys(request.headers ?? {}).map(name => name.trim()).filter(Boolean))].sort());
  const savedRequest = providerAt(after, submitted.providerId).request;
  assert.deepEqual(savedRequest ?? null, receipt.publicRequest ?? null);
  assert.equal(savedRequest?.headers, undefined, "Hidden transport header values leaked in public readback.");
  for (const [field, value] of Object.entries(request)) {
    if (field !== "headers") assert.deepEqual(savedRequest?.[field], value, `Saved public transport ${field} differs from review.`);
  }
}

/** Creates only unique profiles and synthetic credentials in the disposable verification runtime. */
export async function runCockpitProviderManagementProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `Provider management owner request failed (${response.status}).`);
    return response.body;
  };
  const readConfig = () => api("/api/v1/llm/config");
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-provider-management.${variant}`, lane: "ux-budgets",
      title: `Native provider profile, transport and credential removal ${variant}`, subsystem: "mission-control-ux" }, async () => {
      assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Provider proof requires a disposable runtime.");
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12), providerId = `verification-profile-${suffix}`;
      const envVar = `UX_PROFILE_${suffix.toUpperCase()}_KEY`, label = `Profile proof ${variant}`;
      const screenshots = [], writes = [], diagnostics = [];
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      let page, browserContext, stub, stage = "create loopback fixture";
      try {
        stub = await startDeterministicLlmStub();
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/"))
            writes.push({ method: request.method(), path: pathname }); // Never record credential inputs.
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/models?shell=cockpit#providers"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Provider profiles", exact: true });
        const beforeCreate = await readConfig();
        stage = "review new profile without an owner write";
        await panel.getByRole("button", { name: "Add provider profile", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "New provider profile", exact: true });
        await editor.getByLabel("Provider ID", { exact: true }).fill(providerId);
        await editor.getByLabel("Provider label", { exact: true }).fill(label);
        await editor.getByLabel("Provider base URL", { exact: true }).fill(stub.baseUrl);
        await editor.getByLabel("Profile default model", { exact: true }).fill(DETERMINISTIC_LLM_MODEL);
        await editor.getByLabel("Provider API style", { exact: true }).selectOption("openai-chat-completions");
        await editor.getByLabel("Credential mode", { exact: true }).selectOption("api-key");
        await editor.getByLabel("API key environment variable", { exact: true }).fill(envVar);
        await editor.getByRole("combobox", { name: "New credential storage", exact: true }).selectOption("env");
        await editor.getByRole("button", { name: "Review provider profile", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Review provider profile", exact: true });
        await review.waitFor();
        assert.ok((await review.innerText()).includes(stub.baseUrl));
        await capture("profile-review");
        await review.getByRole("button", { name: "Keep editing", exact: true }).click();
        assert.deepEqual(writes, [], "Cancelling profile review wrote to an owner.");
        assertSavedSettingsUnchanged(beforeCreate, await readConfig());
        const submitted = { providerId, label, baseUrl: stub.baseUrl, apiStyle: "openai-chat-completions", authMode: "api-key", defaultModel: DETERMINISTIC_LLM_MODEL, apiKeyEnv: envVar };
        stage = "create and confirm exact profile";
        await editor.getByRole("button", { name: "Review provider profile", exact: true }).click();
        let owner = await submitProfile(beforeCreate, submitted, review, true);
        await panel.getByRole("combobox", { name: "Manage provider", exact: true }).selectOption(providerId);
        stage = "edit and confirm exact profile";
        await panel.getByRole("button", { name: "Edit provider profile", exact: true }).click();
        const edit = page.getByRole("dialog", { name: "Edit provider profile", exact: true });
        await edit.getByLabel("Provider label", { exact: true }).fill(`${label} edited`);
        await edit.getByRole("button", { name: "Review provider profile", exact: true }).click();
        owner = await submitProfile(owner, { ...submitted, label: `${label} edited` }, review);
        stage = "review and save transport through its dedicated owner";
        await panel.getByRole("button", { name: "Edit provider profile", exact: true }).click();
        await edit.getByText("Advanced request transport", { exact: true }).click();
        await edit.getByLabel("Extra request headers", { exact: true }).fill('{"X-Verification-Profile":"reviewed"}');
        await edit.getByRole("button", { name: "Review provider profile", exact: true }).click();
        const transport = page.getByRole("dialog", { name: "Review provider transport", exact: true });
        await transport.waitFor();
        const beforeTransport = await readConfig();
        await capture("transport-review");
        assertSavedSettingsUnchanged(owner, beforeTransport);
        const transportResponse = responseFor("PATCH", "/api/v1/llm/config");
        await transport.getByRole("button", { name: "Apply reviewed transport", exact: true }).click();
        const savedTransport = await transportResponse;
        assert.equal(savedTransport.status(), 200);
        assert.deepEqual(savedTransport.request().postDataJSON(), { expectedRevision: beforeTransport.revision,
          upsertProvider: { providerId, request: { headers: { "X-Verification-Profile": "reviewed" } } } });
        const transportReceipt = await savedTransport.json(); owner = await readConfig();
        assert.equal(owner.revision, transportReceipt.revision);
        assertProviderTransportSaved({ before: beforeTransport, after: owner, response: transportReceipt,
          submitted: { ...submitted, label: `${label} edited`, request: { headers: { "X-Verification-Profile": "reviewed" } } } });
        await edit.waitFor({ state: "hidden" });
        stage = "prepare isolated synthetic credential for native removal";
        const secretPlan = await api("/api/v1/change-plans", { method: "POST", body: { workspaceId: "default", surface: "settings",
          request: { kind: "provider_connection", providerId, credentialAction: "replace_api_key", credentialStorage: "env", credentialEnvVar: envVar } } });
        assert.equal(secretPlan.requiredAction?.kind, "secure_input");
        const staged = await api(`/api/v1/change-plans/${encodeURIComponent(secretPlan.planId)}/provider-secret`, { method: "POST", body: {
          workspaceId: "default", expectedRevision: secretPlan.revision, actionId: secretPlan.requiredAction.actionId,
          actionNonce: secretPlan.requiredAction.actionNonce, apiKey: "verification-profile-disposable-key" } });
        stub.replaceExpectedAuthorization("Bearer verification-profile-disposable-key");
        const installed = await api(`/api/v1/change-plans/${encodeURIComponent(staged.planId)}/confirmations`, { method: "POST", body: {
          workspaceId: "default", expectedRevision: staged.revision, actionNonce: staged.requiredAction.actionNonce } });
        assert.ok(["completed", "applied"].includes(installed.status));
        const secretRoute = `/api/v1/secrets/providers/${encodeURIComponent(providerId)}`;
        assert.equal((await api(`${secretRoute}/status`)).hasSecret, true);
        await panel.getByRole("button", { name: "Refresh profiles", exact: true }).click();
        stage = "cancel then confirm native credential removal";
        await panel.getByRole("button", { name: "Remove saved API credential", exact: true }).click();
        const remove = page.getByRole("dialog", { name: "Remove saved API credential?", exact: true });
        const beforeCancel = writes.length;
        await remove.getByRole("button", { name: "Keep credential", exact: true }).click();
        assert.equal(writes.length, beforeCancel);
        assert.equal((await api(`${secretRoute}/status`)).hasSecret, true);
        await panel.getByRole("button", { name: "Remove saved API credential", exact: true }).click();
        await capture("credential-removal-review");
        const beforeRemoval = await readConfig(), removalResponse = responseFor("DELETE", secretRoute);
        await remove.getByRole("button", { name: "Request credential removal", exact: true }).click();
        const removed = await removalResponse; assert.equal(removed.status(), 200);
        assert.deepEqual(removed.request().postDataJSON(), { expectedRevision: beforeRemoval.revision, storage: "all" });
        const removalReceipt = await removed.json();
        const removalPlan = await readPlan(removalReceipt.changePlanReceipt.planId);
        assert.equal(removalPlan.target.expectedRevision, beforeRemoval.revision);
        assert.equal(removalPlan.request.providerId, providerId);
        assert.equal(removalPlan.request.credentialAction, "remove_api_key");
        assert.equal((await api(`${secretRoute}/status`)).hasSecret, true, "Removal preview changed the secret before confirmation.");
        await recordPlan(removalPlan);
        const approvalId = removalPlan.requiredAction?.approvalId;
        assert.ok(approvalId, "Credential removal must have its canonical approval before continuation.");
        const replayRoute = `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`;
        assertProviderRemovalApproval({ plan: removalPlan, replay: await api(replayRoute), providerId,
          settingsRevision: beforeRemoval.revision, status: "pending" });
        await panel.getByRole("button", { name: "Review required step", exact: true }).click();
        const approvalDialog = page.getByRole("dialog");
        const approvalOwner = approvalDialog.getByRole("link", { name: "Review required approval", exact: true });
        await approvalOwner.waitFor();
        assert.equal(await approvalOwner.getAttribute("href"), buildClassicOwnerUrl(`/ops/approvals?approvalId=${encodeURIComponent(approvalId)}&shell=classic`));
        assert.ok((await approvalDialog.innerText()).includes("separate canonical approval"));
        await capture("credential-approval-review");
        await approvalDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        const continueRemoval = panel.getByRole("button", { name: "Continue approved change", exact: true });
        const beforeUnapproved = writes.length;
        await continueRemoval.click();
        await panel.getByText("The approval is not approved yet. Review the required approval first.", { exact: true }).waitFor();
        assert.equal(writes.length, beforeUnapproved, "An unapproved credential removal attempted to continue.");
        assert.equal((await api(`${secretRoute}/status`)).hasSecret, true);
        // Resolve this isolated fixture's exact canonical approval; Inbox decision UI has its own browser journey.
        const decision = await api(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: "POST",
          body: { decision: "approve", resolutionNote: "Approve removal of this disposable verification provider credential only." } });
        assert.equal(decision.approval.approvalId, approvalId); assert.equal(decision.approval.status, "approved");
        const approvedRemoval = await readPlan(removalPlan.planId);
        assertProviderRemovalApproval({ plan: approvedRemoval, replay: await api(replayRoute), providerId,
          settingsRevision: beforeRemoval.revision, status: "approved" });
        assert.equal((await api(`${secretRoute}/status`)).hasSecret, true, "Approval alone applied credential removal.");
        const continuedResponse = responseFor("POST", `/api/v1/change-plans/${encodeURIComponent(removalPlan.planId)}/responses`);
        await continueRemoval.click();
        const continuedHttp = await continuedResponse; assert.equal(continuedHttp.status(), 200);
        assert.deepEqual(continuedHttp.request().postDataJSON(), { workspaceId: "default", expectedRevision: approvedRemoval.revision,
          actionId: approvedRemoval.requiredAction.actionId, actionNonce: approvedRemoval.requiredAction.actionNonce, values: {} });
        const completedRemoval = await continuedHttp.json(); await recordPlan(completedRemoval);
        assert.equal(completedRemoval.planId, removalPlan.planId); assert.deepEqual(completedRemoval.request, removalPlan.request);
        assert.ok(["completed", "applied"].includes(completedRemoval.status), "The approved removal did not complete.");
        assert.ok(completedRemoval.evidenceRefs.includes(`provider:${providerId}:api_key:all:absent`));
        const secret = await api(`${secretRoute}/status`);
        assert.equal(secret.providerId, providerId); assert.equal(secret.hasSecret, false);
        const finalConfig = await readConfig();
        assert.equal(finalConfig.activeProviderId, beforeCreate.activeProviderId); assert.equal(finalConfig.activeModel, beforeCreate.activeModel);
        await panel.getByText("No stored API credential", { exact: false }).waitFor();
        stage = "inspect OAuth status without external login";
        const oauthStatus = await api("/api/v1/llm/providers/openai-codex/oauth/status");
        const oauth = panel.getByRole("region", { name: "ChatGPT OAuth", exact: true });
        await oauth.getByRole("button", { name: "Refresh OAuth status", exact: true }).click();
        await oauth.getByText(`Login: ${oauthStatus.connected ? "Connected" : oauthStatus.requiresReauth ? "Reauthorization required" : "Not connected"}`, { exact: false }).waitFor();
        assert.equal(writes.some(item => item.path.includes("/oauth")), false, "Status inspection started external OAuth.");
        await panel.scrollIntoViewIfNeeded(); await capture("saved");
        return { status: "passed", metrics: { providerId, createdAndEdited: true, exactTransportOwner: true,
          credentialRemoved: true, cancellationWrites: 0, defaultRoutingPreserved: true, blockingAxe: 0,
          canonicalRemovalApproval: true, unapprovedRemovalBlocked: true, explicitRemovalContinuation: true,
          limitation: "The isolated credential approval is resolved through its API; native continuation is browser-proven. OAuth status only; external login has hermetic owner tests." }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };

        function responseFor(method, route) {
          return observeProviderResponse(page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === route));
        }
        function readPlan(planId) { return api(`/api/v1/change-plans/${encodeURIComponent(planId)}?workspaceId=default`); }
        async function confirmNative(plan, expectedStatus = "completed") {
          await panel.getByRole("button", { name: "Review required step", exact: true }).click();
          const dialog = page.getByRole("dialog"); await dialog.waitFor();
          const response = responseFor("POST", `/api/v1/change-plans/${encodeURIComponent(plan.planId)}/confirmations`);
          await dialog.getByRole("button", { name: "Apply exact change", exact: true }).click();
          const result = await response; assert.equal(result.status(), 200);
          const body = result.request().postDataJSON();
          assert.equal(body.expectedRevision, plan.revision); assert.equal(body.actionNonce, plan.requiredAction.actionNonce);
          const saved = await result.json(); await recordPlan(saved);
          if (expectedStatus === "completed") assert.ok(["completed", "applied"].includes(saved.status), "The owner did not complete the reviewed provider action.");
          else assert.equal(saved.status, expectedStatus);
          await dialog.waitFor({ state: "hidden" });
          return saved;
        }
        async function submitProfile(before, input, dialog, create = false) {
          // /settings treats this explicit reviewed Apply as confirmation.
          assertSavedSettingsUnchanged(before, await readConfig());
          const response = responseFor(create ? "POST" : "PATCH", create ? "/api/v1/change-plans" : "/api/v1/settings");
          await dialog.getByRole("button", { name: "Apply reviewed provider profile", exact: true }).click();
          const result = await response; assert.equal(result.status(), create ? 201 : 200);
          const { providerId: reviewedId, ...profile } = input;
          assert.deepEqual(result.request().postDataJSON(), create
            ? { workspaceId: "default", surface: "settings", request: { kind: "provider_connection", providerId: reviewedId, profile, credentialStorage: "env", credentialEnvVar: envVar } }
            : { expectedRevision: before.revision, llm: { upsertProvider: input } });
          const receipt = await result.json();
          let plan = await readPlan(create ? receipt.planId : receipt.changePlanReceipt.planId);
          await recordPlan(plan);
          if (create) {
            assert.equal(plan.status, "awaiting_confirmation"); assert.equal(plan.target.expectedRevision, before.revision);
            assertSavedSettingsUnchanged(before, await readConfig());
            plan = await confirmNative(plan, "awaiting_input");
            assert.equal(plan.requiredAction.kind, "secure_input"); assert.equal(plan.requiredAction.targetId, providerId);
            assert.equal(plan.result.providerProfileCheckpoint.originalRevision, before.revision);
            assertProviderManagementSaved({ before, after: await readConfig(), submitted: input });
            await panel.getByRole("region", { name: "Provider change status", exact: true }).getByText("awaiting input", { exact: false }).waitFor();
            await panel.getByRole("button", { name: "Review required step", exact: true }).click();
            const secure = page.getByRole("dialog"); await secure.waitFor();
            assert.ok((await secure.innerText()).includes("plaintext") && (await secure.innerText()).includes(envVar));
            const synthetic = "verification-profile-initial-credential";
            await secure.locator('input[type="password"]').fill(synthetic);
            const secureResponse = responseFor("POST", `/api/v1/change-plans/${encodeURIComponent(plan.planId)}/provider-secret`);
            await secure.getByRole("button", { name: "Submit securely", exact: true }).click();
            const secureResult = await secureResponse; assert.equal(secureResult.status(), 200);
            const secureBody = secureResult.request().postDataJSON();
            assert.equal(secureBody.expectedRevision, plan.revision); assert.equal(secureBody.actionNonce, plan.requiredAction.actionNonce);
            const staged = await secureResult.json(); await recordPlan(staged); assert.equal(staged.planId, plan.planId); assert.equal(staged.status, "awaiting_confirmation");
            assert.equal((await readConfig()).revision, plan.target.expectedRevision, "Secure staging changed the provider before final confirmation.");
            assert.ok((await secure.innerText()).includes("plaintext") && (await secure.innerText()).includes(envVar));
            const confirmationResponse = responseFor("POST", `/api/v1/change-plans/${encodeURIComponent(plan.planId)}/confirmations`);
            stub.replaceExpectedAuthorization(`Bearer ${synthetic}`);
            await secure.getByRole("button", { name: "Apply exact change", exact: true }).click();
            const confirmed = await confirmationResponse; assert.equal(confirmed.status(), 200);
            plan = await confirmed.json(); await recordPlan(plan); assert.equal(plan.planId, staged.planId);
            await secure.waitFor({ state: "hidden" });
            assert.equal(await page.evaluate(value => document.body.innerText.includes(value) || JSON.stringify({ ...window.localStorage, ...window.sessionStorage }).includes(value), synthetic), false);
          }
          const after = await readConfig();
          if (!create) assert.equal(receipt.changePlanReceipt.status, plan.status);
          assertProviderProfileReceipt({ before, after, submitted: input, plan, ...(create ? { credentialStorage: "env" } : {}) });
          await panel.getByText(create ? "Change saved and confirmed." : "Provider saved and confirmed.", { exact: false }).first().waitFor();
          return after;
        }
        async function recordPlan(plan) {
          const evidenceDir = path.join(context.artifactRoot, "diagnostics"); await mkdir(evidenceDir, { recursive: true });
          const file = path.join(evidenceDir, `cockpit-provider-profile-${variant}-${plan.planId}-${plan.revision}.json`);
          await writeFile(file, JSON.stringify({ planId: plan.planId, revision: plan.revision, status: plan.status,
            target: plan.target, result: plan.result, requiredActionKind: plan.requiredAction?.kind, evidenceRefs: plan.evidenceRefs }, null, 2));
          diagnostics.push(relativeToRun(context, file));
        }
      } catch (error) {
        if (page && !page.isClosed()) {
          try { await mkdir(screenshotDir, { recursive: true }); const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-provider-management-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve original failure. */ }
        }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserWrites: writes }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); await stub?.close(); }
      async function capture(name) {
        await mkdir(screenshotDir, { recursive: true }); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page), blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) { const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-provider-management-${variant}-${name}-axe.json`);
          await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file)); }
        assert.deepEqual(blocking.map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-provider-management-${variant}-${name}.png`);
        await page.screenshot({ path: screenshot, fullPage: false, mask: [page.locator('input[type="password"]')] }); screenshots.push(relativeToRun(context, screenshot));
      }
    });
  }
}
