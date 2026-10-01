import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export function assertProjectConversationScope({ ownerItems, visibleIds, workspaceId, projectId, folderId = "all" }) {
  assert.ok(ownerItems.every((item) => item.workspaceId === workspaceId), "Search owner returned a foreign workspace");
  const expected = ownerItems.filter((item) => (projectId === "all" || item.projectId === projectId)
    && (folderId === "all" || item.folderId === folderId)).map((item) => item.sessionId).sort();
  assert.deepEqual([...visibleIds].sort(), expected, "Visible conversations do not match the exact selected owner scope");
  assert.equal(new Set(visibleIds).size, visibleIds.length, "Conversation identity was duplicated");
}

export function assertProjectReadRequests(requests, prefsBySession) {
  for (const request of requests) {
    const match = /^\/api\/v1\/chat\/sessions\/([^/]+)\/route-preflight$/u.exec(request.path);
    assert.equal(request.method, "POST", "Filtering issued an unexpected write method");
    assert.ok(match, `Filtering issued an unexpected mutation endpoint: ${request.path}`);
    const prefs = prefsBySession[decodeURIComponent(match[1])];
    assert.ok(prefs, "Routing inspection belongs to a foreign conversation");
    const body = request.body;
    assert.equal(body.action, "send");
    assert.ok(Object.keys(body).every((key) => ["action", "prefsOverride", "fullWebAccess"].includes(key)),
      "Read-only routing inspection captured content, a turn, or a workspace snapshot");
    if (body.fullWebAccess !== undefined) assert.equal(typeof body.fullWebAccess, "boolean");
    if (body.prefsOverride) {
      const fields = ["mode", "providerId", "model", "webMode", "memoryMode", "thinkingLevel", "speedMode", "subagentPolicy"];
      const expected = Object.fromEntries(fields.filter((field) => prefs[field] !== undefined).map((field) => [field, prefs[field]]));
      assert.deepEqual(body.prefsOverride, expected, "Routing inspection differs from unchanged canonical preferences");
    }
  }
  return requests.length;
}

export async function runCockpitChatProjectProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const read = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-chat-project.${variant}`, lane: "ux-budgets",
      title: `Cockpit Chat project and search scope ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const token = randomUUID().slice(0, 8);
      const workspace = await read("/api/v1/workspaces", { method: "POST", body: { name: `Project proof ${token}`, ...(citadelId ? { citadelId } : {}) } });
      assert.ok(workspace.workspaceId && workspace.citadelId);
      const workspaceId = workspace.workspaceId;
      const projects = [];
      for (const suffix of ["A", "B"]) projects.push(await read("/api/v1/chat/projects", { method: "POST",
        body: { workspaceId, citadelId: workspace.citadelId, name: `Project ${suffix} ${token}`, workspacePath: `proof-${token}-${suffix}` } }));
      const common = `ScopeNeedle${token}`;
      const sessions = [];
      for (const [index, title] of [`${common} Alpha`, `Different ${token} Beta`, `${common} Foreign project`].entries()) {
        sessions.push(await read("/api/v1/chat/sessions", { method: "POST", body: { workspaceId,
          projectId: projects[index < 2 ? 0 : 1].projectId, title,
          folderId: `folder-${index < 2 ? index : 0}-${token}`, folderName: `Folder ${index < 2 ? index : 0} ${token}` } }));
      }
      const foreignWorkspace = await read("/api/v1/workspaces", { method: "POST", body: { name: `Foreign project proof ${token}` } });
      const foreign = await read("/api/v1/chat/sessions", { method: "POST", body: { workspaceId: foreignWorkspace.workspaceId, title: `${common} Foreign workspace` } });
      const baseline = await read(`/api/v1/chat/sessions?${new URLSearchParams({ workspaceId, scope: "mission", view: "active", limit: "200" })}`);
      assert.deepEqual(baseline.items.map((item) => item.sessionId).sort(), sessions.map((item) => item.sessionId).sort());
      const prefsBySession = {}, threadsBySession = {};
      for (const session of sessions) {
        prefsBySession[session.sessionId] = await read(`/api/v1/chat/sessions/${session.sessionId}/prefs`);
        threadsBySession[session.sessionId] = await read(`/api/v1/chat/sessions/${session.sessionId}/thread`);
      }
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
      let page, stage = "setup";
      const searches = [], mutations = [];
      const screenshots = [];
      try {
        await browserContext.addInitScript((theme) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        }, variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname === "/api/v1/chat/session-search") searches.push(url);
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && url.pathname.startsWith("/api/v1/chat/"))
            mutations.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${sessions[0].sessionId}&shell=cockpit`), { waitUntil: "domcontentloaded" });
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 30_000 });
        stage = "select exact project";
        let filters = await openFilters();
        await filters.getByRole("combobox", { name: "Filter by project", exact: true }).selectOption(projects[0].projectId);
        await closeFilters();
        await assertVisible(baseline.items, projects[0].projectId);

        stage = "folder selection and clearing";
        filters = await openFilters();
        await filters.getByRole("button", { name: new RegExp(`^Folder 1 ${token}`) }).click();
        await closeFilters();
        await assertVisible(baseline.items, projects[0].projectId, sessions[1].folderId);
        filters = await openFilters();
        await filters.getByRole("button", { name: "All conversations", exact: true }).click();
        await closeFilters();
        await assertVisible(baseline.items, projects[0].projectId);

        stage = "search within project projection";
        const canonicalSearch = await read(`/api/v1/chat/session-search?${new URLSearchParams({ query: common, workspaceId, mode: "discovery", view: "active", surface: "chat", limit: "40" })}`);
        const searchItems = canonicalSearch.items.map((item) => item.session);
        assert.ok(searchItems.some((item) => item.sessionId === sessions[2].sessionId), "Search fixture lacks same-query foreign-project evidence");
        assert.ok(!searchItems.some((item) => item.sessionId === foreign.sessionId));
        filters = await openFilters();
        await filters.getByRole("textbox", { name: "Search conversations", exact: true }).fill(common);
        await closeFilters();
        await assertVisible(searchItems, projects[0].projectId);
        assert.ok(searches.some((url) => url.searchParams.get("query") === common && url.searchParams.get("workspaceId") === workspaceId),
          "Browser search did not request the exact workspace owner");
        if (variant === "mobile") await page.getByRole("combobox", { name: "Choose conversation", exact: true }).selectOption(sessions[0].sessionId);
        else await page.getByRole("navigation", { name: "Threads", exact: true }).getByRole("button", { name: new RegExp(`^${common} Alpha`) }).click();
        assert.equal(new URL(page.url()).searchParams.get("sessionId"), sessions[0].sessionId);
        const routingInspections = assertProjectReadRequests(mutations, prefsBySession);
        for (const session of sessions) {
          assert.deepEqual(await read(`/api/v1/chat/sessions/${session.sessionId}/prefs`), prefsBySession[session.sessionId], "Filtering changed conversation preferences");
          assert.deepEqual(await read(`/api/v1/chat/sessions/${session.sessionId}/thread`), threadsBySession[session.sessionId], "Filtering changed conversation history");
        }
        const afterSessions = await read(`/api/v1/chat/sessions?${new URLSearchParams({ workspaceId, scope: "mission", view: "active", limit: "200" })}`);
        assert.deepEqual([...afterSessions.items].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
          [...baseline.items].sort((a, b) => a.sessionId.localeCompare(b.sessionId)), "Filtering changed session or project binding records");
        await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const heightShare = await page.locator('[aria-label="Messages"]').evaluate((element) => element.getBoundingClientRect().height / window.innerHeight);
        assert.ok(heightShare >= 0.55, `Closed filters left only ${(heightShare * 100).toFixed(1)}% of viewport for Chat`);
        const screenshot = path.join(context.artifactRoot, "screenshots", `cockpit-chat-project-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        return { status: "passed", metrics: { projects: 2, folderClear: true, foreignProjectExcluded: true, foreignWorkspaceExcluded: true,
          ownerMutations: 0, routingInspections, unchangedPrefsAndThreads: sessions.length, messageHeightShare: heightShare }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        await mkdir(path.join(context.artifactRoot, "diagnostics"), { recursive: true });
        await mkdir(path.join(context.artifactRoot, "screenshots"), { recursive: true });
        const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-project-${variant}-failure.json`);
        await writeFile(diagnostic, `${JSON.stringify({ stage, workspaceId, projectIds: projects.map((project) => project.projectId), mutations, searches: searches.map((url) => url.pathname + url.search), error: String(error) }, null, 2)}\n`);
        if (page) {
          const screenshot = path.join(context.artifactRoot, "screenshots", `cockpit-chat-project-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }).then(() => screenshots.push(relativeToRun(context, screenshot))).catch(() => {});
        }
        return { status: "failed", error: `${stage}: ${error.stack ?? error}`, metrics: { failedStage: stage },
          artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic)] }) };
      } finally { await browserContext.close(); }

      async function openFilters() {
        if (variant !== "mobile") return page.getByRole("complementary", { name: "Conversations", exact: true });
        await page.getByRole("combobox", { name: "Choose conversation", exact: true }).selectOption({ label: "Filter conversations…" });
        const dialog = page.getByRole("dialog", { name: "Filter conversations", exact: true });
        await dialog.waitFor();
        return dialog;
      }
      async function closeFilters() {
        if (variant === "mobile") await page.getByRole("dialog", { name: "Filter conversations", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
      }
      async function assertVisible(ownerItems, projectId, folderId = "all") {
        let lastError;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          let ids;
          if (variant === "mobile") ids = await page.getByRole("combobox", { name: "Choose conversation", exact: true }).locator("option").evaluateAll((options) =>
            options.map((option) => option.value).filter((value) => value && !value.startsWith("history:") && !value.startsWith("view:")));
          else ids = (await page.getByRole("navigation", { name: "Threads", exact: true }).getByRole("button").allTextContents()).map((label) => sessions.find((item) => label.startsWith(item.title))?.sessionId ?? `unexpected:${label}`);
          try { assertProjectConversationScope({ ownerItems, visibleIds: ids, workspaceId, projectId, folderId }); return; }
          catch (error) { lastError = error; await page.waitForTimeout(250); }
        }
        throw lastError;
      }
    });
  }
}
