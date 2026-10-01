import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertWorkspaceMetadataSaved({ before, after, request, response, name, description, citadelId }) {
  assert.equal(before.citadelId, citadelId, "Reviewed workspace belongs to another Citadel.");
  assert.equal(after.citadelId, citadelId, "Saved workspace moved to another Citadel.");
  assert.equal(after.workspaceId, before.workspaceId, "Saved workspace identity changed.");
  assert.equal(after.revision, before.revision + 1, "Workspace owner revision did not advance exactly once.");
  assert.equal(after.name, name);
  assert.equal(after.description, description);
  assert.equal(after.slug, before.slug, "Metadata editing changed the workspace slug.");
  assert.equal(after.lifecycleStatus, before.lifecycleStatus);
  assert.equal(after.archivedAt, before.archivedAt);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.workspacePrefs, before.workspacePrefs, "Metadata editing changed workspace governance preferences.");
  assert.deepEqual(request, { expectedRevision: before.revision, name, description, slug: before.slug });
  assert.deepEqual(response, after, "Mutation receipt disagrees with a fresh canonical owner read.");
}

export function assertWorkspaceLifecycleSaved({ before, after, request, response, action }) {
  assert.ok(["archive", "restore"].includes(action));
  assert.equal(before.lifecycleStatus, action === "archive" ? "active" : "archived");
  assert.equal(after.lifecycleStatus, action === "archive" ? "archived" : "active");
  assert.equal(after.revision, before.revision + 1, "Lifecycle owner revision did not advance exactly once.");
  assert.ok(Number.isFinite(Date.parse(after.updatedAt)), "Lifecycle owner omitted its saved timestamp.");
  assert.equal(after.archivedAt, action === "archive" ? after.updatedAt : undefined);
  for (const field of ["workspaceId", "citadelId", "name", "description", "slug", "createdAt", "workspacePrefs"]) {
    assert.deepEqual(after[field], before[field], `Lifecycle control changed ${field}.`);
  }
  assert.deepEqual(request, { expectedRevision: before.revision });
  assert.deepEqual(response, after, "Lifecycle receipt disagrees with a fresh canonical owner read.");
}

/** Exercises metadata and lifecycle only on one unique disposable workspace per viewport. */
export async function runCockpitWorkspacesProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Workspace proof requires an isolated verification runtime.");
  assert.ok(citadelId, "Workspace proof requires an explicit Citadel.");
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "workspace proof owner read"); return response.body;
  };
  const readDirectory = () => api(`/api/v1/workspaces?view=all&limit=500&citadelId=${encodeURIComponent(citadelId)}`);
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-workspaces.${variant}`, lane: "ux-budgets",
      title: `Cockpit scoped workspace metadata and reviewed lifecycle ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const before = await readDirectory();
      assert.ok(before.items.every((item) => item.citadelId === citadelId));
      const unique = `${variant}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const name = `UX workspace ${unique}`;
      const description = "Disposable workspace created by the native cockpit browser proof.";
      const updatedName = `Reviewed workspace ${unique}`;
      const updatedDescription = "Display metadata edited through the existing Gateway workspace owner.";
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      const screenshots = [];
      const writes = [];
      let documentNavigations = 0;
      let page;
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations += 1;
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) {
            writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/general?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        const initialDocumentNavigations = documentNavigations;
        await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("workspaces");
        await page.locator('a[href="/settings/citadel#workspace-directory"]').click();
        const panel = page.getByRole("region", { name: "Workspace directory", exact: true });
        await panel.getByRole("button", { name: "New workspace", exact: true }).waitFor();
        assert.equal(documentNavigations, initialDocumentNavigations, "Native Settings search navigation reloaded the document and lost retained UI state.");
        const originalSelection = await page.evaluate(() => ({
          workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
          citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"),
        }));
        assert.equal(originalSelection.citadel, citadelId, "The UI did not retain the selected verification Citadel.");
        await panel.getByRole("button", { name: "New workspace", exact: true }).click();
        await panel.getByRole("textbox", { name: "New workspace name", exact: true }).fill(name);
        await panel.getByRole("textbox", { name: "Workspace description", exact: true }).fill(description);
        assert.deepEqual(writes, [], "Opening and drafting a workspace mutated the owner.");
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        await page.addScriptTag({ path: axeSourcePath });
        const audit = async (stage, target = panel) => {
          await target.scrollIntoViewIfNeeded();
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.equal(blocking.length, 0, `Workspace ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`);
          assert.ok(overflow <= 1, `Workspace ${stage} overflow ${overflow}px`);
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-workspaces-${variant}-${stage}.png`);
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          return overflow;
        };
        await audit("draft");
        const createdResponse = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/v1/workspaces");
        await panel.getByRole("button", { name: "Create workspace", exact: true }).click();
        const createdReply = await createdResponse;
        assert.equal(createdReply.status(), 201);
        const created = await createdReply.json();
        assert.equal(created.citadelId, citadelId);
        assert.equal(created.name, name);
        assert.equal(created.description, description);
        assert.equal(created.lifecycleStatus, "active");
        assert.ok(!before.items.some((item) => item.workspaceId === created.workspaceId), "Create reused an existing workspace ID.");
        assert.deepEqual(writes, [{ method: "POST", pathname: "/api/v1/workspaces", body: { citadelId, name, description } }]);
        const createdOwner = await api(`/api/v1/workspaces/${encodeURIComponent(created.workspaceId)}`);
        assert.deepEqual(createdOwner, created, "Creation receipt disagrees with canonical owner readback.");
        await panel.getByRole("heading", { name: "Edit workspace metadata", exact: true }).waitFor();
        await panel.getByRole("textbox", { name: "Workspace name", exact: true }).fill(updatedName);
        await panel.getByRole("textbox", { name: "Workspace description", exact: true }).fill(updatedDescription);
        const savedResponse = page.waitForResponse((response) => response.request().method() === "PATCH"
          && new URL(response.url()).pathname === `/api/v1/workspaces/${encodeURIComponent(created.workspaceId)}`);
        await panel.getByRole("button", { name: "Save workspace metadata", exact: true }).click();
        const savedReply = await savedResponse;
        assert.equal(savedReply.status(), 200);
        await panel.getByText(`Workspace ${updatedName} updated.`, { exact: true }).waitFor();
        const saved = await api(`/api/v1/workspaces/${encodeURIComponent(created.workspaceId)}`);
        assert.equal(writes.length, 2, "Workspace controls issued an unrelated or duplicate mutation.");
        assert.equal(writes[1].method, "PATCH");
        assert.equal(writes[1].pathname, `/api/v1/workspaces/${created.workspaceId}`);
        assertWorkspaceMetadataSaved({ before: createdOwner, after: saved, request: writes[1].body,
          response: await savedReply.json(), name: updatedName, description: updatedDescription, citadelId });
        await audit("saved");
        await panel.getByRole("button", { name: "Close editor", exact: true }).click();
        const ownerPath = `/api/v1/workspaces/${encodeURIComponent(created.workspaceId)}`;
        const review = async (action, record) => {
          await panel.getByRole("button", { name: `${action === "archive" ? "Archive" : "Restore"} workspace ${updatedName}`, exact: true }).click();
          const dialog = page.getByRole("dialog", { name: `${action === "archive" ? "Archive" : "Restore"} workspace?`, exact: true });
          await dialog.waitFor({ state: "visible" });
          for (const value of [record.workspaceId, String(record.revision), citadelId]) {
            assert.equal(await dialog.locator("dd").filter({ hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).count(), 1,
              "Lifecycle review omitted exact owner evidence.");
          }
          for (const control of [dialog, dialog.getByRole("button", { name: `Confirm ${action} workspace`, exact: true }), dialog.getByRole("button", { name: "Cancel", exact: true })]) {
            const box = await control.boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1
              && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
            "Workspace lifecycle dialog or action extends outside the viewport.");
          }
          return dialog;
        };
        const cancelled = await review("archive", saved);
        await audit("archive-review", cancelled);
        await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
        await cancelled.waitFor({ state: "hidden" });
        assert.equal(writes.length, 2, "Cancel dispatched a lifecycle write.");
        assert.deepEqual(await api(ownerPath), saved, "Cancel changed the saved workspace.");

        // A real independent owner update makes the currently displayed review stale.
        // It also supplies nonempty preferences whose preservation is checked below.
        const stale = await review("archive", saved);
        const peer = await api(ownerPath, { method: "PATCH", body: { expectedRevision: saved.revision,
          description: "Independent owner update for the stale lifecycle review.",
          workspacePrefs: { ...saved.workspacePrefs, hooks: { ...saved.workspacePrefs?.hooks, allowMutatingHooks: false } } } });
        assert.equal(peer.revision, saved.revision + 1);
        assert.equal(peer.workspaceId, saved.workspaceId);
        assert.equal(peer.citadelId, citadelId);
        assert.deepEqual(await api(ownerPath), peer);
        await stale.getByRole("button", { name: "Confirm archive workspace", exact: true }).click();
        await stale.waitFor({ state: "hidden" });
        await panel.getByText("The reviewed record changed. Refresh and review its current revision before trying again.", { exact: true }).first().waitFor();
        assert.equal(writes.length, 2, "A stale review dispatched a lifecycle write.");
        assert.deepEqual(await api(ownerPath), peer, "Stale confirmation changed the owner.");
        const refresh = page.waitForResponse((response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === "/api/v1/workspaces"
          && new URL(response.url()).searchParams.get("citadelId") === citadelId);
        await panel.getByRole("button", { name: "Refresh workspaces", exact: true }).click();
        assert.equal((await refresh).status(), 200);
        let lifecycleOwner = peer;
        for (const action of ["archive", "restore"]) {
          const dialog = await review(action, lifecycleOwner);
          const nextResponse = page.waitForResponse((response) => response.request().method() === "POST"
            && new URL(response.url()).pathname === `${ownerPath}/${action}`);
          await dialog.getByRole("button", { name: `Confirm ${action} workspace`, exact: true }).click();
          const reply = await nextResponse;
          assert.equal(reply.status(), 200);
          await dialog.waitFor({ state: "hidden" });
          await panel.getByText(`${updatedName} ${action === "archive" ? "archived" : "restored"}.`, { exact: true }).first().waitFor();
          const current = await api(ownerPath), write = writes.at(-1);
          assert.equal(write.method, "POST"); assert.equal(write.pathname, `${ownerPath}/${action}`);
          assertWorkspaceLifecycleSaved({ before: lifecycleOwner, after: current, request: write.body, response: await reply.json(), action });
          lifecycleOwner = current;
        }
        assert.equal(writes.length, 4, "Workspace controls issued an unrelated or duplicate mutation.");
        const after = await readDirectory();
        for (const previous of before.items) {
          assert.deepEqual(after.items.find((item) => item.workspaceId === previous.workspaceId), previous,
            "Workspace proof changed a pre-existing workspace.");
        }
        const finalSelection = await page.evaluate(() => ({
          workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
          citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"),
        }));
        assert.deepEqual(finalSelection, originalSelection, "Workspace controls changed the active workspace or Citadel.");
        assert.equal(documentNavigations, initialDocumentNavigations, "Workspace controls reloaded the document.");
        const overflow = await audit("restored");
        return { status: "passed", metrics: { browserMutations: 4, fixturePeerMutations: 1, createdWorkspaceId: created.workspaceId,
          exactCitadelConfirmed: true, workspaceRevisionAdvanced: true, slugPreserved: true, nativeSearchDocumentNavigations: 0,
          governancePreferencesPreserved: true, existingWorkspacesUnchanged: true, activeSelectionUnchanged: true,
          archiveAndRestoreConfirmed: true, cancelBrowserMutations: 0, staleReviewBrowserMutations: 0, lifecycleDialogWithinViewport: true,
          blockingAxe: 0, overflow }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          try {
            const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-workspaces-${variant}-failure.png`);
            await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Preserve original proof failure. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error), artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
