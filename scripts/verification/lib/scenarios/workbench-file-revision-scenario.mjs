import assert from "node:assert/strict";
import { exerciseWorkbenchPathReview } from "./workbench-path-revision-scenario.mjs";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** Uses a temporary Git repository, real Gateway writes, and the canonical build editor. */
export async function runWorkbenchFileRevisionScenario(context, deps) {
  const { path, startDeterministicLlmStub,
    startVerificationStack, stopVerificationStack, forceVerificationUiPackage, NEXT_UI_PACKAGE,
    ensureOnboardingComplete, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, captureBrowserArtifacts, assertBrowserConsoleHealthy,
    writeJson, relativeToRun } = deps;
  let stack; let llmStub; let runtimeRoot;
  const restoreUi = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    llmStub = await startDeterministicLlmStub();
    // Clean checkouts have no config/goatcitadel.json (it is gitignored operator state): seed shipped defaults.
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-workbench-revision`, llmStub.baseUrl);
    const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.assistant.dataDir = "./data";
    config.assistant.workspaceDir = "./workspace";
    config.assistant.worktreesDir = "./.worktrees";
    delete config.generation;
    await writeJson(configPath, config);
    const projectSource = path.join(runtimeRoot, "workspace", "workbench-revision");
    assert.ok(path.relative(runtimeRoot, projectSource).startsWith(`workspace${path.sep}`));
    await fs.mkdir(projectSource, { recursive: true });
    await fs.writeFile(path.join(projectSource, "index.ts"), "export const original = true;\n");
    const git = (args) => execFileSync("git", args, { cwd: projectSource, stdio: "ignore", windowsHide: true });
    git(["init"]); git(["config", "core.autocrlf", "false"]);
    git(["config", "user.name", "Workbench Verification"]); git(["config", "user.email", "workbench@example.invalid"]);
    git(["add", "index.ts"]); git(["commit", "-m", "Initialize isolated Workbench fixture"]);
    stack = await startVerificationStack(context, { includeUi: true, uiMode: "preview", runtimeRoot,
      gatewayEnv: { GOATCITADEL_VERIFY_STUB_LLM_KEY: "workbench-local-fixture", GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo" } });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-workbench-revision");
    await runScenario(context, { id: "agentic.workbench.file-revision", lane: "agentic-workbench-loop",
      title: "Workbench content saves and file actions reject concurrent changes until the operator reviews them",
      subsystem: "agentic" }, async ({ correlationId }) => {
      const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
        body: { workspaceName: "Workbench revision workspace", sessionTitle: "Workbench fixture", sessionCount: 1, longThreadTurns: 2 } });
      assertOk(seed, "seed isolated workspace");
      const workspaceId = seed.body.workspaceId;
      const project = await requestJson(stack.gatewayUrl, "/api/v1/chat/projects", { method: "POST",
        body: { workspaceId, name: "Workbench revision project", workspacePath: "workbench-revision" } });
      assertOk(project, "create scoped Workbench project");
      const session = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", { method: "POST",
        body: { workspaceId, projectId: project.body.projectId, title: "Review file save conflicts", mode: "chat" } });
      assertOk(session, "create project-bound Chat");
      const sessionId = session.body.sessionId;
      assert.ok(sessionId);
      const workbenchUrl = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workbench`;
      assertOk(await requestJson(stack.gatewayUrl, `${workbenchUrl}/worktree`, { method: "POST", body: { baseRef: "HEAD" } }), "create isolated Git worktree");
      const readFile = () => requestJson(stack.gatewayUrl, `${workbenchUrl}/file?path=index.ts`);
      const before = await readFile();
      assertOk(before, "read reviewed file"); assert.match(before.body.revision, /^[a-f0-9]{64}$/);
      const unguarded = await requestJson(stack.gatewayUrl, `${workbenchUrl}/file`, { method: "PUT", body: { path: "index.ts", content: "unguarded" } });
      assert.equal(unguarded.status, 400);
      const draft = "export const operatorDraft = true;\n";
      const browser = await chromium.launch({ headless: true });
      let page; let browserLog; let logCursor;
      try {
        const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
        await installMissionControlNextBrowserState(browserContext, workspaceId);
        page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(sessionId)}`), { waitUntil: "domcontentloaded" });
        await page.getByLabel("Message composer").waitFor({ timeout: 60_000 });
        await page.getByRole("button", { name: "Activity", exact: true }).click();
        await page.getByRole("button", { name: "Open build editor", exact: true }).click();
        await page.getByRole("tab", { name: "Files", exact: true }).click();
        const editor = page.getByRole("tabpanel", { name: "Files", exact: true }).locator(".monaco-editor .view-lines");
        await editor.waitFor(); await editor.click({ position: { x: 40, y: 10 } });
        await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.insertText(draft);
        let concurrent;
        const submittedRevisions = [];
        await page.route(`**${workbenchUrl}/file`, async (route) => {
          if (route.request().method() === "PUT") {
            const input = route.request().postDataJSON();
            assert.equal(input.content, draft);
            submittedRevisions.push(input.expectedRevision);
            if (!concurrent) {
              assert.equal(input.expectedRevision, before.body.revision);
              const winner = await requestJson(stack.gatewayUrl, `${workbenchUrl}/file`, { method: "PUT",
                body: { path: "index.ts", content: "export const concurrentWriter = true;\n", expectedRevision: before.body.revision } });
              assertOk(winner, "commit another writer after the browser's preflight read");
              concurrent = winner.body;
            }
          }
          await route.continue();
        });
        const waitForSave = () => page.waitForResponse((response) => new URL(response.url()).pathname === `${workbenchUrl}/file` && response.request().method() === "PUT");
        const saveButton = page.getByRole("button", { name: "Save file", exact: true });
        const [conflict] = await Promise.all([waitForSave(), saveButton.click()]);
        assert.equal(conflict.status(), 409);
        assert.equal((await conflict.json()).details?.reason, "WORKBENCH_FILE_REVISION_CONFLICT");
        await page.getByText("This file changed since editing began. Your draft is preserved.", { exact: true }).waitFor();
        assert.equal((await readFile()).body.content, concurrent.content);
        assert.equal(await saveButton.isDisabled(), true);
        assert.equal(await page.getByText("API error 409", { exact: false }).count(), 0);
        const conflictArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-file-conflict", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        await page.getByText("Review latest file", { exact: true }).click();
        await page.getByText("export const concurrentWriter = true;", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Use this version and keep my draft", exact: true }).click();
        logCursor = browserLog.mark();
        const [saved] = await Promise.all([waitForSave(), saveButton.click()]);
        assert.equal(saved.status(), 200);
        const accepted = await saved.json();
        assert.equal(accepted.content, draft); assert.notEqual(accepted.revision, concurrent.revision);
        assert.deepEqual(submittedRevisions, [before.body.revision, concurrent.revision]);
        assert.equal((await readFile()).body.revision, accepted.revision);
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Save file" && button.disabled));
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        const savedArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-file-reviewed-save", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        await page.setViewportSize({ width: 390, height: 844 });
        const narrowArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-file-narrow", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        const pathReview = await exerciseWorkbenchPathReview(context, deps, {
          page, browserLog, gatewayUrl: stack.gatewayUrl, workbenchUrl, correlationId,
        });
        const diagnostics = path.join(context.artifactRoot, "diagnostics", "workbench-file-revision.json");
        await writeJson(diagnostics, { workspaceId, projectId: project.body.projectId, sessionId, submittedRevisions,
          unguardedStatus: unguarded.status, conflictStatus: conflict.status(), accepted, concurrent,
          pathReview: pathReview.diagnostics, draftPreserved: true, note: "A real Gateway save races the browser after preflight. The first browser log intentionally includes the asserted 409. All Git and runtime state is temporary." });
        return { status: "passed", metrics: { unguardedRejected: 1, concurrentSaveRejected: 1, reviewedSave: 1, ...pathReview.metrics },
          artifacts: Object.fromEntries(Object.keys(savedArtifacts).map((key) => [key, [...savedArtifacts[key], ...(conflictArtifacts[key] ?? []),
            ...(narrowArtifacts[key] ?? []), ...(pathReview.artifacts[key] ?? []), ...(key === "diagnostics" ? [relativeToRun(context, diagnostics)] : [])]])) };
      } catch (error) {
        if (page && browserLog) await captureBrowserArtifacts(context, { slug: "workbench-file-revision-failure", page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
        throw error;
      } finally { await browser.close(); }
    });
  } finally {
    try { if (stack) { assert.equal(stack.runtimeRoot, runtimeRoot); await stopVerificationStack(stack); } }
    finally { try { await llmStub?.close(); } finally { restoreUi(); } }
  }
}
