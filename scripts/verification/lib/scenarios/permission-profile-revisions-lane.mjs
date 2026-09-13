import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { runPermissionSelectionRevisionScenario } from "./permission-selection-revision-scenario.mjs";

/** Isolated Gateway/database and canonical Settings UI; no disks or live providers. */
export async function runPermissionProfileRevisionsLane(context, deps) {
  const { path, prepareVerificationRuntime, startDeterministicLlmStub, writeDeterministicLlmProviderConfig,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun } = deps;
  let stack; let llmStub; let runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-permission-revision`);
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
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "permission-profile-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-permission-revision");
    await runScenario(context, { id: "permissions.profile-revisions", lane: "permission-profile-revisions",
      title: "Profile saves and archives reject stale review and retain the operator draft", subsystem: "permissions" }, async ({ correlationId }) => {
      const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
        body: { workspaceName: "Permission revision workspace", sessionTitle: "Permission fixture", sessionCount: 1, longThreadTurns: 2 } });
      assertOk(seed, "seed isolated permission workspace");
      const workspaceId = seed.body.workspaceId;
      assert.ok(workspaceId);
      const collectionUrl = "/api/v1/tools/permission-profiles";
      const created = await requestJson(stack.gatewayUrl, collectionUrl, { method: "POST", body: {
        label: "Revision review fixture", description: "Reviewed permission rules", scope: "workspace", scopeRef: workspaceId,
        approvalMode: "approve_all", toolPatterns: ["session.status"], deny: ["shell.exec"], defaultForSurfaces: [],
      } });
      assertOk(created, "create permission profile without activating it");
      const before = created.body;
      assert.match(before.revision, /^[a-f0-9]{64}$/);
      const profileUrl = `${collectionUrl}/${encodeURIComponent(before.profileId)}`;
      const readProfile = async () => {
        const listed = await requestJson(stack.gatewayUrl, `${collectionUrl}?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`);
        assertOk(listed, "read canonical profile snapshot");
        const profile = listed.body.items.find((item) => item.profileId === before.profileId);
        assert.ok(profile); return profile;
      };
      const missingSave = await requestJson(stack.gatewayUrl, profileUrl, { method: "PATCH", body: { label: "Unguarded" } });
      const missingArchive = await requestJson(stack.gatewayUrl, `${profileUrl}/archive`, { method: "POST", body: {} });
      assert.equal(missingSave.status, 400); assert.equal(missingArchive.status, 400);
      const browser = await chromium.launch({ headless: true });
      let page; let browserLog; let logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspaceId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/permissions"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "permissions", readyText: "Permission profiles" }, NEXT_UI_PACKAGE);
        await page.getByRole("button", { name: /^Revision review fixture/ }).click();
        await page.getByRole("button", { name: "Edit profile", exact: true }).click();
        const name = page.getByRole("textbox", { name: "Edit profile name", exact: true });
        const description = page.getByRole("textbox", { name: "Edit profile description", exact: true });
        const draftName = "Retained operator profile";
        await name.fill(draftName);
        let concurrent;
        const saveRevisions = [];
        await page.route(`**${profileUrl}`, async (route) => {
          if (route.request().method() === "PATCH") {
            const input = route.request().postDataJSON();
            assert.equal(input.label, draftName); saveRevisions.push(input.expectedRevision);
            if (!concurrent) {
              assert.equal(input.expectedRevision, before.revision);
              const winner = await requestJson(stack.gatewayUrl, profileUrl, { method: "PATCH",
                body: { expectedRevision: before.revision, label: "Concurrent profile writer" } });
              assertOk(winner, "commit another profile writer after browser review"); concurrent = winner.body;
            }
          }
          await route.continue();
        });
        const waitForMutation = (pathname, method) => page.waitForResponse((response) =>
          new URL(response.url()).pathname === pathname && response.request().method() === method);
        const saveButton = page.getByRole("button", { name: "Save profile", exact: true });
        const [conflict] = await Promise.all([waitForMutation(profileUrl, "PATCH"), saveButton.click()]);
        assert.equal(conflict.status(), 409);
        assert.equal((await conflict.json()).details?.reason, "PERMISSION_PROFILE_REVISION_CONFLICT");
        await page.getByText("The saved profile changed. Your draft is preserved.", { exact: true }).waitFor();
        assert.equal(await name.inputValue(), draftName); assert.equal(await saveButton.isDisabled(), true);
        assert.deepEqual(await readProfile(), concurrent);
        await page.getByText("Current profile rules", { exact: true }).click();
        await page.getByRole("region", { name: "Current saved profile", exact: true }).getByText("Concurrent profile writer", { exact: true }).waitFor();
        const capture = (slug) => captureBrowserArtifacts(context, { slug, page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        const conflictArtifacts = await capture("permission-profile-save-conflict");
        await page.getByRole("button", { name: "Apply draft to current profile", exact: true }).click();
        logCursor = browserLog.mark();
        const [saved] = await Promise.all([waitForMutation(profileUrl, "PATCH"), saveButton.click()]);
        assert.equal(saved.status(), 200);
        const accepted = await saved.json();
        assert.equal(accepted.label, draftName); assert.notEqual(accepted.revision, concurrent.revision);
        assert.deepEqual(saveRevisions, [before.revision, concurrent.revision]);
        assert.deepEqual(await readProfile(), accepted);
        await page.getByText("Permission profile updated.", { exact: true }).waitFor();
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        const savedArtifacts = await capture("permission-profile-reviewed-save");

        await description.fill("Unsaved archive review draft");
        let archiveWinner;
        const archiveRevisions = [];
        await page.route(`**${profileUrl}/archive`, async (route) => {
          if (route.request().method() === "POST") {
            const input = route.request().postDataJSON(); archiveRevisions.push(input.expectedRevision);
            if (!archiveWinner) {
              assert.equal(input.expectedRevision, accepted.revision);
              const winner = await requestJson(stack.gatewayUrl, profileUrl, { method: "PATCH",
                body: { expectedRevision: accepted.revision, label: "Changed after archive review" } });
              assertOk(winner, "commit profile change after archive confirmation opened"); archiveWinner = winner.body;
            }
          }
          await route.continue();
        });
        const openArchive = () => page.getByRole("button", { name: "Archive profile", exact: true }).click();
        const confirmation = page.getByRole("dialog", { name: "Archive permission profile?", exact: true });
        await openArchive();
        const [archiveConflict] = await Promise.all([waitForMutation(`${profileUrl}/archive`, "POST"),
          confirmation.getByRole("button", { name: "Archive profile", exact: true }).click()]);
        assert.equal(archiveConflict.status(), 409);
        assert.equal((await archiveConflict.json()).details?.reason, "PERMISSION_PROFILE_REVISION_CONFLICT");
        await confirmation.waitFor({ state: "hidden" });
        await page.getByText("This permission profile changed. Review it again before archiving; your draft is preserved.", { exact: true }).waitFor();
        assert.deepEqual(await readProfile(), archiveWinner); assert.equal(archiveWinner.status, "active");
        assert.equal(await description.inputValue(), "Unsaved archive review draft");
        await page.getByText("Current profile rules", { exact: true }).click();
        await page.getByRole("region", { name: "Current saved profile", exact: true }).getByText("Changed after archive review", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        const archiveConflictArtifacts = await capture("permission-profile-archive-conflict-narrow");
        logCursor = browserLog.mark();
        await openArchive();
        await confirmation.getByText("Archive Changed after archive review? It will no longer be available for activation.", { exact: true }).waitFor();
        const reviewedArchiveArtifacts = await capture("permission-profile-archive-reviewed-narrow");
        const [archived] = await Promise.all([waitForMutation(`${profileUrl}/archive`, "POST"),
          confirmation.getByRole("button", { name: "Archive profile", exact: true }).click()]);
        assert.equal(archived.status(), 200);
        await page.getByText("Permission profile archived.", { exact: true }).waitFor();
        const terminal = await readProfile();
        assert.equal(terminal.status, "archived"); assert.notEqual(terminal.revision, archiveWinner.revision);
        assert.deepEqual(terminal.deny, before.deny);
        assert.deepEqual(archiveRevisions, [accepted.revision, archiveWinner.revision]);
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "permission-profile-revisions.json");
        await writeJson(diagnostics, { workspaceId, profileId: before.profileId, saveRevisions, archiveRevisions,
          missingSave: missingSave.status, missingArchive: missingArchive.status, saveConflict: conflict.status(),
          archiveConflict: archiveConflict.status(), before, concurrent, accepted, archiveWinner, terminal,
          draftPreserved: true, note: "Real API writes race both browser mutations. Asserted 409s are retained in conflict browser logs. Temporary runtime only; profile activation and selection concurrency are separate acceptance work." });
        const allArtifacts = [conflictArtifacts, savedArtifacts, archiveConflictArtifacts, reviewedArchiveArtifacts];
        const artifacts = Object.fromEntries(Object.keys(savedArtifacts).map((key) =>
          [key, allArtifacts.flatMap((item) => item[key] ?? [])]));
        artifacts.diagnostics = [...(artifacts.diagnostics ?? []), relativeToRun(context, diagnostics)];
        return { status: "passed", metrics: { missingRevisionRejected: 2, staleSaveRejected: 1, staleArchiveRejected: 1,
          reviewedSave: 1, reviewedArchive: 1, retainedDrafts: 2, narrowWidth: 390 }, artifacts };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "permission-profile-revisions-failure", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
    await runPermissionSelectionRevisionScenario(context, stack, deps);
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
