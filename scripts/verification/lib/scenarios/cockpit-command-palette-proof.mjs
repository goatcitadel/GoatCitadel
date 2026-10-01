import { fillNavigationGrantDraft, reviewNavigationDraft, assertNavigationDraftOwner } from "./cockpit-navigation-draft-proof.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export function assertPaletteCreation({ request, receipt, canonical, workspaceId, citadelId, creates, sends }) {
  assert.deepEqual(request, { workspaceId, citadelId, mode: "chat", includeInHistory: true });
  assert.equal(creates, 1, "New chat dispatched more than one creation.");
  assert.equal(sends, 0, "Palette creation sent a conversation message.");
  assert.ok(receipt.sessionId && receipt.revision >= 1);
  assert.equal(receipt.workspaceId, workspaceId);
  assert.equal(receipt.scope, "mission");
  assert.equal(receipt.mode, "chat");
  assert.equal(receipt.lifecycleStatus, "active");
  assert.equal(receipt.includeInHistory, true);
  assert.equal(canonical.sessionId, receipt.sessionId);
  assert.equal(canonical.workspaceId, workspaceId);
}

export function assertPaletteThreadScope({ items, expectedSessionId, foreignSessionId, workspaceId }) {
  assert.ok(items.some(item => item.session.sessionId === expectedSessionId), "Exact conversation missing from Gateway search.");
  assert.ok(items.every(item => item.session.workspaceId === workspaceId), "Search returned a foreign workspace.");
  assert.ok(items.every(item => item.session.sessionId !== foreignSessionId), "Foreign conversation was returned.");
}

/** Exact creation effects of Gateway ensureChatSessionRuntimeGrants, never a draft-grant exemption. */
export function assertPaletteBootstrapGrants({ before, after, sessionGrants, sessionId }) {
  const tools = ["runtime.configure", "browser.search", "browser.navigate", "browser.extract", "http.get",
    "session.search", "session.history", "local_business.research"].sort();
  assert.ok(before.items.length + tools.length <= 400, "Grant snapshot limit cannot retain every original grant plus bootstrap additions.");
  const beforeIds = new Set(before.items.map(item => item.grantId));
  const afterIds = new Set(after.items.map(item => item.grantId));
  assert.equal(beforeIds.size, before.items.length, "Original grant IDs are not unique.");
  assert.equal(afterIds.size, after.items.length, "Post-create grant IDs are not unique.");
  assert.ok(after.items.every(item => typeof item.grantId === "string" && item.grantId.length > 0));
  assert.ok(before.items.every(item => item.scope !== "session" || item.scopeRef !== sessionId), "New session already had recorded grants.");
  const retained = after.items.filter(item => beforeIds.has(item.grantId));
  assert.deepEqual({ ...after, items: retained }, before, "Session creation changed or removed an original grant.");
  const added = after.items.filter(item => !beforeIds.has(item.grantId));
  assert.equal(added.length, tools.length, "Creation added an unexpected number of grants.");
  assert.deepEqual(added.map(item => item.toolPattern).sort(), tools, "Creation grant tools differ from the exact Gateway bootstrap set.");
  for (const item of added) {
    assert.ok(Number.isFinite(Date.parse(item.createdAt)), "Bootstrap grant lacks a canonical creation timestamp.");
    assert.deepEqual(item, { grantId: item.grantId, createdAt: item.createdAt, toolPattern: item.toolPattern,
      decision: "allow", scope: "session", scopeRef: sessionId, grantType: "persistent", createdBy: "system-chat-agent-bootstrap" },
    "Unexpected bootstrap grant scope, actor, lifetime, constraints or mutation metadata.");
  }
  const byId = items => [...items].sort((left, right) => left.grantId.localeCompare(right.grantId));
  assert.deepEqual({ ...sessionGrants, items: byId(sessionGrants.items) }, { items: byId(added) }, "Independent exact-session grant read differs from creation additions.");
  return added.length;
}

/** Only disposable workspace/note/session records are created. No messages, tools or approvals execute. */
export async function runCockpitCommandPaletteProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-command-palette.${variant}`, lane: "ux-budgets",
      title: `Global palette scoped objects, explicit New chat and owner handoffs ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const suffix = randomUUID().slice(0, 8), needle = `PaletteNeedle${suffix}`;
      const screenshots = [], diagnostics = [], creates = [], sends = [];
      let page, browserContext, stage = "seed disposable canonical records";
      try {
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Palette ${suffix}`, ...(citadelId ? { citadelId } : {}) } });
        const workspaceId = workspace.workspaceId;
        assert.ok(workspaceId && workspace.citadelId);
        const foreignWorkspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Palette foreign ${suffix}`, citadelId: workspace.citadelId } });
        const session = await api("/api/v1/chat/sessions", { method: "POST", body: { workspaceId, citadelId: workspace.citadelId, mode: "chat", title: `${needle} conversation` } });
        const foreign = await api("/api/v1/chat/sessions", { method: "POST", body: { workspaceId: foreignWorkspace.workspaceId, citadelId: workspace.citadelId, mode: "chat", title: `${needle} foreign` } });
        const note = await api("/api/v1/notes", { method: "POST", body: { workspaceId, title: `${needle} note`, body: `Canonical note body ${suffix}` } });
        assert.equal(note.workspaceId, workspaceId);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          window.localStorage.setItem("goatcitadel.ui.density.v1", "comfortable");
        }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const route = new URL(request.url()).pathname;
          if (request.method() === "POST" && route === "/api/v1/chat/sessions") creates.push(request.postDataJSON());
          if (request.method() === "POST" && /\/(?:agent-send|send)(?:\/stream)?$/u.test(route)) sends.push(route);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);

        stage = "search exact workspace and Library records";
        await openPalette(needle);
        const dialog = palette();
        await dialog.getByRole("option", { name: `${needle} conversation Workspace conversation`, exact: true }).waitFor();
        await dialog.getByRole("option", { name: new RegExp(`^${needle} note `, "u") }).waitFor();
        assert.equal(await dialog.getByText(`${needle} foreign`, { exact: true }).count(), 0);
        const ownerSearch = await api(`/api/v1/chat/session-search?${new URLSearchParams({ query: needle, mode: "discovery", view: "all", workspaceId, citadelId: workspace.citadelId, surface: "chat", limit: "10", includeHidden: "false" })}`);
        assertPaletteThreadScope({ items: ownerSearch.items, expectedSessionId: session.sessionId, foreignSessionId: foreign.sessionId, workspaceId });
        const beforeCoverageUrl = page.url();
        const coverage = dialog.getByText("Search coverage", { exact: true }).first();
        await coverage.focus(); await coverage.press("Enter");
        assert.equal(await coverage.locator("..").getAttribute("open"), "");
        await coverage.press("Space");
        assert.equal(await coverage.locator("..").getAttribute("open"), null);
        assert.equal(page.url(), beforeCoverageUrl);
        await dialog.waitFor();
        assert.equal(creates.length, 0); assert.equal(sends.length, 0);
        await capture("search");
        await dialog.getByRole("option", { name: new RegExp(`^${needle} note `, "u") }).click();
        await page.getByText(note.body, { exact: true }).waitFor();
        assert.equal(creates.length, 0); assert.equal(sends.length, 0);
        await page.keyboard.press("Escape");

        stage = "keyboard conversation handoff";
        await openPalette(needle);
        const conversation = palette().getByRole("option", { name: `${needle} conversation Workspace conversation`, exact: true });
        await conversation.waitFor();
        await conversation.hover(); await page.keyboard.press("Enter");
        await page.waitForURL(url => url.pathname === "/chat" && url.searchParams.get("sessionId") === session.sessionId);
        assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);

        stage = "density, model and Inbox owner access";
        await openPalette("density");
        await palette().getByRole("option", { name: "Switch to compact density", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.density === "compact");
        await openPalette("density");
        await palette().getByRole("option", { name: "Switch to comfortable density", exact: true }).click();
        const config = await api("/api/v1/llm/config");
        await openPalette("model");
        await palette().getByText(`Gateway default: ${config.activeProviderId} / ${config.activeModel}. Opens reviewed Settings. Conversation overrides stay in Chat.`, { exact: true }).waitFor();
        await palette().getByRole("option", { name: /^Choose default model…/u }).click();
        await page.waitForURL(url => url.pathname === "/settings/models" && url.hash === "#providers");
        await openPalette("Go to Inbox");
        await palette().getByRole("option", { name: "Go to Inbox", exact: true }).click();
        await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
        const inbox = await api(`/api/v1/inbox?workspaceId=${encodeURIComponent(workspaceId)}`);
        assert.equal(inbox.workspaceId, workspaceId);
        assert.ok(inbox.items.every(item => item.source.workspaceId === workspaceId));
        assert.equal(creates.length, 0); assert.equal(sends.length, 0);

        stage = "leave consent before New chat creation";
        await openPalette("approval prompt");
        await palette().getByRole("option", { name: "Settings · Tools", exact: true }).click();
        await page.waitForURL(url => url.pathname === "/settings/safety" && url.hash === "#approval-mode");
        const grantsBefore = await api("/api/v1/tools/grants?limit=400");
        const grantWrites = [];
        page.on("request", request => {
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/tools/grants")) grantWrites.push(request.method());
        });
        const grantDraft = await fillNavigationGrantDraft(page);
        await openPalette("New chat");
        const triggerNewChat = () => palette().getByRole("option", { name: /^New chat Create one conversation/u }).click();
        await reviewNavigationDraft(page, triggerNewChat, "Cancel");
        assert.equal(creates.length, 0); assert.equal(sends.length, 0);
        // Cancel returns to the palette; close its modal before inspecting the accessible owner form.
        await palette().getByRole("button", { name: "Close dialog", exact: true }).click();
        await palette().waitFor({ state: "hidden" });
        await grantDraft.field.waitFor();
        assert.equal(await grantDraft.field.inputValue(), grantDraft.value);
        assert.equal(creates.length, 0); assert.equal(sends.length, 0); assert.equal(grantWrites.length, 0);
        stage = "one reviewed explicit verified New chat";
        await openPalette("New chat");
        const response = page.waitForResponse(item => item.request().method() === "POST" && new URL(item.url()).pathname === "/api/v1/chat/sessions");
        void response.catch(() => undefined);
        await reviewNavigationDraft(page, triggerNewChat, "Keep draft and close");
        const http = await response; assert.equal(http.status(), 201);
        const receipt = await http.json();
        await page.waitForURL(url => url.pathname === "/chat" && url.searchParams.get("sessionId") === receipt.sessionId);
        const canonical = await api(`/api/v1/chat/sessions/${encodeURIComponent(receipt.sessionId)}/status`);
        assertPaletteCreation({ request: http.request().postDataJSON(), receipt, canonical, workspaceId,
          citadelId: workspace.citadelId, creates: creates.length, sends: sends.length });
        const thread = await api(`/api/v1/chat/sessions/${encodeURIComponent(receipt.sessionId)}/thread`);
        assert.deepEqual(thread.turns, []);
        const grantsCreated = await api("/api/v1/tools/grants?limit=400");
        const bootstrapGrants = assertPaletteBootstrapGrants({ before: grantsBefore, after: grantsCreated,
          sessionId: receipt.sessionId, sessionGrants: await api(`/api/v1/tools/grants?${new URLSearchParams({ scope: "session", scopeRef: receipt.sessionId, limit: "400" })}`) });
        assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
        await page.goBack();
        await page.waitForURL(url => url.pathname === "/settings/safety" && url.hash === "#approval-mode");
        await grantDraft.field.waitFor();
        assertNavigationDraftOwner({ before: grantsCreated, after: await api("/api/v1/tools/grants?limit=400"), writes: grantWrites,
          origin: timeOrigin, current: await page.evaluate(() => performance.timeOrigin), retained: await grantDraft.field.inputValue(), expected: grantDraft.value });
        await openPalette("New chat"); await capture("created");
        return { status: "passed", metrics: { workspaceId, sessionId: receipt.sessionId, exactScopedSearch: true,
          libraryNoteInspected: true, coverageKeyboardNeverDispatches: true, sameDocument: true, leaveConsentBeforeCreation: true, cancelCreatedNothing: true, grantDraftRetained: true, exactSessionBootstrapGrants: bootstrapGrants, browserGrantWrites: grantWrites.length, createdConversations: creates.length, providerSends: sends.length,
          boundary: "Canonical scoped conversations and note; New chat added only eight independently verified default session grants. The unsaved grant was not written. Current Inbox inspected without decisions. No provider turn, model mutation or tool execution." }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };

        function palette() { return page.getByRole("dialog", { name: "Command palette", exact: true }); }
        async function openPalette(query) {
          await page.keyboard.press("Control+k");
          await palette().getByRole("combobox", { name: "Search or run a command", exact: true }).fill(query);
        }
        async function capture(name) {
          if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter(item => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, `Palette accessibility: ${blocking.map(item => item.id).join(", ")}`);
          const bounds = await palette().boundingBox(); assert.ok(bounds);
          assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "Palette dialog clipped horizontally.");
          assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= viewport.height + 1, "Palette dialog clipped vertically.");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
          const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true });
          const screenshot = path.join(dir, `cockpit-command-palette-${variant}-${name}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
        }
      } catch (error) {
        const dir = path.join(context.artifactRoot, "diagnostics"); await mkdir(dir, { recursive: true });
        const evidence = path.join(dir, `cockpit-command-palette-${variant}-failure.json`);
        await writeFile(evidence, JSON.stringify({ stage, creates: creates.length, sends, error: String(error) }, null, 2));
        diagnostics.push(relativeToRun(context, evidence));
        try {
          if (page && !page.isClosed()) {
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `cockpit-command-palette-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          }
        } catch { /* Preserve the primary assertion and diagnostic. */ }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
    });
  }
}
