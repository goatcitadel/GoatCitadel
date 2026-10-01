import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";

const PREVIEW_PATH = "000-preview.txt";
const LARGE_PATH = "001-large.txt";
const PREVIEW_CONTENT = "Current worktree fixture, edited after the durable run.\n<script>This stays plain text.</script>\n";

function inside(path, root, target) {
  const relative = path.relative(root, target);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Work context fixture must stay inside its lane-owned runtime");
  return target;
}

export async function createWorkContextProjectFixture(stack, path) {
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),
    "Work context proof requires the isolated usability runtime");
  const runtimeRoot = await realpath(stack.runtimeRoot);
  const assistant = JSON.parse(await readFile(path.join(runtimeRoot, "config", "assistant.config.json"), "utf8"));
  assert.equal(typeof assistant.workspaceDir, "string");
  assert.equal(typeof assistant.worktreesDir, "string");
  const workspaceRoot = inside(path, runtimeRoot, path.resolve(runtimeRoot, assistant.workspaceDir));
  const worktreesRoot = inside(path, runtimeRoot, path.resolve(runtimeRoot, assistant.worktreesDir));
  await mkdir(workspaceRoot, { recursive: true });
  inside(path, runtimeRoot, await realpath(workspaceRoot));
  const source = await mkdtemp(path.join(workspaceRoot, "cockpit-work-context-"));
  const paths = [PREVIEW_PATH, LARGE_PATH, ...Array.from({ length: 80 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`)];
  await Promise.all(paths.map((file) => writeFile(path.join(source, file), file === LARGE_PATH ? "x".repeat(64 * 1024 + 1) : `Original fixture ${file}\n`)));
  const hookRoot = inside(path, runtimeRoot, path.join(runtimeRoot, "work-context-empty-hooks"));
  await mkdir(hookRoot, { recursive: true });
  const emptyConfig = inside(path, runtimeRoot, path.join(runtimeRoot, "work-context-empty.gitconfig"));
  await writeFile(emptyConfig, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  env.GIT_CONFIG_NOSYSTEM = "1";
  // Git for Windows cannot open node:os devNull (\\.\nul) as a config file.
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  const git = (args) => {
    try {
      return execFileSync("git", ["-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
        "-c", `core.hooksPath=${hookRoot}`, "-c", "user.name=Work Context Verification", "-c", "user.email=work-context@example.invalid", ...args],
      { cwd: source, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024, windowsHide: true });
    } catch (error) {
      throw new Error(`Work context fixture git ${args[0]} failed (${error.status ?? "spawn"}): ${String(error.stderr ?? error.message).trim().slice(0, 2000)}`, { cause: error });
    }
  };
  git(["init", "--template="]);
  git(["config", "core.longpaths", "true"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "--", ...paths]);
  git(["commit", "-m", "Initialize isolated Work context fixture"]);
  return { runtimeRoot, worktreesRoot, workspacePath: path.relative(workspaceRoot, source).replaceAll("\\", "/"), paths };
}

export async function runCockpitWorkContextProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-work-context.${variant}`, lane: "ux-budgets",
      title: `Cockpit current worktree and file preview ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const fixture = await createWorkContextProjectFixture(stack, path);
      const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
        method: "POST", body: { workspaceName: `Work context ${variant}`, sessionTitle: "Work context seed", sessionCount: 1, longThreadTurns: 2 },
      });
      assertOk(seeded, "seed Work context workspace");
      const workspaceId = seeded.body?.workspaceId;
      assert.ok(workspaceId, "Work context seed has no workspace");
      const project = await requestJson(stack.gatewayUrl, "/api/v1/chat/projects", {
        method: "POST", body: { workspaceId, name: `Work context project ${variant}`, workspacePath: fixture.workspacePath },
      });
      assertOk(project, "create isolated Work context project");
      const projectId = project.body?.projectId;
      assert.ok(projectId, "Work context project has no identity");
      const created = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
        method: "POST", body: { workspaceId, projectId, title: "Inspect current worktree", mode: "chat" },
      });
      assertOk(created, "create exact project-bound conversation");
      const sessionId = created.body?.sessionId;
      assert.ok(sessionId);
      assert.equal(created.body.workspaceId, workspaceId);
      assert.equal(created.body.projectId, projectId);
      const route = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
      const workbenchUrl = `${route}/workbench`;
      const initialized = await requestJson(stack.gatewayUrl, `${workbenchUrl}/worktree`, { method: "POST", body: { baseRef: "HEAD" } });
      assertOk(initialized, "create lane-owned Git worktree");
      const state = initialized.body?.state;
      assert.equal(state?.sessionId, sessionId);
      assert.equal(state.projectId, projectId);
      assert.equal(state.worktreeStatus, "ready");
      assert.ok(state.worktreePath && state.worktreePath !== "[outside-root]");
      const worktreePath = inside(path, fixture.worktreesRoot, path.resolve(fixture.runtimeRoot, state.worktreePath));
      inside(path, fixture.runtimeRoot, await realpath(worktreePath));

      const input = { action: "send", content: "Reply with the verification summary.", mode: "chat", webMode: "off", memoryMode: "off" };
      const preflight = await requestJson(stack.gatewayUrl, `${route}/route-preflight`, { method: "POST", body: input });
      assertOk(preflight, "preflight Work context conversation");
      const decision = preflight.body?.decision;
      assert.ok(decision?.effectiveProviderId && decision.effectiveModel, "Work context preflight has no model route");
      const sent = await requestJson(stack.gatewayUrl, `${route}/agent-send`, { method: "POST", body: {
        ...input, routeDecision: decision, providerId: decision.effectiveProviderId, model: decision.effectiveModel,
      } });
      assertOk(sent, "complete Work context durable Chat turn");
      const runId = sent.body?.trace?.durable?.runId;
      assert.ok(runId && sent.body.turnId);
      assert.equal(sent.body.trace.status, "completed");
      const trace = await requestJson(stack.gatewayUrl, `/api/v1/observe/runs/${encodeURIComponent(runId)}/trace`);
      assertOk(trace, "read exact Work context lifecycle");
      assert.equal(trace.body?.lifecycle?.state, "available");
      assert.equal(trace.body.lifecycle.response.canonical.runId, runId);
      assert.equal(trace.body.lifecycle.response.canonical.sessionId, sessionId);
      assert.equal(trace.body.run.payload.workspaceId, workspaceId);
      const session = await requestJson(stack.gatewayUrl, `${route}/status`);
      assertOk(session, "read current scoped conversation owner");
      assert.equal(session.body?.sessionId, sessionId);
      assert.equal(session.body.workspaceId, workspaceId);

      // Fixture-only writes occur after completion, proving the panel describes current context.
      await writeFile(path.join(worktreePath, PREVIEW_PATH), PREVIEW_CONTENT);
      await Promise.all(fixture.paths.slice(2, 47).map((file) => writeFile(path.join(worktreePath, file), `Post-run fixture update ${file}\n`)));
      const tree = await requestJson(stack.gatewayUrl, `${workbenchUrl}/tree?preview=true`);
      assertOk(tree, "read current tree owner");
      assert.equal(tree.body?.state?.sessionId, sessionId);
      assert.equal(tree.body.state.projectId, projectId);
      assert.ok(tree.body.changedFiles.length > 40 && tree.body.items.length > 60);
      const owner = await requestJson(stack.gatewayUrl, `${workbenchUrl}/file?path=${encodeURIComponent(PREVIEW_PATH)}&preview=true`);
      assertOk(owner, "read exact current file owner");
      assert.equal(owner.body?.content, PREVIEW_CONTENT);
      assert.equal(owner.body.state.sessionId, sessionId);
      assert.equal(owner.body.state.projectId, projectId);

      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      try {
        await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
        await browserContext.addInitScript((value) => window.localStorage.setItem("goatcitadel.ui.theme.v1", value), theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        const page = await browserContext.newPage();
        const reads = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith(workbenchUrl)) reads.push({ method: request.method(), url: request.url() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/work/runs/${encodeURIComponent(runId)}?shell=cockpit`), { waitUntil: "domcontentloaded" });
        const section = page.getByRole("region", { name: "Current conversation worktree", exact: true });
        await section.waitFor({ timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        assert.equal(reads.length, 0, "Worktree reads must be explicit");
        await section.getByRole("button", { name: "Inspect current worktree", exact: true }).click();
        await section.getByText(state.worktreePath, { exact: true }).waitFor();
        await section.getByText(state.baseRef, { exact: true }).waitFor();
        assert.ok(reads.length && reads.every((item) => new URL(item.url).pathname === workbenchUrl));
        await section.getByRole("button", { name: "Inspect files", exact: true }).click();
        const changedList = section.getByRole("region", { name: "Current changed files", exact: true });
        const treeList = section.getByRole("region", { name: "Current file tree", exact: true });
        await treeList.waitFor();
        assert.deepEqual(await changedList.locator("li button").allTextContents(), tree.body.changedFiles.slice(0, 40));
        assert.deepEqual(await treeList.locator("li button").allTextContents(), tree.body.items.slice(0, 60).map((item) => item.path));
        assert.equal(reads.filter((item) => new URL(item.url).pathname === `${workbenchUrl}/file`).length, 0);
        await treeList.getByRole("button", { name: `Preview ${PREVIEW_PATH}`, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Current file preview", exact: true });
        await dialog.locator("code").waitFor();
        assert.equal(await dialog.locator("code").textContent(), owner.body.content);
        assert.equal(await dialog.locator("iframe, textarea").count(), 0);
        if (variant === "desktop") {
          await page.waitForFunction(() => {
            const panel = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
            return panel && Math.abs(panel.right - window.innerWidth) <= 1 && panel.width < window.innerWidth * 0.6 && panel.height >= window.innerHeight - 1;
          });
        } else {
          await page.waitForFunction(() => {
            const panel = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
            return panel && Math.abs(panel.bottom - window.innerHeight) <= 1 && panel.left >= -1 && panel.right <= window.innerWidth + 1;
          });
        }
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(blocking.length, 0, `Blocking Work context accessibility: ${blocking.map((item) => item.id).join(", ")}`);
        assert.ok(overflow <= 1, `Work context horizontal overflow: ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-work-context-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        await dialog.getByRole("button", { name: "Close sheet", exact: true }).click();
        await treeList.getByRole("button", { name: `Preview ${LARGE_PATH}`, exact: true }).click();
        await dialog.getByText("This file exceeds the 64 KiB preview limit.", { exact: false }).waitFor();
        assert.equal(await dialog.locator("code").count(), 0);
        await dialog.getByRole("button", { name: "Close sheet", exact: true }).click();
        await section.getByRole("button", { name: "Refresh worktree context", exact: true }).click();
        await section.getByRole("button", { name: "Inspect files", exact: true }).waitFor();
        assert.equal(await treeList.count(), 0, "Refresh must clear the old tree");
        assert.ok(reads.every((item) => item.method === "GET"), "Work context browser issued a mutation");
        assert.ok(reads.every((item) => new URL(item.url).searchParams.get("preview") === "true"), "Work context omitted non-selecting preview mode");
        const after = await requestJson(stack.gatewayUrl, `${workbenchUrl}?preview=true`);
        assertOk(after, "confirm Work context preserved metadata");
        assert.equal(after.body?.state?.activeFilePath, owner.body.state.activeFilePath);
        assert.equal(after.body.state.updatedAt, owner.body.state.updatedAt);
        return { status: "passed", metrics: { runId, sessionId, projectId, currentContextAfterRun: true,
          changedPathsShown: 40, treeEntriesShown: 60, previewMatchesOwner: true, oversizedPreviewRejected: true,
          workbenchReads: reads.length, blockingAxe: 0, overflow },
        artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } finally {
        await browserContext.close();
      }
      // The parent verification stack owns removal of this isolated runtime and its Git worktrees.
    });
  }
}
