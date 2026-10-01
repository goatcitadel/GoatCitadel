import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { clickClassicOwnerNavigation } from "./classic-owner-navigation.mjs";

const profile = ({ hasCharter: _projection, ...record }) => record;
export function assertCitadelMetadataAgreement({ before, request, receipt, owner, existingIds = [] }) {
  assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(profile(owner), profile(receipt), "Directory owner does not confirm the exact mutation receipt.");
  for (const field of ["name", "description", "slug", "kind"]) assert.equal(receipt[field], request[field]);
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)) && Number.isFinite(Date.parse(receipt.updatedAt)));
  if (!before) {
    assert.deepEqual(Object.keys(request).sort(), ["description", "kind", "name", "slug"]);
    assert.equal(receipt.citadelId, request.slug); assert.ok(!existingIds.includes(receipt.citadelId));
    assert.equal(receipt.lifecycleStatus, "active"); assert.equal(receipt.archivedAt, undefined); assert.equal(receipt.defaultWorkspaceId, undefined);
  } else {
    assert.deepEqual(Object.keys(request).sort(), ["description", "expectedRevision", "kind", "name", "slug"]);
    assert.equal(request.expectedRevision, before.revision); assert.notEqual(receipt.revision, before.revision);
    for (const field of ["citadelId", "createdAt", "lifecycleStatus", "archivedAt", "defaultWorkspaceId"]) assert.equal(receipt[field], before[field]);
    assert.ok(Date.parse(receipt.updatedAt) > Date.parse(before.updatedAt));
  }
}
export function assertCitadelLifecycleAgreement({ before, request, receipt, owner, action }) {
  assert.ok(["archive", "restore"].includes(action));
  assert.deepEqual(request, { expectedRevision: before.revision }); assert.match(receipt.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.revision, before.revision); assert.ok(Date.parse(receipt.updatedAt) > Date.parse(before.updatedAt));
  assert.equal(before.lifecycleStatus, action === "archive" ? "active" : "archived");
  assert.equal(receipt.lifecycleStatus, action === "archive" ? "archived" : "active");
  assert.equal(receipt.archivedAt, action === "archive" ? receipt.updatedAt : undefined);
  for (const field of ["citadelId", "name", "description", "slug", "kind", "defaultWorkspaceId", "createdAt"]) assert.equal(receipt[field], before[field]);
  assert.deepEqual(profile(owner), profile(receipt));
}

export function assertCitadelClassicRetention({ before, after, submitted, displayed, owner, receipt }) {
  assert.equal(after.documentNavigations, before.documentNavigations, "The owner link reloaded the document.");
  assert.equal(after.sameDocument, true, "The app-session realm was replaced.");
  assert.equal(after.sameRoot, true, "The application root was replaced.");
  assert.equal(after.shell, "classic");
  assert.equal(after.browserMutations, before.browserMutations, "Navigation or inspection submitted another mutation.");
  assert.deepEqual(after.selection, before.selection, "Classic navigation changed active scope.");
  assert.equal(after.unsaved, true, "The original dirty draft was lost.");
  assert.equal(after.saveDisabled, true, "The unknown write lock was lost.");
  assert.match(after.notice, /^Citadel save outcome is unconfirmed/);
  for (const field of ["name", "slug", "kind", "description"]) assert.equal(displayed[field], submitted[field]);
  assert.deepEqual(profile(owner), profile(receipt), "Navigation changed the canonical Citadel record.");
}

/** The classic shell publishes only this observed presence lease while its owner mounts. */
export function assertCitadelPresenceHeartbeat({ method, pathname, body, status, receipt }, expected) {
  assert.equal(method, "PUT"); assert.equal(pathname, "/api/v1/notifications/presence");
  assert.deepEqual(Object.keys(body).sort(), ["clientId", "focused", "leaseId", "ttlMs", "visible", "workspaceId"]);
  assert.equal(body.workspaceId, expected.workspaceId);
  for (const field of ["clientId", "leaseId"]) {
    assert.ok(typeof expected[field] === "string" && expected[field].length > 0);
    assert.equal(body[field], expected[field]);
  }
  assert.equal(typeof body.focused, "boolean"); assert.equal(typeof body.visible, "boolean");
  assert.equal(body.ttlMs, 90_000); assert.equal(status, 200);
  assert.deepEqual(Object.keys(receipt).sort(), ["clientId", "expiresAt", "focused", "leaseId", "updatedAt", "visible", "workspaceId"]);
  for (const field of ["workspaceId", "clientId", "leaseId", "focused", "visible"]) assert.equal(receipt[field], body[field]);
  assert.ok(Number.isFinite(Date.parse(receipt.updatedAt)));
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.updatedAt), body.ttlMs);
}

/** Real directory writes against new disposable records only; no governance or active-selection changes. */
export async function runCockpitCitadelDirectoryProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Citadel proof requires a disposable runtime.");
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  const list = () => api("/api/v1/citadels?view=all&limit=500");
  const read = async (id) => { const matches = (await list()).items.filter(item => item.citadelId === id); assert.equal(matches.length, 1); return matches[0]; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-citadel-directory.${variant}`, lane: "ux-budgets",
      title: `Native Citadel metadata and reviewed lifecycle ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const screenshots = [], writes = [], presence = [];
      let documentNavigations = 0;
      let stage = "prepare isolated directory", browserContext, page, panel;
      const screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const original = (await list()).items, unique = `${variant}-${Date.now()}`, slug = `ux-citadel-${unique}`;
        const name = `UX Citadel ${unique}`, editedName = `Reviewed Citadel ${unique}`;
        const description = "Disposable native Citadel metadata fixture.", editedDescription = "Reviewed metadata only; no governance changes.";
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations += 1;
          const pathname = new URL(request.url()).pathname;
          if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) {
            const mutation = { method: request.method(), pathname, body: request.postDataJSON() };
            if (mutation.method === "PUT" && pathname === "/api/v1/notifications/presence") {
              const entry = { ...mutation };
              entry.completed = request.response().then(async response => {
                assert.ok(response); entry.status = response.status(); entry.receipt = await response.json();
              }).catch(error => { entry.error = error; });
              presence.push(entry);
            } else writes.push(mutation);
          }
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#workspace-directory"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        panel = page.getByRole("region", { name: "Citadel directory", exact: true });
        await panel.getByRole("button", { name: "New Citadel", exact: true }).waitFor();
        const selection = () => page.evaluate(() => ({ citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"), workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1") }));
        const originalSelection = await selection(); assert.equal(originalSelection.citadel, citadelId);
        const editor = panel.getByRole("region", { name: "Citadel metadata editor", exact: true });
        stage = "draft and retain new Citadel without a write";
        await panel.getByRole("button", { name: "New Citadel", exact: true }).click();
        await editor.getByLabel("New Citadel name", { exact: true }).fill(name);
        await editor.getByLabel("Citadel slug", { exact: true }).fill(slug);
        await editor.getByLabel("Citadel kind", { exact: true }).selectOption("team");
        await editor.getByLabel("Citadel description", { exact: true }).fill(description);
        await editor.getByRole("button", { name: "Close Citadel editor and keep draft", exact: true }).click();
        assert.deepEqual(writes, []); await panel.getByRole("button", { name: "New Citadel", exact: true }).click();
        assert.equal(await editor.getByLabel("New Citadel name", { exact: true }).inputValue(), name); await capture("create-draft");
        stage = "create exact directory record";
        const creation = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/citadels");
        await editor.getByRole("button", { name: "Create Citadel", exact: true }).click();
        const createdReply = await creation; assert.equal(createdReply.status(), 201); const created = await createdReply.json();
        await editor.getByRole("heading", { name: "Edit Citadel metadata", exact: true }).waitFor();
        assertCitadelMetadataAgreement({ request: writes[0].body, receipt: created, owner: await read(created.citadelId), existingIds: original.map(item => item.citadelId) });
        const ownerPath = `/api/v1/citadels/${encodeURIComponent(created.citadelId)}`;
        assert.deepEqual(writes[0], { method: "POST", pathname: "/api/v1/citadels", body: { name, description, slug, kind: "team" } });
        stage = "withhold stale edit and explicitly rebase the retained draft";
        await editor.getByLabel("Citadel name", { exact: true }).fill(editedName);
        await editor.getByLabel("Citadel description", { exact: true }).fill(editedDescription);
        const peer = await api(ownerPath, { method: "PATCH", body: { expectedRevision: created.revision, description: "Independent owner update for stale review." } });
        await editor.getByRole("button", { name: "Save Citadel metadata", exact: true }).click();
        await editor.getByRole("button", { name: "Apply draft to current Citadel", exact: true }).waitFor();
        assert.equal(writes.length, 1); assert.equal(await editor.getByLabel("Citadel name", { exact: true }).inputValue(), editedName);
        assert.deepEqual(profile(await read(created.citadelId)), profile(peer)); await capture("stale-edit");
        await editor.getByRole("button", { name: "Apply draft to current Citadel", exact: true }).click();
        const edit = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === ownerPath);
        await editor.getByRole("button", { name: "Save Citadel metadata", exact: true }).click();
        const editedReply = await edit; assert.equal(editedReply.status(), 200); const edited = await editedReply.json();
        await panel.getByText(`Citadel ${editedName} updated.`, { exact: true }).waitFor();
        assertCitadelMetadataAgreement({ before: peer, request: writes[1].body, receipt: edited, owner: await read(created.citadelId) });
        await editor.getByRole("button", { name: "Close Citadel editor", exact: true }).click();
        await panel.getByRole("searchbox", { name: "Search Citadels", exact: true }).fill(slug);
        stage = "cancel archive review without mutation";
        const review = async (action, record) => {
          const verb = action === "archive" ? "Archive" : "Restore";
          await panel.getByRole("button", { name: `${verb} Citadel ${record.name}`, exact: true }).click();
          const dialog = page.getByRole("dialog", { name: `${verb} Citadel?`, exact: true }); await dialog.waitFor();
          await dialog.getByText(record.citadelId, { exact: true }).waitFor(); await dialog.getByText(record.revision, { exact: true }).waitFor();
          for (const control of [dialog, dialog.getByRole("button", { name: `Confirm ${action} Citadel`, exact: true })]) {
            const box = await control.boundingBox(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
          }
          return dialog;
        };
        const cancelled = await review("archive", edited); await capture("archive-review", cancelled);
        await cancelled.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(writes.length, 2);
        assert.deepEqual(profile(await read(created.citadelId)), profile(edited));
        let saved = edited;
        for (const action of ["archive", "restore"]) {
          stage = `confirm exact Citadel ${action}`; const dialog = await review(action, saved);
          const response = page.waitForResponse(reply => reply.request().method() === "POST" && new URL(reply.url()).pathname === `${ownerPath}/${action}`);
          await dialog.getByRole("button", { name: `Confirm ${action} Citadel`, exact: true }).click();
          const reply = await response; assert.equal(reply.status(), 200); const receipt = await reply.json();
          await dialog.waitFor({ state: "hidden" }); await panel.getByText(`${saved.name} ${action === "archive" ? "archived" : "restored"}.`, { exact: true }).first().waitFor();
          const write = writes.at(-1); assert.equal(write.pathname, `${ownerPath}/${action}`); assert.equal(write.method, "POST");
          assertCitadelLifecycleAgreement({ before: saved, request: write.body, receipt, owner: await read(saved.citadelId), action }); saved = receipt;
        }
        assert.equal(writes.length, 4); await capture("restored");
        stage = "retain committed edit response loss across remount";
        await panel.getByRole("button", { name: `Edit Citadel ${saved.name}`, exact: true }).click();
        const unknownName = `${editedName} unknown`; await editor.getByLabel("Citadel name", { exact: true }).fill(unknownName);
        let lostReceipt;
        const lose = async route => { if (route.request().method() !== "PATCH") return route.continue(); const reply = await route.fetch(); assert.equal(reply.status(), 200); lostReceipt = await reply.json(); await route.abort("failed"); };
        await page.route(`**${ownerPath}`, lose);
        await editor.getByRole("button", { name: "Save Citadel metadata", exact: true }).click();
        await panel.getByText(/^Citadel save outcome is unconfirmed/).first().waitFor();
        assertCitadelMetadataAgreement({ before: saved, request: writes[4].body, receipt: lostReceipt, owner: await read(saved.citadelId) });
        await page.unroute(`**${ownerPath}`, lose);
        await editor.getByRole("button", { name: "Close Citadel editor and keep draft", exact: true }).click();
        const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
        await nav.getByRole("link", { name: "General", exact: true }).click(); await nav.getByRole("link", { name: "Citadel", exact: true }).click();
        await page.getByRole("tab", { name: "Workspaces", exact: true }).click();
        // The unknown outcome deliberately keeps its lock; remount can reuse a fresh query-cache snapshot.
        // Follow the operator's explicit inspection action instead of assuming an automatic owner refresh.
        await panel.getByRole("button", { name: "Refresh Citadels", exact: true }).click();
        await panel.getByRole("button", { name: `Edit Citadel ${unknownName}`, exact: true }).waitFor();
        assert.equal(await panel.getByRole("button", { name: `Edit Citadel ${unknownName}`, exact: true }).isDisabled(), true);
        assert.equal(await panel.getByRole("button", { name: `Archive Citadel ${unknownName}`, exact: true }).isDisabled(), true);
        assert.equal(writes.length, 5); assert.deepEqual(await selection(), originalSelection);
        await capture("unknown-locked");
        stage = "retain unknown write and dirty draft through the actual classic owner link";
        const transitionBefore = { documentNavigations, browserMutations: writes.length, selection: await selection() };
        const sentinel = `citadel-owner-${unique}`;
        await page.evaluate(value => { window.__citadelProofDocument = value; window.__citadelProofRoot = document.getElementById("root"); }, sentinel);
        await panel.getByRole("link", { name: "Open Citadel governance", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        if (await leave.isVisible()) await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await page.waitForURL(url => url.pathname === "/library/citadel-overview" && url.searchParams.get("shell") === "classic");
        await page.waitForFunction(() => document.documentElement.dataset.shell === "classic");
        await clickClassicOwnerNavigation(page, page.getByRole("navigation", { name: "Primary mission areas", exact: true }).getByRole("button", { name: "Settings", exact: true }));
        await clickClassicOwnerNavigation(page, page.getByRole("button", { name: /^Citadel: / }));
        await page.getByRole("navigation", { name: "Citadel sections", exact: true }).getByRole("button", { name: "Workspaces", exact: true }).click();
        await page.getByRole("tab", { name: "Citadel manager", exact: true }).click();
        const row = page.locator("button.mc-next-settings-selectable").filter({ has: page.getByText(unknownName, { exact: true }) });
        await row.waitFor(); const unsaved = /Unsaved/.test(await row.innerText()); assert.equal(unsaved, true); await row.click();
        await page.getByRole("button", { name: "Edit Citadel · Unsaved", exact: true }).click();
        const classicEditor = page.getByRole("region", { name: "Edit Citadel", exact: true });
        await classicEditor.waitFor();
        const displayed = {};
        for (const [field, label] of [["name", "Selected name"], ["slug", "Selected slug"], ["kind", "Selected kind"], ["description", "Selected description"]])
          displayed[field] = await classicEditor.getByLabel(new RegExp(`^${label}(?:\\s|$)`)).inputValue();
        const after = await page.evaluate(value => ({ sameDocument: window.__citadelProofDocument === value,
          sameRoot: window.__citadelProofRoot === document.getElementById("root"), shell: document.documentElement.dataset.shell }), sentinel);
        const notice = await page.getByText(/^Citadel save outcome is unconfirmed/).first().innerText();
        assertCitadelClassicRetention({ before: transitionBefore, after: { ...after, documentNavigations, browserMutations: writes.length,
          selection: await selection(), unsaved, saveDisabled: await classicEditor.getByRole("button", { name: "Save Citadel", exact: true }).isDisabled(), notice },
          submitted: writes[4].body, displayed, owner: await read(saved.citadelId), receipt: lostReceipt });
        const final = (await list()).items;
        for (const previous of original) assert.deepEqual(final.find(item => item.citadelId === previous.citadelId), previous);
        await capture("classic-unknown-locked", classicEditor);
        const expectedPresence = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
          clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
        const observedPresence = presence.slice();
        await Promise.all(observedPresence.map(entry => entry.completed));
        for (const entry of observedPresence) { if (entry.error) throw entry.error; assertCitadelPresenceHeartbeat(entry, expectedPresence); }
        assert.equal(writes.length, 5);
        return { status: "passed", metrics: { browserMutations: 5, fixturePeerMutations: 1, staleMetadataWrites: 0, cancelLifecycleWrites: 0,
          systemPresenceHeartbeats: observedPresence.length, systemPresenceOwner: "PUT /api/v1/notifications/presence",
          systemPresenceScope: expectedPresence.workspaceId, systemPresenceReceiptsConfirmed: true,
          systemPresenceEvidence: observedPresence.map(({ method, pathname, body, status, receipt }) => ({ method, pathname, body, status, receipt })),
          exactOwnerReceipts: true, archiveRestoreConfirmed: true, activeSelectionUnchanged: true, preexistingCitadelsUnchanged: true,
          retainedUnknownAcrossRemount: true, sameDocumentClassicOwner: true, retainedDraftAndUnknownAcrossShells: true,
          blockingAxe: 0, limitation: "Disposable directory metadata only. Governance is inspected through the actual owner link; no charter, access policy, membership or runtime activation changes." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-directory-${variant}-failure.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file)); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage, browserMutations: writes.length,
          mutationPaths: writes.map(({ method, pathname }) => `${method} ${pathname}`) }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, target = panel) {
        await mkdir(screenshotDir, { recursive: true }); await target.scrollIntoViewIfNeeded(); await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page); assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-directory-${variant}-${name}.png`); await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
