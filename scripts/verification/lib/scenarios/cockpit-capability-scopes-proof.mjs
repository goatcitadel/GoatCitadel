import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

const sorted = assignments => [...assignments].sort((a, b) => a.resourceRef < b.resourceRef ? -1 : a.resourceRef > b.resourceRef ? 1 : 0);
const pathFor = (kind, id) => `/api/v1/${kind === "citadel" ? "citadels" : "workspaces"}/${encodeURIComponent(id)}/capabilities`;
const selectionFor = view => {
  const saved = new Map(view.selectionReview.assignments.map(item => [item.resourceRef, item.enabled]));
  return Object.fromEntries([...view.items.map(item => [item.resourceRef, saved.get(item.resourceRef) ?? (view.mode === "inherit" ? item.enabled : false)]), ...saved]);
};
const changedSelection = (before, ref, enabled) => sorted(Object.entries({ ...selectionFor(before), [ref]: enabled }).map(([resourceRef, value]) => ({ resourceRef, enabled: value })));

export function assertCapabilityScopeAgreement({ before, request, receipt, owner, method, expectedAssignments }) {
  assert.ok(["PATCH", "DELETE"].includes(method));
  assert.equal(before.selectionReview.version, "capability_scope_selection.v1");
  assert.match(before.selectionReview.revision, /^[a-f0-9]{64}$/u);
  for (const key of ["scopeKind", "scopeId", "resourceType"]) assert.equal(before.selectionReview[key], before[key]);
  assert.equal(before.selectionReview.scopeLifecycleStatus, "active");
  assert.equal(before.selectionReview.citadelLifecycleStatus, "active");
  assert.deepEqual(expectedAssignments, sorted(expectedAssignments));
  assert.equal(new Set(expectedAssignments.map(item => item.resourceRef)).size, expectedAssignments.length);
  for (const item of expectedAssignments) {
    assert.deepEqual(Object.keys(item).sort(), ["enabled", "resourceRef"]);
    assert.ok(item.resourceRef.trim()); assert.equal(typeof item.enabled, "boolean");
  }
  const expected = { resourceType: before.resourceType, expectedRevision: before.selectionReview.revision };
  if (method === "PATCH") expected.assignments = expectedAssignments;
  else assert.deepEqual(expectedAssignments, []);
  assert.deepEqual(request, expected);
  assert.equal(receipt.version, "capability_scope_receipt.v1");
  assert.equal(receipt.previousRevision, before.selectionReview.revision);
  assert.match(receipt.selectionReview.revision, /^[a-f0-9]{64}$/u);
  assert.notEqual(receipt.selectionReview.revision, before.selectionReview.revision);
  assert.deepEqual(receipt.selectionReview, { ...before.selectionReview, revision: receipt.selectionReview.revision, assignments: expectedAssignments });
  for (const key of ["scopeKind", "scopeId", "resourceType"]) assert.equal(owner[key], before[key]);
  assert.deepEqual(owner.selectionReview, receipt.selectionReview);
  assert.equal(owner.mode, expectedAssignments.length ? "curated" : "inherit");
}

/** Configuration selection only: actual isolated owners, one disabled MCP record, no transport or tool execution. */
export async function runCockpitCapabilityScopesProof({ context, browser, stack, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const api = async (route, init) => { const response = await requestJson(stack.gatewayUrl, route, init); assertOk(response, route); return response.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-capability-scopes.${variant}`, lane: "ux-budgets",
      title: `Reviewed Citadel and workspace capability selections ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "create isolated scope fixtures", page, browserContext;
      const screenshots = [], writes = [], unexpected = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const suffix = randomUUID().slice(0, 8), label = `Scope proof MCP ${variant} ${suffix}`;
        const citadel = await api("/api/v1/citadels", { method: "POST", body: { name: `Scope proof ${suffix}`, slug: `scope-proof-${suffix}`, kind: "team", description: "Disposable selection proof only." } });
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId: citadel.citadelId, name: `Scope workspace ${suffix}`, slug: `scope-workspace-${suffix}` } });
        const server = await api("/api/v1/mcp/servers", { method: "POST", body: { label, transport: "stdio", command: "node", args: ["--version"], authType: "none", enabled: false } });
        assert.equal(server.enabled, false); assert.equal(server.status, "disconnected");
        const ids = { citadel: citadel.citadelId, workspace: workspace.workspaceId };
        const read = (kind, type = "mcp_server") => api(`${pathFor(kind, ids[kind])}?type=${type}`);
        const peerSave = async (kind, assignments) => {
          const before = await read(kind), receipt = await api(`${pathFor(kind, ids[kind])}/reviewed`, { method: "PATCH", body: { resourceType: "mcp_server", expectedRevision: before.selectionReview.revision, assignments } });
          assertCapabilityScopeAgreement({ before, request: { resourceType: "mcp_server", expectedRevision: before.selectionReview.revision, assignments }, receipt, owner: await read(kind), method: "PATCH", expectedAssignments: assignments });
        };
        // Persisted missing references are deliberately displayed as unavailable, never fabricated as callable entries.
        await peerSave("citadel", sorted([{ resourceRef: server.serverId, enabled: true }, ...Array.from({ length: 31 }, (_, index) => ({ resourceRef: `unavailable-proof-${suffix}-${String(index).padStart(2, "0")}`, enabled: false }))]));
        const unchanged = await Promise.all(["citadel", "workspace"].flatMap(kind => ["skill", "integration"].map(async type => ({ kind, type, view: await read(kind, type) }))));
        const initial = await read("citadel"); assert.ok(initial.items.length > 30);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, citadel.citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (["PATCH", "DELETE"].includes(request.method()) && Object.entries(ids).some(([kind, id]) => pathname === `${pathFor(kind, id)}/reviewed`))
            writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
          else unexpected.push(`${request.method()} ${pathname}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-capabilities"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const section = kind => page.getByRole("region", { name: `${kind === "citadel" ? "Citadel" : "Workspace"} capability selections`, exact: true });
        const panel = kind => section(kind).getByRole("region", { name: "MCP servers selection", exact: true });
        const dialog = reset => page.getByRole("dialog", { name: reset ? "Review inherited selection" : "Review capability selection", exact: true });
        async function refresh(kind) {
          const response = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === pathFor(kind, ids[kind]) && new URL(value.url()).searchParams.get("type") === "mcp_server");
          void response.catch(() => {}); // Keep a click failure from leaving an unhandled waiter.
          await panel(kind).getByRole("button", { name: "Refresh mcp servers scope", exact: true }).click();
          const result = await response; assert.equal(result.status(), 200);
          await panel(kind).getByText("Reading the current selection…", { exact: true }).waitFor({ state: "hidden" });
          return result.json();
        }
        async function prepare(kind, reset = false) {
          const before = await read(kind);
          if (!reset) {
            await panel(kind).getByRole("searchbox", { name: "Search mcp servers scope", exact: true }).fill(label);
            const choice = panel(kind).getByRole("checkbox", { name: `Select ${label}`, exact: true });
            await choice.waitFor(); assert.equal(await choice.isChecked(), true); await choice.uncheck();
          }
          await panel(kind).getByRole("button", { name: reset ? "Review inheritance" : "Review selection", exact: true }).click();
          await dialog(reset).waitFor();
          return { before, expectedAssignments: reset ? [] : changedSelection(before, server.serverId, false) };
        }
        async function apply(kind, review, reset = false) {
          const method = reset ? "DELETE" : "PATCH", route = `${pathFor(kind, ids[kind])}/reviewed`;
          const response = page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === route);
          void response.catch(() => {});
          await dialog(reset).getByRole("button", { name: "Apply reviewed selection", exact: true }).click();
          const result = await response; assert.equal(result.status(), 200); const receipt = await result.json();
          await dialog(reset).waitFor({ state: "hidden" });
          await panel(kind).getByText("Capability selection saved and confirmed. Availability and runtime policy are evaluated separately.", { exact: true }).waitFor();
          assertCapabilityScopeAgreement({ ...review, request: writes.at(-1).body, receipt, owner: await read(kind), method });
        }
        stage = "inspect bounded and unavailable saved references";
        await panel("citadel").getByRole("checkbox").first().waitFor();
        assert.equal(await panel("citadel").getByRole("checkbox").count(), 30);
        await panel("citadel").getByRole("button", { name: "Show more references", exact: true }).click();
        assert.equal(await panel("citadel").getByRole("checkbox").count(), Math.min(60, initial.items.length));
        await panel("citadel").getByText("Currently unavailable; saved selection is retained", { exact: true }).first().waitFor();
        await capture("bounded-selection", panel("citadel"));
        stage = "cancel then apply exact Citadel selection and inheritance";
        const reviewed = await prepare("citadel"); await capture("review", dialog(false));
        await dialog(false).getByRole("button", { name: "Cancel scope review", exact: true }).click();
        assert.deepEqual(writes, []); assert.deepEqual(await read("citadel"), reviewed.before);
        await panel("citadel").getByRole("button", { name: "Review selection", exact: true }).click();
        await apply("citadel", reviewed);
        await apply("citadel", await prepare("citadel", true), true);
        assert.equal(writes.length, 2);
        stage = "withhold Workspace mutation after exact parent revision changes";
        await page.getByRole("tab", { name: "Workspace capabilities", exact: true }).click(); await refresh("workspace");
        const stale = await prepare("workspace");
        await peerSave("citadel", []); // Same-value parent clear advances the durable nonce, exercising empty-set ABA.
        const changed = await read("workspace"); assert.notEqual(changed.selectionReview.revision, stale.before.selectionReview.revision);
        assert.deepEqual(changed.selectionReview.assignments, stale.before.selectionReview.assignments);
        assert.deepEqual(changed.selectionReview.parentAssignments, stale.before.selectionReview.parentAssignments);
        await dialog(false).getByRole("button", { name: "Apply reviewed selection", exact: true }).click();
        await panel("workspace").getByText("The scope or its available choices changed. Review the current selection before another attempt.", { exact: true }).waitFor();
        assert.equal(writes.length, 2); await capture("parent-conflict", panel("workspace"));
        await panel("workspace").getByRole("button", { name: "Discard selection draft", exact: true }).click();
        stage = "apply exact Workspace curation and restore inheritance";
        await apply("workspace", await prepare("workspace"));
        await apply("workspace", await prepare("workspace", true), true);
        assert.equal(writes.length, 4); await capture("inherited", panel("workspace"));
        stage = "retain a lost acknowledgement across component remount without replay";
        const uncertain = await prepare("workspace"), route = `${pathFor("workspace", workspace.workspaceId)}/reviewed`;
        let lostReceipt, lossCount = 0;
        const loseResponse = async intercepted => {
          if (intercepted.request().method() !== "PATCH") return intercepted.continue();
          lossCount++; const result = await intercepted.fetch(); assert.equal(result.status(), 200); lostReceipt = await result.json(); await intercepted.abort("failed");
        };
        await page.route(`**${route}`, loseResponse);
        await dialog(false).getByRole("button", { name: "Apply reviewed selection", exact: true }).click();
        await dialog(false).getByText(/^Capability selection outcome is unconfirmed\./u).waitFor();
        assert.equal(lossCount, 1); assert.equal(writes.length, 5);
        assertCapabilityScopeAgreement({ ...uncertain, request: writes[4].body, receipt: lostReceipt, owner: await read("workspace"), method: "PATCH" });
        await page.unroute(`**${route}`, loseResponse);
        // The failed review remains inspectable; Cancel only closes its local dialog and cannot unlock the operation.
        await dialog(false).getByRole("button", { name: "Cancel scope review", exact: true }).click();
        const sourceUrl = page.url(), documentOrigin = await page.evaluate(() => performance.timeOrigin);
        const retainedOwner = await read("workspace"), retainedWrites = structuredClone(writes);
        const navigation = page.getByRole("navigation", { name: "Settings pages", exact: true });
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        const leaveDescription = "You have unsaved changes in workspace mcp_server selection.";
        await navigation.getByRole("link", { name: "General", exact: true }).click();
        await leave.waitFor(); await leave.getByText(leaveDescription, { exact: true }).waitFor();
        assert.equal(await leave.count(), 1); assert.equal(page.url(), sourceUrl);
        assert.deepEqual(writes, retainedWrites); assert.deepEqual(await read("workspace"), retainedOwner);
        await leave.getByRole("button", { name: "Cancel", exact: true }).click();
        await leave.waitFor({ state: "hidden" }); assert.equal(page.url(), sourceUrl);
        assert.equal(await panel("workspace").getByRole("searchbox", { name: "Search mcp servers scope", exact: true }).inputValue(), label);
        assert.equal(await panel("workspace").getByRole("checkbox", { name: `Select ${label}`, exact: true }).isChecked(), false);
        await panel("workspace").getByText(/^Capability selection outcome is unconfirmed\./u).waitFor();
        assert.equal(await panel("workspace").getByRole("button", { name: "Review selection", exact: true }).isDisabled(), true);
        assert.deepEqual(writes, retainedWrites); assert.deepEqual(unexpected, []);
        await navigation.getByRole("link", { name: "General", exact: true }).click();
        await leave.waitFor(); await leave.getByText(leaveDescription, { exact: true }).waitFor();
        assert.equal(page.url(), sourceUrl);
        await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await leave.waitFor({ state: "hidden" });
        await page.waitForURL(url => url.pathname === "/settings/general" && url.search === "?shell=cockpit" && !url.hash);
        await page.getByRole("heading", { name: "General", exact: true }).waitFor();
        assert.deepEqual(writes, retainedWrites); assert.deepEqual(await read("workspace"), retainedOwner);
        await navigation.getByRole("link", { name: "Citadel", exact: true }).click();
        await page.getByRole("heading", { name: "Citadel", exact: true }).waitFor();
        await page.getByRole("tab", { name: "Workspace capabilities", exact: true }).click();
        await page.waitForURL(sourceUrl);
        await panel("workspace").getByText(/^Capability selection outcome is unconfirmed\./u).waitFor();
        await refresh("workspace");
        await panel("workspace").getByRole("searchbox", { name: "Search mcp servers scope", exact: true }).fill(label);
        const retainedChoice = panel("workspace").getByRole("checkbox", { name: `Select ${label}`, exact: true });
        await retainedChoice.waitFor(); assert.equal(await retainedChoice.isChecked(), false);
        await panel("workspace").getByRole("button", { name: "Discard selection draft", exact: true }).waitFor();
        assert.deepEqual(await read("workspace"), retainedOwner);
        assert.deepEqual(writes, retainedWrites); assert.equal(lossCount, 1);
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin);
        assert.equal(await panel("workspace").getByRole("button", { name: "Review selection", exact: true }).isDisabled(), true);
        assert.equal(await panel("workspace").getByRole("button", { name: "Review inheritance", exact: true }).isDisabled(), true);
        assert.equal(writes.length, 5); assert.deepEqual(unexpected, []);
        for (const entry of unchanged) assert.deepEqual(await read(entry.kind, entry.type), entry.view);
        assert.deepEqual(await api(`/api/v1/mcp/servers/${encodeURIComponent(server.serverId)}`), server);
        assert.deepEqual((await api(`/api/v1/mcp/servers/${encodeURIComponent(server.serverId)}/tools`)).items, []);
        await capture("unknown-locked", panel("workspace"));
        return { status: "passed", metrics: { browserSelectionWrites: 5, fixtureSelectionWrites: 2, exactOwnerAgreement: true, boundedReferences: 30,
          cancelWrites: 0, staleParentWrites: 0, emptyParentAbaGuard: true, unrelatedSelectionTypesUnchanged: true,
          inheritanceRestoredBeforeLoss: true, lostResponseInjected: true, remountUnknownLock: true, canceledLeavePreservesSelection: true, explicitKeepBeforeRemount: true, sameDocumentRemount: true, transportOrToolRequests: 0, blockingAxe: 0,
          limitation: "Saved reference selection only in new disposable scopes. Missing references are seeded persisted selections and shown unavailable. No runtime eligibility freeze, MCP connection or tool execution is claimed." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await capture("failure", null, false); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserSelectionWrites: writes.length, unexpectedMutations: unexpected }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, target, audit = true) {
        await mkdir(screenshotDir, { recursive: true }); if (target) await target.scrollIntoViewIfNeeded();
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page);
          assert.deepEqual(result.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const file = path.join(screenshotDir, `ux-budgets-cockpit-capability-scopes-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
