import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runCitadelVaultRevisionsScenario } from "./citadel-vault-revisions-lane.mjs";
import fs from "node:fs/promises";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";
import { runCitadelStructureRevisionsScenario } from "./citadel-structure-revisions-lane.mjs";
import { runCitadelAccessRevisionsScenario } from "./citadel-access-revisions-lane.mjs";

/** Real profile mutations in a disposable Gateway; no volume provisioning or live provider calls. */
export async function runCitadelRecordRevisionsLane(context, deps) {
  const { path, startDeterministicLlmStub,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack; let llmStub; let runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    llmStub = await startDeterministicLlmStub();
    // Clean checkouts have no config/goatcitadel.json (it is gitignored operator state): seed shipped defaults.
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-citadel-record-revision`, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data"; config.assistant.workspaceDir = "./workspace"; config.assistant.worktreesDir = "./.worktrees";
    delete config.generation;
    await writeJson(configPath, config);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_DEV_DIAGNOSTICS: "true", GOATCITADEL_VERIFY_VAULT_KEY_BASE64: createHash("sha256").update("gc-citadel-vault-synthetic-fixture-v1").digest("base64"), GOATCITADEL_VERIFY_STUB_LLM_KEY: "citadel-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-citadel-record-revision");
    await runScenario(context, { id: "citadels.profile-revisions", lane: "citadel-record-revisions",
      title: "Settings and Library reject stale Citadel profile edits, archive, and restore", subsystem: "settings" }, async ({ correlationId }) => {
      const create = await requestJson(stack.gatewayUrl, "/api/v1/citadels", { method: "POST", body: {
        name: "Reviewed Citadel", slug: "citadel-revision-proof", kind: "custom", description: "Original description" } });
      assertOk(create, "create owned Citadel");
      const citadelId = create.body.citadelId;
      const baseUrl = `/api/v1/citadels/${citadelId}`;
      const workspace = await requestJson(stack.gatewayUrl, "/api/v1/workspaces", { method: "POST", body: { citadelId, name: "Citadel revision workspace" } });
      assertOk(workspace, "create owned workspace");
      const workspaceId = workspace.body.workspaceId;
      const structure = await requestJson(stack.gatewayUrl, `${baseUrl}/structure`);
      assertOk(structure, "review empty Citadel structure");
      const charter = await requestJson(stack.gatewayUrl, `${baseUrl}/charter`, { method: "PUT", body: { purpose: "Retain the canonical Charter", kind: "custom", expectedRevision: structure.body.revision } });
      assertOk(charter, "seed owned Charter");
      const read = async () => { const result = await requestJson(stack.gatewayUrl, baseUrl); assertOk(result, "read Citadel"); return result.body; };
      const mutate = async (suffix, method, body) => { const result = await requestJson(stack.gatewayUrl, baseUrl + suffix, { method, body }); assertOk(result, "mutate owned profile"); return result.body; };
      const initial = (await read()).record;
      for (const [suffix, method, body] of [["", "PATCH", { name: "Unreviewed" }], ["/archive", "POST", {}], ["/restore", "POST", {}]]) {
        const response = await requestJson(stack.gatewayUrl, baseUrl + suffix, { method, body });
        assert.equal(response.status, 400);
      }
      assert.deepEqual((await read()).record, initial);
      const browser = await chromium.launch({ headless: true });
      let page; let browserLog; let logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/workspaces"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "workspaces", readyText: "Workspaces" }, NEXT_UI_PACKAGE);
        const artifacts = []; const receipts = [];
        const capture = async (slug) => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        const waitMutation = (suffix, method) => page.waitForResponse((response) => new URL(response.url()).pathname === baseUrl + suffix && response.request().method() === method);
        const race = async (suffix, method, reviewed, changes) => {
          const state = { tokens: [], winner: null };
          await page.route(`**${baseUrl}${suffix}`, async (route) => {
            if (route.request().method() === method) {
              const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
              if (!state.winner) {
                assert.equal(input.expectedRevision, reviewed.revision);
                state.winner = await mutate("", "PATCH", { expectedRevision: reviewed.revision, ...changes });
              }
            }
            await route.continue();
          });
          return state;
        };
        const reject = async (suffix, method, click, state) => {
          const [response] = await Promise.all([waitMutation(suffix, method), click()]);
          assert.equal(response.status(), 409);
          assert.equal((await response.json()).details?.reason, "CITADEL_RECORD_REVISION_CONFLICT");
          assert.deepEqual((await read()).record, state.winner);
        };
        const accept = async (suffix, method, click, state) => {
          logCursor = browserLog.mark();
          const [response] = await Promise.all([waitMutation(suffix, method), click()]);
          assert.equal(response.status(), 200);
          const saved = await response.json();
          assert.notEqual(saved.revision, state.winner.revision);
          assert.deepEqual(state.tokens, [state.tokens[0], state.winner.revision]);
          assert.deepEqual((await read()).record, saved);
          assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
          receipts.push({ suffix, method, reviewed: state.tokens, winner: state.winner, saved });
          await page.unroute(`**${baseUrl}${suffix}`);
          return saved;
        };

        await page.getByRole("tab", { name: "Citadel manager", exact: true }).click();
        await page.getByRole("button", { name: /Reviewed Citadel/ }).click();
        await page.getByRole("button", { name: "Edit Citadel", exact: true }).click();
        const nameInput = page.getByLabel("Selected name", { exact: true });
        const descriptionInput = page.getByLabel("Selected description", { exact: true });
        await nameInput.fill("Retained local Citadel"); await descriptionInput.fill("");
        const edit = await race("", "PATCH", initial, { name: "Peer saved Citadel", description: "Peer saved description" });
        await reject("", "PATCH", () => page.getByRole("button", { name: "Save Citadel", exact: true }).click(), edit);
        await page.getByRole("heading", { name: "Current saved values", exact: true }).waitFor();
        assert.equal(await nameInput.inputValue(), "Retained local Citadel");
        assert.equal(await descriptionInput.inputValue(), "");
        assert.equal(await page.getByRole("button", { name: "Save Citadel", exact: true }).isDisabled(), true);
        await capture("citadel-profile-conflict-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await capture("citadel-profile-conflict-narrow");
        await page.getByRole("button", { name: "Apply draft to current Citadel", exact: true }).click();
        let current = await accept("", "PATCH", () => page.getByRole("button", { name: "Save Citadel", exact: true }).click(), edit);
        assert.equal(current.name, "Retained local Citadel"); assert.equal(current.description, undefined);
        await page.getByText("Citadel Retained local Citadel updated.", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Close editor", exact: true }).click();
        await page.getByRole("button", { name: /Retained local Citadel/ }).click();
        const archive = await race("/archive", "POST", current, { name: "Peer archive review" });
        await page.getByRole("button", { name: "Archive Citadel Retained local Citadel", exact: true }).click();
        await reject("/archive", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Confirm archive Citadel", exact: true }).click(), archive);
        await page.getByText(/Review the current revision and archive again/).waitFor();
        await page.getByRole("button", { name: "Archive Citadel Peer archive review", exact: true }).click();
        await capture("citadel-profile-reviewed-archive-narrow");
        current = await accept("/archive", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Confirm archive Citadel", exact: true }).click(), archive);
        assert.equal(current.lifecycleStatus, "archived");
        await page.getByText("Peer archive review archived.", { exact: true }).waitFor();
        await page.getByRole("button", { name: /Peer archive review/ }).click();
        const restore = await race("/restore", "POST", current, { description: "Peer while archived" });
        await reject("/restore", "POST", () => page.getByRole("button", { name: "Restore Citadel Peer archive review", exact: true }).click(), restore);
        await page.getByText(/Review the current revision and restore again/).waitFor();
        current = await accept("/restore", "POST", () => page.getByRole("button", { name: "Restore Citadel Peer archive review", exact: true }).click(), restore);
        assert.equal(current.lifecycleStatus, "active");

        await page.setViewportSize({ width: 1440, height: 1080 });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-overview"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-overview", readyText: "Citadel" }, NEXT_UI_PACKAGE);
        await page.getByRole("button", { name: "Edit Charter", exact: true }).click();
        const purpose = page.locator("textarea");
        await purpose.fill("Keep this unsaved Charter draft");
        const overviewArchive = await race("/archive", "POST", current, { name: "Overview peer Citadel" });
        await page.getByRole("button", { name: "Archive Citadel", exact: true }).click();
        await reject("/archive", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Archive Citadel", exact: true }).click(), overviewArchive);
        await page.getByText(/open a new archive confirmation/).waitFor();
        assert.equal(await purpose.inputValue(), "Keep this unsaved Charter draft");
        await capture("citadel-overview-retained-charter-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Archive Citadel", exact: true }).click();
        await page.getByRole("dialog").getByText(/Overview peer Citadel/).waitFor();
        await capture("citadel-overview-reviewed-archive-narrow");
        current = await accept("/archive", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Archive Citadel", exact: true }).click(), overviewArchive);
        const overviewRestore = await race("/restore", "POST", current, { description: "Overview restore peer" });
        await reject("/restore", "POST", () => page.getByRole("button", { name: "Restore Citadel", exact: true }).click(), overviewRestore);
        await page.getByText(/before restoring it again/).waitFor();
        current = await accept("/restore", "POST", () => page.getByRole("button", { name: "Restore Citadel", exact: true }).click(), overviewRestore);
        assert.equal(await purpose.inputValue(), "Keep this unsaved Charter draft");
        assert.equal((await read()).charter.purpose, "Retain the canonical Charter");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
        await capture("citadel-overview-restored-narrow");
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "citadel-record-revisions.json");
        await writeJson(diagnostics, { citadelId, workspaceId, initial, receipts, terminal: current,
          note: "Five real competing profile writes rejected with 409; five explicit reviewed retries saved. Charter draft retained. Charter, templates, blueprints, and access-rule mutation revisions are outside this proof. No volume provisioning or live provider calls." });
        const combined = Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key] ?? [])]));
        combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { missingRevisionsRejected: 3, staleMutationsRejected: 5, reviewedMutations: 5, narrowWidth: 390 }, artifacts: combined };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "citadel-record-revisions-failure", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
    await runCitadelStructureRevisionsScenario(context, deps, stack);
    await runCitadelAccessRevisionsScenario(context, deps, stack);
    await runCitadelVaultRevisionsScenario(context, deps, stack);
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
