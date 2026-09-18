import assert from "node:assert/strict";

/** Uses the caller's disposable Gateway and browser; never provisions native volumes. */
export async function runCitadelVaultRevisionsScenario(context, deps, stack) {
  const { path, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun, NEXT_UI_PACKAGE } = deps;
  await runScenario(context, { id: "citadels.vault-revisions", lane: "citadel-record-revisions",
    title: "Vault changes preserve drafts and require reviewed replacement and deletion", subsystem: "library" }, async ({ correlationId }) => {
    const created = await requestJson(stack.gatewayUrl, "/api/v1/citadels", { method: "POST", body: {
      name: "Vault Review Citadel", slug: "citadel-vault-proof", kind: "custom" } });
    assertOk(created, "create owned vault Citadel");
    const citadelId = created.body.citadelId;
    const baseUrl = `/api/v1/citadels/${citadelId}`;
    const workspace = await requestJson(stack.gatewayUrl, "/api/v1/workspaces", { method: "POST", body: { citadelId, name: "Vault review workspace" } });
    assertOk(workspace, "create owned vault workspace");
    const read = async () => { const result = await requestJson(stack.gatewayUrl, `${baseUrl}/vault-secrets`); assertOk(result, "read vault"); return result.body; };
    const mutate = async (suffix, method, body) => { const result = await requestJson(stack.gatewayUrl, baseUrl + suffix, { method, body }); assertOk(result, "owned peer mutation"); return result.body; };
    const initial = await read();
    const browser = await chromium.launch({ headless: true });
    let page; let browserLog; let logCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspace.body.workspaceId, citadelId);
      page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
      const artifacts = []; const receipts = [];
      const capture = async (slug) => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
      const waitMutation = (suffix, method) => page.waitForResponse((response) => new URL(response.url()).pathname === baseUrl + suffix && response.request().method() === method);
      const race = async (suffix, method, reviewed, peer, failRefresh = false) => {
        const state = { tokens: [], winner: null, blockRefresh: failRefresh };
        await page.route(`**${baseUrl}${suffix}`, async (route) => {
          if (route.request().method() === "GET" && state.blockRefresh && state.winner) {
            await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic metadata refresh failure" }) });
            return;
          }
          if (route.request().method() === method) {
            const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
            if (!state.winner) {
              assert.equal(input.expectedRevision, reviewed.revision);
              await peer(reviewed);
              state.winner = await read();
            }
          }
          await route.continue();
        });
        return state;
      };
      const reject = async (suffix, method, click, state) => {
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), 409);
        assert.equal((await response.json()).details?.reason, "CITADEL_VAULT_REVISION_CONFLICT");
        assert.deepEqual(await read(), state.winner);
      };
      const accept = async (suffix, method, click, state) => {
        logCursor = browserLog.mark();
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), method === "POST" ? 201 : 200);
        const saved = await response.json();
        assert.notEqual(saved.revision, state.winner.revision);
        assert.deepEqual(state.tokens, [state.tokens[0], state.winner.revision]);
        assert.deepEqual(await read(), saved);
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ suffix, method, reviewed: state.tokens, winner: state.winner, saved });
        await page.unroute(`**${baseUrl}${suffix}`);
        return saved;
      };

      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-vault"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-vault", readyText: "Vault" }, NEXT_UI_PACKAGE);
      await page.getByRole("button", { name: "Store secret", exact: true }).click();
      const name = page.getByLabel("Name", { exact: true });
      const value = page.getByLabel("Value", { exact: true });
      await name.fill("Synthetic integration key"); await value.fill("gc-synthetic-local-value");
      assert.equal(await value.getAttribute("type"), "password");
      const addRace = await race("/vault-secrets", "POST", initial, (reviewed) => mutate("/vault-secrets", "POST", {
        name: "Synthetic integration key", value: "gc-synthetic-peer-value", expectedRevision: reviewed.revision }), true);
      await reject("/vault-secrets", "POST", () => page.getByRole("button", { name: "Seal & store", exact: true }).click(), addRace);
      await page.getByRole("button", { name: "Reload Vault review", exact: true }).waitFor();
      await page.getByText(/Current metadata could not be loaded/).waitFor();
      assert.equal(await value.inputValue(), "gc-synthetic-local-value");
      assert.equal(await page.getByRole("button", { name: "Seal & store", exact: true }).isDisabled(), true);
      addRace.blockRefresh = false;
      await page.getByRole("button", { name: "Reload Vault review", exact: true }).click();
      await page.getByRole("button", { name: "Use current Vault review", exact: true }).waitFor();
      assert.equal(await name.inputValue(), "Synthetic integration key");
      assert.equal(await value.inputValue(), "gc-synthetic-local-value");
      assert.equal(await page.getByRole("button", { name: "Seal & store", exact: true }).isDisabled(), true);
      await capture("citadel-vault-retained-draft-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok((await page.getByRole("button", { name: "Use current Vault review", exact: true }).boundingBox())?.height >= 44);
      await capture("citadel-vault-current-review-narrow");
      await page.getByRole("button", { name: "Use current Vault review", exact: true }).click();
      await page.getByRole("button", { name: "Seal & store", exact: true }).click();
      await page.getByRole("dialog", { name: "Replace secret?", exact: true }).waitFor();
      assert.equal(addRace.tokens.length, 1, "replacement needs confirmation before sending");
      await capture("citadel-vault-reviewed-replacement-narrow");
      let current = await accept("/vault-secrets", "POST", () => page.getByRole("button", { name: "Replace secret", exact: true }).click(), addRace);
      const secret = current.items[0];
      assert.equal(secret.secretId, addRace.winner.items[0].secretId);
      const reveal = await requestJson(stack.gatewayUrl, baseUrl + "/vault-secrets/" + secret.secretId + "/reveal");
      assertOk(reveal, "explicitly reveal the synthetic fixture");
      assert.equal(reveal.body.value, "gc-synthetic-local-value");
      const deletePath = "/vault-secrets/" + secret.secretId;
      const removeRace = await race(deletePath, "DELETE", current, (reviewed) => mutate("/vault-secrets", "POST", {
        name: secret.secretName, value: "gc-synthetic-peer-replacement", expectedRevision: reviewed.revision }));
      await page.getByRole("button", { name: secret.secretName, exact: true }).click();
      await page.getByRole("button", { name: "Delete " + secret.secretName, exact: true }).click();
      await reject(deletePath, "DELETE", () => page.getByRole("dialog", { name: "Delete secret?", exact: true }).getByRole("button", { name: "Delete", exact: true }).click(), removeRace);
      await page.getByRole("button", { name: "Use current Vault review", exact: true }).waitFor();
      await capture("citadel-vault-delete-conflict-narrow");
      assert.equal((await read()).items.length, 1);
      await page.getByRole("button", { name: "Use current Vault review", exact: true }).click();
      await page.getByRole("button", { name: secret.secretName, exact: true }).click();
      await page.getByRole("button", { name: "Delete " + secret.secretName, exact: true }).click();
      await capture("citadel-vault-reviewed-delete-narrow");
      current = await accept(deletePath, "DELETE", () => page.getByRole("dialog", { name: "Delete secret?", exact: true }).getByRole("button", { name: "Delete", exact: true }).click(), removeRace);
      assert.equal(current.items.length, 0);
      await page.getByText("No secrets stored yet.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      await capture("citadel-vault-committed-narrow");
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "citadel-vault-revisions.json");
      await writeJson(diagnostics, { citadelId, workspaceId: workspace.body.workspaceId, initial, receipts, terminal: current,
        note: "Two real competing Vault writes rejected with 409 and two explicit reviewed retries saved. Synthetic credentials only, sealed with the dev-verification fixture key; no OS keychain, native volume, or live provider used. Diagnostics contain only metadata." });
      const combined = Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key] ?? [])]));
      combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
      return { status: "passed", metrics: { staleMutationsRejected: 2, reviewedMutations: 2, failedRefreshRecovered: 1, narrowWidth: 390 }, artifacts: combined };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "citadel-vault-revisions-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
