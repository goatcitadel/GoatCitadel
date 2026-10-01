import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DETERMINISTIC_LLM_KEY_ENV, DETERMINISTIC_LLM_MODEL, DETERMINISTIC_LLM_PROVIDER_ID, startDeterministicLlmStub } from "./deterministic-llm-stub.mjs";

// Public synthetic input accepted only by the ux-budgets lane's loopback stub.
const SEED_KEY = "verification-ux-budgets-stub-key";
const SYNTHETIC_KEY = "verification-connection-rotated-key";
const providerAt = (config, id) => config.providers?.find((item) => item.providerId === id);

export function assertProviderConnectionPreview({ before, after, plan, request }) {
  assert.equal(plan.kind, "provider_connection");
  assert.equal(plan.origin?.workspaceId, "default");
  assert.equal(plan.origin?.surface, "settings");
  assert.equal(plan.target?.ownerId, "provider_connection");
  assert.equal(plan.target?.resourceId, request.providerId);
  assert.equal(plan.target?.expectedRevision, before.revision, "Preview did not bind the current settings revision.");
  assert.deepEqual(plan.request, request, "Preview changed the reviewed public intent.");
  assert.equal(after.revision, before.revision, "Preview mutated settings before confirmation.");
  assert.deepEqual(providerAt(after, request.providerId), providerAt(before, request.providerId), "Preview changed its provider.");
  assert.equal(after.activeProviderId, before.activeProviderId);
  assert.equal(after.activeModel, before.activeModel);
}

export function assertProviderConnectionSaved({ before, after, plan, request, secretStatus }) {
  assert.ok(["completed", "applied"].includes(plan.status), "The owner did not complete this change.");
  assert.ok(after.revision > before.revision, "The owner settings revision did not advance.");
  const provider = providerAt(after, request.providerId);
  assert.ok(provider, "The saved provider is absent.");
  assert.equal(after.activeProviderId, before.activeProviderId, "The connection change replaced the default provider.");
  assert.equal(after.activeModel, before.activeModel, "The connection change replaced the default model.");
  if (request.profile) assert.equal(provider.baseUrl, request.profile.baseUrl, "The owner saved a different endpoint.");
  if (request.credentialAction === "replace_api_key") {
    assert.equal(secretStatus?.providerId, request.providerId);
    assert.equal(secretStatus?.hasSecret, true, "The secret owner did not confirm a credential.");
    assert.equal(secretStatus?.source, "env");
    assert.equal(provider.apiKeySource, "env");
    assert.equal(provider.apiKeyRef, request.credentialEnvVar, "The owner saved a different environment target.");
  }
}

/** All mutations target a unique clone inside the disposable verification runtime. */
export async function runCockpitProviderConnectionProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Connection proof requires an isolated verification runtime.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    // Never dump a response body on failure: this proof exercises credential owners.
    assert.ok(response.ok, `Connection proof owner request failed (${response.status}).`);
    return response.body;
  };
  const readConfig = () => api("/api/v1/llm/config");
  const create = (request) => api("/api/v1/change-plans", { method: "POST", body: { workspaceId: "default", surface: "settings", request } });
  const confirm = (plan) => api(`/api/v1/change-plans/${encodeURIComponent(plan.planId)}/confirmations`, {
    method: "POST", body: { workspaceId: "default", expectedRevision: plan.revision, actionNonce: plan.requiredAction.actionNonce },
  });
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-provider-connection.${variant}`, lane: "ux-budgets",
      title: `Cockpit provider connection ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const connectionStub = await startDeterministicLlmStub({ expectedAuthorization: `Bearer ${SEED_KEY}` });
      try {
        const original = await readConfig();
        const source = providerAt(original, DETERMINISTIC_LLM_PROVIDER_ID);
        assert.ok(source && source.defaultModel === DETERMINISTIC_LLM_MODEL, "Connection proof requires the deterministic provider.");
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(source.baseUrl), "Connection proof requires the loopback stub endpoint.");
        assert.equal(source.apiKeyRef, DETERMINISTIC_LLM_KEY_ENV, "The stub credential reference is not the disposable fixture.");
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const providerId = `verification-connection-${suffix}`;
        const envVar = `UX_CONNECTION_${suffix.toUpperCase()}_KEY`;
        const label = `Connection proof ${variant}`;
        const seed = await create({ kind: "provider_connection", providerId, credentialStorage: "env", credentialEnvVar: envVar, profile: {
          label, baseUrl: connectionStub.baseUrl, apiStyle: source.apiStyle, authMode: "api-key",
          defaultModel: source.defaultModel, apiKeyEnv: envVar,
        } });
        assert.equal(seed.requiredAction?.kind, "confirmation");
        const profileResult = await confirm(seed);
        const seededConfig = await readConfig();
        assert.equal(seededConfig.providerConfigs?.find((provider) => provider.providerId === providerId)?.apiKeyEnv, envVar,
          "The isolated profile did not register its own environment target.");
        // Loopback providers can reach live verification without a key and return
        // manual_required. Explicit replacement still uses the secure owner flow.
        const seedInput = profileResult.requiredAction?.kind === "secure_input" ? profileResult
          : await create({ kind: "provider_connection", providerId, credentialAction: "replace_api_key",
            credentialStorage: "env", credentialEnvVar: envVar });
        assert.equal(seedInput.requiredAction?.kind, "secure_input", `The isolated clone did not request its own credential (${seedInput.status}).`);
        const seedStaged = await api(`/api/v1/change-plans/${encodeURIComponent(seedInput.planId)}/provider-secret`, { method: "POST", body: {
          workspaceId: "default", expectedRevision: seedInput.revision, actionId: seedInput.requiredAction.actionId,
          actionNonce: seedInput.requiredAction.actionNonce, apiKey: SEED_KEY,
        } });
        assert.ok(["completed", "applied"].includes((await confirm(seedStaged)).status), "The isolated provider clone was not ready.");
        const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
        let page;
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await browserContext.addInitScript((theme) => window.localStorage.setItem("goatcitadel.ui.theme.v1", theme), variant === "mobile" ? "light" : "dark");
          await installMissionControlNextBrowserState(browserContext, "default", citadelId);
          page = await browserContext.newPage();
          const mutations = [];
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "POST" && pathname.startsWith("/api/v1/change-plans")) mutations.push(pathname);
          });
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/models?shell=cockpit#providers"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, variant === "mobile" ? "light" : "dark");
          const panel = page.getByRole("region", { name: "Provider connection", exact: true });
          await panel.getByRole("combobox", { name: "Edit provider", exact: true }).selectOption(providerId);
          const screenshots = [];
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          await page.addScriptTag({ path: axeSourcePath });
          const audit = async (stage) => {
            const accessibility = await auditPageAccessibility(page);
            const blocking = accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact));
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            assert.equal(blocking.length, 0, `Connection ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
            assert.ok(overflow <= 1, `Connection ${stage} overflow ${overflow}px`);
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-provider-connection-${variant}-${stage}.png`);
            await page.screenshot({ path: screenshot, fullPage: false });
            screenshots.push(relativeToRun(context, screenshot));
          };
          const actionResponse = (route) => page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === route);
          const receive = async (pending) => {
            const response = await pending;
            assert.ok(response.ok(), `Connection action did not return a successful owner receipt (${response.status()}).`);
            const plan = await response.json();
            assert.ok(!JSON.stringify(plan).includes(SYNTHETIC_KEY), "A credential escaped into public plan evidence.");
            return plan;
          };
          const clickConfirm = async (plan) => {
            const pending = actionResponse(`/api/v1/change-plans/${encodeURIComponent(plan.planId)}/confirmations`);
            await page.getByRole("dialog").getByRole("button", { name: "Apply exact change", exact: true }).click();
            const response = await pending;
            const input = response.request().postDataJSON();
            assert.equal(input.expectedRevision, plan.revision);
            assert.equal(input.actionNonce, plan.requiredAction.actionNonce);
            return receive(Promise.resolve(response));
          };

          const beforeEndpoint = await readConfig();
          // The custom provider owner preserves this string; URL transport normalizes it to the same stub route.
          const endpoint = connectionStub.baseUrl.replace(/\/v1$/, "/./v1");
          const endpointRequest = { kind: "provider_connection", providerId, profile: { baseUrl: endpoint } };
          await panel.getByRole("textbox", { name: "Provider endpoint", exact: true }).fill(endpoint);
          const preparedEndpoint = actionResponse("/api/v1/change-plans");
          await panel.getByRole("button", { name: "Review endpoint change", exact: true }).click();
          const endpointPlan = await receive(preparedEndpoint);
          assertProviderConnectionPreview({ before: beforeEndpoint, after: await readConfig(), plan: endpointPlan, request: endpointRequest });
          await page.getByRole("dialog").waitFor();
          assert.ok((await page.getByRole("dialog").innerText()).includes(`New endpoint: ${endpoint}`), "Endpoint confirmation omitted the exact reviewed URL.");
          assert.deepEqual(mutations, ["/api/v1/change-plans"], "Endpoint preview sent another mutation.");
          await audit("endpoint-review");
          const endpointSaved = await clickConfirm(endpointPlan);
          const afterEndpoint = await readConfig();
          assertProviderConnectionSaved({ before: beforeEndpoint, after: afterEndpoint, plan: endpointSaved, request: endpointRequest });
          await panel.getByText("The Gateway reports this change complete. Current provider evidence confirms the saved change.", { exact: true }).waitFor();

          await panel.getByRole("combobox", { name: "Credential storage", exact: true }).selectOption("env");
          assert.equal(await panel.getByRole("textbox", { name: "Environment variable name", exact: true }).inputValue(), envVar);
          const preparedCredential = actionResponse("/api/v1/change-plans");
          await panel.getByRole("button", { name: "Replace API credential", exact: true }).click();
          const credentialPlan = await receive(preparedCredential);
          const credentialRequest = { kind: "provider_connection", providerId, credentialAction: "replace_api_key", credentialStorage: "env", credentialEnvVar: envVar };
          assertProviderConnectionPreview({ before: afterEndpoint, after: await readConfig(), plan: credentialPlan, request: credentialRequest });
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          assert.ok((await dialog.innerText()).includes("plaintext"), "The credential review did not disclose plaintext storage.");
          assert.ok((await dialog.innerText()).includes(envVar), "The credential review did not show the reviewed environment target.");
          await audit("credential-input");
          await dialog.locator('input[type="password"]').fill(SYNTHETIC_KEY);
          const stagedResponse = actionResponse(`/api/v1/change-plans/${encodeURIComponent(credentialPlan.planId)}/provider-secret`);
          await dialog.getByRole("button", { name: "Submit securely", exact: true }).click();
          const staged = await receive(stagedResponse);
          assert.equal(staged.status, "awaiting_confirmation");
          assert.equal((await readConfig()).revision, afterEndpoint.revision, "Secure staging changed settings before final confirmation.");
          await panel.getByRole("button", { name: "Review current step", exact: true }).click();
          await dialog.waitFor();
          assert.ok((await dialog.innerText()).includes("plaintext") && (await dialog.innerText()).includes(envVar), "Final confirmation lost the reviewed storage target.");
          const leaked = await page.evaluate((key) => document.body.innerText.includes(key)
            || JSON.stringify({ ...window.localStorage, ...window.sessionStorage }).includes(key), SYNTHETIC_KEY);
          assert.equal(leaked, false, "A credential escaped into UI text or browser storage.");
          const rotationStart = connectionStub.requestSummaries().length;
          connectionStub.replaceExpectedAuthorization(`Bearer ${SYNTHETIC_KEY}`);
          const credentialSaved = await clickConfirm(staged);
          const afterCredential = await readConfig();
          const secretStatus = await api(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}/status`);
          assertProviderConnectionSaved({ before: afterEndpoint, after: afterCredential, plan: credentialSaved, request: credentialRequest, secretStatus });
          const catalog = await api(`/api/v1/llm/models?providerId=${encodeURIComponent(providerId)}`);
          assert.equal(catalog.source, "live", "The replacement credential did not authenticate to the live fixture.");
          assert.notEqual(catalog.catalogStatus, "stale");
          assert.ok(connectionStub.requestSummaries().slice(rotationStart).some((request) => request.path === "/v1/models" && request.status === 200),
            "The saved replacement key did not authenticate a fresh provider request.");
          assert.ok(catalog.items?.some((item) => item.id === DETERMINISTIC_LLM_MODEL));
          await panel.getByText("The Gateway reports this change complete. Current provider evidence confirms the saved change.", { exact: true }).waitFor();
          await panel.scrollIntoViewIfNeeded();
          await audit("saved");
          return { status: "passed", metrics: { blockingAxe: 0, providerId, endpointRevision: afterEndpoint.revision,
            credentialRevision: afterCredential.revision, credentialStorage: "env", credentialBytesRotated: true, liveCatalog: true },
          artifacts: emptyArtifacts({ screenshots }) };
        } catch (error) {
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-provider-connection-${variant}-failure.png`);
          if (page) await page.screenshot({ path: screenshot, fullPage: true, mask: [page.locator('input[type="password"]')] });
          throw error;
        } finally {
          await browserContext.close();
          // The enclosing lane stops the Gateway and removes its entire disposable
          // runtime, including this unique profile and its public synthetic key.
        }
      } finally { await connectionStub.close(); }
    });
  }
}
