import assert from "node:assert/strict";
import fs from "node:fs/promises";

/** Real Gateway and canonical UI in an owned temporary runtime; no disk or provider operations. */
export async function runPersonalityCatalogRevisionsLane(context, deps) {
  const { path, prepareVerificationRuntime, startDeterministicLlmStub, writeDeterministicLlmProviderConfig,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack; let llmStub; let runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-personality-revision`);
    llmStub = await startDeterministicLlmStub();
    await writeDeterministicLlmProviderConfig(runtimeRoot, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data";
    config.assistant.workspaceDir = "./workspace";
    config.assistant.worktreesDir = "./.worktrees";
    delete config.generation;
    await writeJson(configPath, config);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "personality-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-personality-revision");
    await runScenario(context, { id: "personalities.catalog-revisions", lane: "personality-catalog-revisions",
      title: "Personality creation, edits, defaults, resets, and removal require the reviewed catalog", subsystem: "settings" }, async ({ correlationId }) => {
      const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
        body: { workspaceName: "Personality revision workspace", sessionTitle: "Personality fixture", sessionCount: 1, longThreadTurns: 2 } });
      assertOk(seed, "seed isolated personality workspace");
      const workspaceId = seed.body.workspaceId;
      assert.ok(workspaceId);
      const collectionUrl = "/api/v1/personalities";
      const readCatalog = async () => {
        const result = await requestJson(stack.gatewayUrl, collectionUrl);
        assertOk(result, "read canonical personality catalog");
        assert.match(result.body.revision, /^[a-f0-9]{64}$/); return result.body;
      };
      const mutate = async (suffix, method, body, title) => {
        const result = await requestJson(stack.gatewayUrl, `${collectionUrl}${suffix}`, { method, body });
        assertOk(result, title); return result.body;
      };
      const missing = [];
      for (const [suffix, method, body] of [["", "POST", { label: "Unreviewed" }], ["/operator", "PATCH", { label: "Unreviewed" }],
        ["/operator", "DELETE", {}], ["/default", "PATCH", { personalityId: "operator" }]]) {
        const result = await requestJson(stack.gatewayUrl, `${collectionUrl}${suffix}`, { method, body });
        assert.equal(result.status, 400); missing.push({ method, suffix, status: result.status });
      }
      let catalog = await readCatalog();
      catalog = await mutate("/operator", "PATCH", { expectedRevision: catalog.revision, label: "Reviewed operator", systemOverlay: "Original reviewed instructions." }, "seed reviewed operator");
      const before = await mutate("", "POST", { expectedRevision: catalog.revision, id: "revision-custom", label: "Revision custom", systemOverlay: "Custom reviewed instructions." }, "seed custom personality");
      const browser = await chromium.launch({ headless: true });
      let page; let browserLog; let logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspaceId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/personalities"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "personalities", readyText: "Personality catalog" }, NEXT_UI_PACKAGE);
        const label = page.getByPlaceholder("Direct Operator", { exact: true });
        const description = page.getByLabel("Description", { exact: true });
        const overlay = page.getByLabel("System overlay", { exact: true });
        const saveButton = page.getByRole("button", { name: "Save edits", exact: true });
        const rebase = page.getByRole("button", { name: "Apply draft to current personality", exact: true });
        const artifacts = [];
        const receipts = [];
        const capture = async (slug) => {
          const result = await captureBrowserArtifacts(context, { slug, page, browserLog, gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
          artifacts.push(result); return result;
        };
        const waitForMutation = (suffix, method) => page.waitForResponse((response) =>
          new URL(response.url()).pathname === `${collectionUrl}${suffix}` && response.request().method() === method);
        const race = async (suffix, method, expectedRevision, competingWriter) => {
          const state = { tokens: [], winner: undefined };
          await page.route(`**${collectionUrl}${suffix}`, async (route) => {
            if (route.request().method() === method) {
              const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
              if (!state.winner) {
                assert.equal(input.expectedRevision, expectedRevision);
                state.winner = await competingWriter(expectedRevision);
              }
            }
            await route.continue();
          });
          return state;
        };
        const reject = async (suffix, method, click, state) => {
          const [response] = await Promise.all([waitForMutation(suffix, method), click()]);
          assert.equal(response.status(), 409);
          assert.equal((await response.json()).details?.reason, "PERSONALITY_CATALOG_REVISION_CONFLICT");
          assert.deepEqual(await readCatalog(), state.winner);
        };
        const accept = async (suffix, method, click, state) => {
          logCursor = browserLog.mark();
          const [response] = await Promise.all([waitForMutation(suffix, method), click()]);
          assert.equal(response.status(), method === "POST" ? 201 : 200);
          const accepted = await response.json();
          assert.notEqual(accepted.revision, state.winner.revision);
          assert.deepEqual(state.tokens, [state.tokens[0], state.winner.revision]);
          assert.deepEqual(await readCatalog(), accepted);
          assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
          receipts.push({ suffix, method, reviewed: state.tokens, winner: state.winner, accepted });
          await page.unroute(`**${collectionUrl}${suffix}`);
          return accepted;
        };
        const reviewSaved = async (savedLabel) => {
          const summary = page.getByText("Current saved instructions", { exact: true });
          await summary.waitFor();
          if (!(await summary.evaluate((element) => element.parentElement.open))) await summary.click();
          await page.getByRole("region", { name: "Current saved personality", exact: true }).getByText(savedLabel, { exact: true }).waitFor();
        };

        await page.getByRole("button", { name: /^Reviewed operator/ }).click();
        await label.fill("Retained operator draft"); await overlay.fill("My retained draft instructions.");
        const edit = await race("/operator", "PATCH", before.revision, (expectedRevision) => mutate("/operator", "PATCH",
          { expectedRevision, label: "Concurrent operator", systemOverlay: "Peer instructions to review." }, "commit competing edit"));
        await reject("/operator", "PATCH", () => saveButton.click(), edit);
        await page.getByText("The personality catalog changed. Your draft is preserved.", { exact: true }).waitFor();
        assert.equal(await label.inputValue(), "Retained operator draft"); assert.equal(await overlay.inputValue(), "My retained draft instructions.");
        assert.equal(await saveButton.isDisabled(), true);
        await reviewSaved("Concurrent operator");
        await capture("personality-edit-conflict-desktop");
        await label.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture("personality-edit-retained-draft-desktop");
        await rebase.click();
        catalog = await accept("/operator", "PATCH", () => saveButton.click(), edit);
        assert.equal(catalog.items.find((item) => item.id === "operator").systemOverlay, "My retained draft instructions.");
        await page.getByText("Concurrent operator saved.", { exact: true }).waitFor();

        await description.fill("Unsaved default review draft");
        const defaultDialog = page.getByRole("dialog", { name: "Change Work default?", exact: true });
        const openDefault = () => page.getByRole("button", { name: "Set as Work default", exact: true }).click();
        const defaultRace = await race("/default", "PATCH", catalog.revision, (expectedRevision) => mutate("/operator", "PATCH",
          { expectedRevision, label: "Changed before default", systemOverlay: "Saved instructions for default review." }, "change the selected personality before default confirmation"));
        await openDefault();
        await reject("/default", "PATCH", () => defaultDialog.getByRole("button", { name: "Apply reviewed default", exact: true }).click(), defaultRace);
        await defaultDialog.waitFor({ state: "hidden" });
        assert.equal(await description.inputValue(), "Unsaved default review draft");
        assert.equal(defaultRace.winner.defaultPersonalityId, catalog.defaultPersonalityId);
        await reviewSaved("Changed before default");
        await openDefault();
        await defaultDialog.getByText("Use the saved instructions for Changed before default as the global Work default?", { exact: true }).waitFor();
        await capture("personality-default-reviewed-desktop");
        catalog = await accept("/default", "PATCH", () => defaultDialog.getByRole("button", { name: "Apply reviewed default", exact: true }).click(), defaultRace);
        assert.equal(catalog.defaultPersonalityId, "operator");
        await page.getByText("Changed before default is now the global Work default.", { exact: true }).waitFor();

        const resetDialog = page.getByRole("dialog", { name: "Reset built-in personality?", exact: true });
        const openReset = () => page.getByRole("button", { name: "Reset built-in", exact: true }).click();
        const reset = await race("/operator", "DELETE", catalog.revision, (expectedRevision) => mutate("/operator", "PATCH",
          { expectedRevision, label: "Changed before reset" }, "change built-in override before reset confirmation"));
        await openReset();
        await reject("/operator", "DELETE", () => resetDialog.getByRole("button", { name: "Reset personality", exact: true }).click(), reset);
        await resetDialog.waitFor({ state: "hidden" });
        assert.equal(await description.inputValue(), "Unsaved default review draft");
        await reviewSaved("Changed before reset");
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("personality-reset-conflict-narrow");
        await openReset();
        await resetDialog.getByText("Reset Changed before reset to the shipped preset? Local edits will be removed.", { exact: true }).waitFor();
        await capture("personality-reset-reviewed-narrow");
        catalog = await accept("/operator", "DELETE", () => resetDialog.getByRole("button", { name: "Reset personality", exact: true }).click(), reset);
        assert.equal(catalog.items.find((item) => item.id === "operator").modified, false);
        assert.equal(catalog.defaultPersonalityId, "default");
        await page.getByText("Changed before reset reset to the shipped preset.", { exact: true }).waitFor();

        await page.getByRole("button", { name: /^Revision custom/ }).click();
        await description.fill("Retained custom removal draft");
        const removeDialog = page.getByRole("dialog", { name: "Remove custom personality?", exact: true });
        const openRemove = () => page.getByRole("button", { name: "Remove custom", exact: true }).click();
        const removal = await race("/revision-custom", "DELETE", catalog.revision, (expectedRevision) => mutate("/revision-custom", "PATCH",
          { expectedRevision, label: "Changed before removal" }, "change custom personality before removal confirmation"));
        await openRemove();
        await reject("/revision-custom", "DELETE", () => removeDialog.getByRole("button", { name: "Remove personality", exact: true }).click(), removal);
        await removeDialog.waitFor({ state: "hidden" });
        assert.equal(await description.inputValue(), "Retained custom removal draft");
        await reviewSaved("Changed before removal");
        await openRemove();
        await removeDialog.getByText("Remove Changed before removal? This cannot be undone.", { exact: true }).waitFor();
        await capture("personality-removal-reviewed-narrow");
        catalog = await accept("/revision-custom", "DELETE", () => removeDialog.getByRole("button", { name: "Remove personality", exact: true }).click(), removal);
        assert.equal(catalog.items.some((item) => item.id === "revision-custom"), false);
        await page.getByText("Changed before removal removed.", { exact: true }).waitFor();

        await page.getByRole("button", { name: "Add custom personality", exact: true }).click();
        await page.getByPlaceholder("direct-operator", { exact: true }).fill("retained-creation");
        await label.fill("Retained creation"); await overlay.fill("Retained creation instructions.");
        const createButton = page.getByRole("button", { name: "Create personality", exact: true });
        const creation = await race("", "POST", catalog.revision, (expectedRevision) => mutate("", "POST",
          { expectedRevision, id: "peer-creation", label: "Peer creation" }, "create a peer personality before the browser creation"));
        await reject("", "POST", () => createButton.click(), creation);
        await page.getByText("The personality catalog changed. Your draft is preserved.", { exact: true }).waitFor();
        assert.equal(await label.inputValue(), "Retained creation"); assert.equal(await createButton.isDisabled(), true);
        const summary = page.getByText("Current saved instructions", { exact: true });
        if (!(await summary.evaluate((element) => element.parentElement.open))) await summary.click();
        await page.getByRole("region", { name: "Current personality catalog", exact: true }).getByText("Peer creation (peer-creation)", { exact: true }).waitFor();
        await capture("personality-creation-conflict-narrow");
        await label.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await capture("personality-creation-retained-draft-narrow");
        await rebase.click();
        catalog = await accept("", "POST", () => createButton.click(), creation);
        assert.equal(catalog.items.find((item) => item.id === "retained-creation").systemOverlay, "Retained creation instructions.");
        assert.equal(catalog.items.some((item) => item.id === "peer-creation"), true);
        await page.getByText("Custom personality created.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await capture("personality-catalog-reviewed-narrow");
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "personality-catalog-revisions.json");
        await writeJson(diagnostics, { workspaceId, missing, before, receipts, terminal: catalog,
          note: "Five real competing API writes cause browser 409s. Drafts and canonical winners are preserved. Each explicit review then sends the new revision. Temporary runtime only; no disks, live provider requests, or external messages." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { missingRevisionsRejected: 4, staleMutationsRejected: 5, reviewedMutations: 5,
          retainedDrafts: 5, narrowWidth: 390 }, artifacts: combined };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "personality-catalog-revisions-failure", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
