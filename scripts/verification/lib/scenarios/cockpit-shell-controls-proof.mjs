import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fillNavigationGrantDraft, reviewNavigationDraft, assertNavigationDraftOwner } from "./cockpit-navigation-draft-proof.mjs";
import { assertProjectReadRequests } from "./cockpit-chat-project-proof.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";

export function assertShellGeometry({ variant, viewportWidth, railWidth, inspectorWidth, mainBefore, mainDuring, overflow }) {
  assert.ok(overflow <= 1, "Shell overflowed its viewport.");
  if (variant === "mobile") { assert.equal(railWidth, 0); assert.ok(inspectorWidth <= viewportWidth); return; }
  assert.ok(Math.abs(railWidth - 56) <= 1, "Collapsed navigation is not the required 56px rail.");
  assert.ok(inspectorWidth >= 360 && inspectorWidth <= 480, "Inspector width escaped its reviewed bounds.");
  if (variant === "tablet") assert.ok(Math.abs(mainBefore - mainDuring) <= 1, "Tablet inspector must overlay the content.");
  else assert.ok(Math.abs(mainBefore - mainDuring - inspectorWidth) <= 1, "Desktop inspector must share the content row.");
}

/** Only fixture creation writes: two task-owned workspaces and one empty Chat, before observation. No sends or approvals. */
export async function runCockpitShellControlsProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)), "Shell proof requires a disposable runtime.");
  const read = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  const widths = [...viewports.filter(({ variant }) => variant !== "tablet"), { variant: "tablet", viewport: { width: 800, height: 900 } }];
  for (const { variant, viewport } of widths) {
    await runScenario(context, { id: `ux-budgets.cockpit-shell-controls.${variant}`, lane: "ux-budgets",
      title: `Guarded operating scope, rail and inspector ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const token = randomUUID().slice(0, 8), screenshots = [], diagnostics = [], writes = [], observers = [], presence = [], routingReads = [];
      const source = await read("/api/v1/workspaces", { method: "POST", body: { name: `Shell origin ${token}`, citadelId } });
      const target = await read("/api/v1/workspaces", { method: "POST", body: { name: `Shell destination ${token}`, citadelId: source.citadelId } });
      assert.ok(source.citadelId && source.workspaceId && target.workspaceId !== source.workspaceId);
      assert.equal(target.citadelId, source.citadelId);
      const session = await read("/api/v1/chat/sessions", { method: "POST", body: { workspaceId: source.workspaceId, title: `Shell selection ${token}` } });
      assert.equal(session.workspaceId, source.workspaceId); assert.ok(session.sessionId);
      const before = await read("/api/v1/tools/grants?limit=400");
      const prefs = await read(`/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}/prefs`);
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce" });
      let page, stage = "boot";
      const evidence = { workspaceId: source.workspaceId, targetWorkspaceId: target.workspaceId, citadelId: source.citadelId, sessionId: session.sessionId };
      try {
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, source.workspaceId, source.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (recordCockpitObserverRequest(request, observers)) return;
          if (request.method() === "POST" && pathname === `/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}/route-preflight`) {
            routingReads.push({ method: request.method(), path: pathname, body: request.postDataJSON() }); return;
          }
          if (pathname === "/api/v1/notifications/presence") {
            const entry = { method: request.method(), pathname, body: request.postDataJSON() };
            entry.completed = request.response().then(async response => { assert.ok(response); entry.status = response.status(); entry.receipt = await response.json(); }).catch(error => { entry.error = error; });
            presence.push(entry); return;
          }
          writes.push({ method: request.method(), path: pathname });
        });
        await page.route("**/api/v1/**", route => {
          const request = route.request(), pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
            && !["/api/v1/auth/sse-token", "/api/v1/notifications/presence",
              "/api/v1/chat/sessions/" + encodeURIComponent(session.sessionId) + "/route-preflight"].includes(pathname)) return route.abort("failed");
          return route.continue();
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(session.sessionId)}&shell=cockpit`), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const composer = page.getByRole("textbox", { name: "Message", exact: true }); await composer.waitFor();
        const origin = await page.evaluate(() => performance.timeOrigin), sourceChatUrl = page.url();
        await page.addScriptTag({ path: axeSourcePath });
        const capture = async label => {
          await page.evaluate(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); await Promise.all(document.getAnimations().filter(item => item.effect?.getTiming().iterations !== Infinity).map(item => item.finished.catch(() => undefined))); });
          const result = await auditPageAccessibility(page), blocking = result.violations.filter(item => ["serious", "critical"].includes(item.impact));
          assert.equal(blocking.length, 0, JSON.stringify(blocking.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), "Shell horizontal overflow");
          const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true });
          const file = path.join(dir, `ux-budgets-cockpit-shell-controls-${variant}-${label}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
        };
        const scope = () => page.evaluate(() => ({ citadelId: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"), workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") }));
        const showScope = async () => {
          if (variant === "mobile") { await page.getByRole("button", { name: "More areas and settings", exact: true }).click(); await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Change Citadel and workspace", exact: true }).click(); }
          else await page.getByRole("button", { name: "Change Citadel and workspace", exact: true }).click();
          const picker = page.getByRole("dialog", { name: "Change operating scope", exact: true }); await picker.waitFor();
          assert.equal(await picker.getByRole("combobox", { name: "Scope Citadel", exact: true }).inputValue(), source.citadelId);
          return picker;
        };
        const openScope = async workspaceId => {
          const picker = await showScope();
          await picker.getByRole("combobox", { name: "Scope Workspace", exact: true }).selectOption(workspaceId);
          await picker.getByRole("button", { name: "Switch scope", exact: true }).click();
          await picker.waitFor({ state: "hidden" });
          const consent = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
          if (await consent.isVisible()) {
            await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"][data-state="open"]')].some(dialog => dialog.textContent.includes("Unsaved changes") && dialog.contains(document.activeElement)));
          }
        };
        const settings = async () => {
          if (variant === "mobile") { await page.getByRole("button", { name: "More areas and settings", exact: true }).click(); await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Settings", exact: true }).click(); }
          else { await page.getByRole("button", { name: "Settings and account", exact: true }).click(); await page.getByRole("menuitem", { name: "Settings", exact: true }).click(); }
          await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        };
        stage = "rail keyboard and current inspector";
        const history = await read(`/api/v1/durable/runs?${new URLSearchParams({ workspaceId: source.workspaceId, limit: "100" })}`);
        assert.deepEqual(history.items, []); assert.equal(history.nextCursor, undefined);
        if (variant !== "mobile") await page.waitForFunction(() => document.querySelector('[data-work-running]')?.getAttribute("data-work-running") === "none");
        const sidebar = page.getByRole("complementary", { name: "Cockpit sidebar", exact: true });
        if (variant !== "mobile") {
          assert.equal(await sidebar.getAttribute("data-collapsed"), variant === "tablet" ? "true" : "false");
          await composer.focus(); await page.keyboard.press("Control+b");
          assert.equal(await sidebar.getAttribute("data-collapsed"), variant === "tablet" ? "true" : "false");
          await composer.blur();
          await page.keyboard.press("Control+b");
          assert.equal(await sidebar.getAttribute("data-collapsed"), variant === "tablet" ? "false" : "true");
          if (variant === "tablet") await page.keyboard.press("Control+b");
          assert.equal(await sidebar.getAttribute("data-collapsed"), "true");
          assert.equal(page.url(), sourceChatUrl);
        } else await composer.blur();
        await page.evaluate(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); });
        const mainBefore = await page.locator("#main-content").evaluate(element => element.getBoundingClientRect().width);
        evidence.mainBefore = mainBefore;
        await page.keyboard.press("Control+i");
        const inspector = page.getByLabel("Inspector: Conversation", { exact: true }); await inspector.waitFor();
        if (variant !== "mobile") {
          const handle = page.getByRole("separator", { name: "Resize inspector", exact: true });
          await handle.focus(); await page.keyboard.press("Home"); assert.equal(await handle.getAttribute("aria-valuenow"), "360");
          await page.keyboard.press("End"); assert.equal(await handle.getAttribute("aria-valuenow"), "480");
          await page.waitForFunction(() => Math.abs(document.querySelector('[aria-label="Inspector: Conversation"]').getBoundingClientRect().width - 480) <= 1);
          const point = await handle.evaluate(element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; }); assert.ok(point);
          evidence.pointerStart = point;
          assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), { x: point.x + point.width / 2, y: point.y + 70 }), "Resize inspector");
          await page.mouse.move(point.x + point.width / 2, point.y + 70); await page.mouse.down();
          await page.mouse.move(point.x + 200, point.y + 70, { steps: 4 }); await page.mouse.up();
          await page.waitForFunction(() => document.querySelector('[aria-label="Resize inspector"]')?.getAttribute("aria-valuenow") === "360");
          assert.equal(await handle.getAttribute("aria-valuenow"), "360");
        }
        if (variant !== "mobile") await page.waitForFunction(() => document.querySelector('[aria-label="Inspector: Conversation"]').getBoundingClientRect().width === 360);
        // Read all geometry in one layout observation after the actual resize.
        evidence.geometry = await page.evaluate(({ variant, viewportWidth, mainBefore }) => ({ variant, viewportWidth, mainBefore,
          railWidth: variant === "mobile" ? 0 : document.querySelector('[aria-label="Cockpit sidebar"]').getBoundingClientRect().width,
          inspectorWidth: document.querySelector('[aria-label="Inspector: Conversation"]').getBoundingClientRect().width,
          mainDuring: document.querySelector("#main-content").getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }), { variant, viewportWidth: viewport.width, mainBefore });
        assertShellGeometry(evidence.geometry);
        await capture("inspector"); await page.keyboard.press("Control+i"); await inspector.waitFor({ state: "hidden" });
        stage = "scope Cancel Keep and origin retention";
        await settings();
        const picker = await showScope();
        const pickerBounds = await picker.boundingBox(); assert.ok(pickerBounds && pickerBounds.x >= 0 && pickerBounds.x + pickerBounds.width <= viewport.width + 1);
        await capture("scope-picker");
        await picker.getByRole("button", { name: "Close dialog", exact: true }).click(); await picker.waitFor({ state: "hidden" });
        await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label,
          variant === "mobile" ? "More areas and settings" : "Change Citadel and workspace");
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
        await page.getByRole("tab", { name: "Tools", exact: true }).click();
        const { field, value } = await fillNavigationGrantDraft(page), sourceSettingsUrl = page.url();
        await reviewNavigationDraft(page, () => openScope(target.workspaceId), "Cancel");
        assert.equal(page.url(), sourceSettingsUrl); assert.equal(await field.inputValue(), value);
        await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label,
          variant === "mobile" ? "More areas and settings" : "Change Citadel and workspace");
        assert.deepEqual(await scope(), { citadelId: source.citadelId, workspaceId: source.workspaceId });
        assert.deepEqual(await read("/api/v1/tools/grants?limit=400"), before); assert.deepEqual(writes, []);
        await reviewNavigationDraft(page, () => openScope(target.workspaceId), "Keep draft and close");
        await page.waitForFunction(id => window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") === id, target.workspaceId);
        await page.waitForURL(url => url.pathname === "/settings" && url.search === "?shell=cockpit" && !url.hash);
        assert.deepEqual(await scope(), { citadelId: source.citadelId, workspaceId: target.workspaceId });
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await page.keyboard.press("Control+i"); assert.equal(await page.getByLabel("Inspector: Conversation", { exact: true }).count(), 0);
        await capture("scope-changed");
        await openScope(source.workspaceId);
        await page.waitForFunction(id => window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") === id, source.workspaceId);
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
        await page.getByRole("tab", { name: "Tools", exact: true }).click(); await field.waitFor();
        assertNavigationDraftOwner({ before, after: await read("/api/v1/tools/grants?limit=400"), writes, origin,
          current: await page.evaluate(() => performance.timeOrigin), retained: await field.inputValue(), expected: value });
        assert.deepEqual(await scope(), { citadelId: source.citadelId, workspaceId: source.workspaceId });
        await capture("origin-restored");
        await reviewNavigationDraft(page, () => page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click(), "Discard changes");
        await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
        await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
        await page.getByRole("tab", { name: "Tools", exact: true }).click(); await field.waitFor();
        assert.equal(await field.inputValue(), "", "Discard did not restore the empty tool pattern.");
        assert.equal(await page.getByRole("region", { name: "Tool catalog and grants", exact: true }).getByRole("combobox", { name: "Decision", exact: true }).inputValue(), "allow");
        assert.deepEqual(await read("/api/v1/tools/grants?limit=400"), before); assert.deepEqual(writes, []);
        assertProjectReadRequests(routingReads, { [session.sessionId]: prefs });
        await assertCockpitObserverRequests(observers);
        const presenceIdentity = await page.evaluate(() => ({ clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
        await Promise.all(presence.map(entry => entry.completed));
        for (const entry of presence) {
          if (entry.error) throw entry.error;
          assert.ok([source.workspaceId, target.workspaceId].includes(entry.body.workspaceId));
          assertCitadelPresenceHeartbeat(entry, { ...presenceIdentity, workspaceId: entry.body.workspaceId });
        }
        return { status: "passed", metrics: { emptyCanonicalWorkIndicator: variant !== "mobile", modalFocusRestored: true, consentCancelFocusRestored: true, currentSelectionShortcut: true, staleSelectionWithheld: true, scopedCancelKeep: true,
          originDraftRetained: true, explicitDraftDiscard: true, sameDocument: true, browserMutations: 0, blockingAxe: 0, overflow: 0,
          tabletOverlay: variant === "tablet", boundedKeyboardPointerResize: variant !== "mobile", fixtureOnlyEmptySession: true }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        const dir = path.join(context.artifactRoot, "diagnostics"); await mkdir(dir, { recursive: true });
        const file = path.join(dir, `cockpit-shell-controls-${variant}-failure.json`);
        await writeFile(file, JSON.stringify({ stage, evidence, writes, error: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2)); diagnostics.push(relativeToRun(context, file));
        if (page && !page.isClosed()) try { const dir = path.join(context.artifactRoot, "screenshots"); await mkdir(dir, { recursive: true }); const file = path.join(dir, `cockpit-shell-controls-${variant}-failure.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); } catch { /* Preserve primary failure. */ }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext.close(); }
    });
  }
}
