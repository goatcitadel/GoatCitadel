import assert from "node:assert/strict";

/** Real policy conflicts through the Gateway's storage worker and canonical UI; no model calls. */
export async function runMemoryPolicyRevisionScenario(context, stack, deps) {
  const { runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, NEXT_UI_PACKAGE,
    captureBrowserArtifacts, assertBrowserConsoleHealthy, path, writeJson, relativeToRun } = deps;
  await runScenario(context, { id: "memory-truth.policy-revision", lane: "memory-truth",
    title: "Memory policy conflicts preserve the winning settings and the operator draft until reviewed",
    subsystem: "memory" }, async ({ correlationId }) => {
    const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
      body: { workspaceName: "Policy revision workspace", sessionTitle: "Policy revision", sessionCount: 1, longThreadTurns: 2 } });
    assertOk(seeded, "create policy revision fixture workspace");
    const workspaceId = seeded.body.workspaceId;
    assert.ok(workspaceId);
    const policyUrl = `/api/v1/memory/maintenance/policy?workspaceId=${encodeURIComponent(workspaceId)}`;
    const base = await requestJson(stack.gatewayUrl, policyUrl);
    const defaultPolicy = await requestJson(stack.gatewayUrl, "/api/v1/memory/maintenance/policy?workspaceId=default");
    assertOk(base, "read reviewed policy"); assertOk(defaultPolicy, "read unrelated default policy");
    assert.match(base.body.revision, /^[a-f0-9]{64}$/);
    assert.equal(base.body.enabled, false);
    const missing = await requestJson(stack.gatewayUrl, policyUrl, { method: "PATCH", body: { model: "unguarded" } });
    assert.equal(missing.status, 400);
    const wrongScope = await requestJson(stack.gatewayUrl, policyUrl, { method: "PATCH",
      body: { expectedRevision: defaultPolicy.body.revision, model: "wrong-scope" } });
    assert.equal(wrongScope.status, 409);

    const browser = await chromium.launch({ headless: true });
    let page; let browserLog; let logCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1024 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspaceId);
      page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/memory"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "memory", readyText: "Memory items" }, NEXT_UI_PACKAGE);
      await page.getByRole("button", { name: "Maintenance", exact: true }).click();
      await page.getByRole("button", { name: "Edit policy", exact: true }).click();
      const model = page.getByRole("textbox", { name: "Maintenance model identifier", exact: true });
      await model.fill("operator-draft-model");
      let concurrentPolicy;
      const submittedRevisions = [];
      await page.route("**/api/v1/memory/maintenance/policy?*", async route => {
        if (route.request().method() === "PATCH") {
          const body = route.request().postDataJSON();
          submittedRevisions.push(body.expectedRevision);
          if (!concurrentPolicy) {
            assert.equal(body.expectedRevision, base.body.revision);
            const winner = await requestJson(stack.gatewayUrl, policyUrl, { method: "PATCH",
              body: { expectedRevision: base.body.revision, model: "concurrent-model" } });
            assertOk(winner, "commit another operator's policy after browser preflight");
            concurrentPolicy = winner.body;
          }
        }
        await route.continue();
      });
      const waitForSave = () => page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/memory/maintenance/policy" && response.request().method() === "PATCH");
      const [conflict] = await Promise.all([waitForSave(), page.getByRole("button", { name: "Save memory maintenance policy", exact: true }).click()]);
      assert.equal(conflict.status(), 409);
      assert.equal((await conflict.json()).details?.reason, "MEMORY_POLICY_REVISION_CONFLICT");
      await page.getByText("The policy changed since editing began. Your draft is preserved.", { exact: true }).waitFor();
      assert.equal(await model.inputValue(), "operator-draft-model");
      const stillWinning = await requestJson(stack.gatewayUrl, policyUrl);
      assert.deepEqual(stillWinning.body, concurrentPolicy);
      assert.equal(await page.getByText("API error 409", { exact: false }).count(), 0);
      const conflictArtifacts = await captureBrowserArtifacts(context, { slug: "memory-policy-conflict", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      await page.getByText("Review current policy", { exact: true }).click();
      await page.getByText("concurrent-model", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Use this version and keep my draft", exact: true }).click();
      logCursor = browserLog.mark();
      const [saved] = await Promise.all([waitForSave(), page.getByRole("button", { name: "Save memory maintenance policy", exact: true }).click()]);
      assert.equal(saved.status(), 200);
      const savedPolicy = await saved.json();
      assert.equal(savedPolicy.model, "operator-draft-model");
      assert.equal(savedPolicy.workspaceId, workspaceId);
      assert.equal(savedPolicy.enabled, false);
      assert.notEqual(savedPolicy.revision, concurrentPolicy.revision);
      assert.deepEqual(submittedRevisions, [base.body.revision, concurrentPolicy.revision]);
      await page.getByText("Memory maintenance policy saved.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Save memory maintenance policy", exact: true }).isDisabled(), true);
      assert.deepEqual((await requestJson(stack.gatewayUrl, policyUrl)).body, savedPolicy);
      assert.deepEqual((await requestJson(stack.gatewayUrl, "/api/v1/memory/maintenance/policy?workspaceId=default")).body, defaultPolicy.body);
      assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
      const savedArtifacts = await captureBrowserArtifacts(context, { slug: "memory-policy-reviewed-save", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "memory-policy-revision.json");
      await writeJson(diagnostics, { workspaceId, missingRevisionStatus: missing.status, wrongScopeStatus: wrongScope.status,
        conflictStatus: conflict.status(), submittedRevisions, before: base.body, concurrentPolicy, savedPolicy,
        defaultWorkspaceUnchanged: true, draftPreserved: true,
        note: "An actual Gateway write races the browser PATCH after preflight; the first browser log intentionally contains its asserted 409." });
      return { status: "passed", metrics: { rejectedUnguardedSave: 1, rejectedWrongScope: 1, rejectedConcurrentSave: 1, reviewedSave: 1 },
        artifacts: Object.fromEntries(Object.keys(savedArtifacts).map(key => [key,
          [...savedArtifacts[key], ...(conflictArtifacts[key] ?? []), ...(key === "diagnostics" ? [relativeToRun(context, diagnostics)] : [])]])) };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "memory-policy-revision-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
