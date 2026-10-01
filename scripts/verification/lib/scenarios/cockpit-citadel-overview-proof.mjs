import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertBlueprintImportOwner } from "./cockpit-citadel-blueprint-proof.mjs";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";

const charterInput = charter => Object.fromEntries(["purpose", "kind", "goals", "boundaries", "successDefinition", "defaultChamberId", "riskPosture", "modelPolicyDefault"].filter(key => charter[key] !== undefined).map(key => [key, charter[key]]));
export function assertOverviewCharterOwner({ before, purpose, request, receipt, owner }) {
  assert.deepEqual(request, { ...charterInput(before.charter), purpose, expectedRevision: before.revision });
  assert.equal(receipt.citadelId, before.citadelId); assert.notEqual(receipt.revision, before.revision);
  assert.deepEqual(receipt, owner, "Charter receipt disagrees with independent canonical readback.");
  assert.deepEqual(receipt.record, before.record); assert.deepEqual(receipt.chambers, before.chambers);
  assert.equal(receipt.charter.createdAt, before.charter.createdAt);
  assert.deepEqual(charterInput(receipt.charter), { ...charterInput(before.charter), purpose });
}
export function assertOverviewTemplateOwner({ before, template, request, receipt, owner }) {
  assert.deepEqual(request, { templateId: template.id, expectedRevision: before.revision, expectedTemplateRevision: template.revision });
  const blueprint = { charter: { purpose: template.purpose, kind: template.kind, goals: template.goals, boundaries: template.boundaries,
    successDefinition: template.successDefinition, riskPosture: template.riskPosture ?? "balanced", modelPolicyDefault: template.modelPolicyDefault ?? "hybrid_guarded" },
    chambers: template.chambers.map(chamber => ({ name: chamber.name, sensitivity: chamber.sensitivity ?? "private", sealed: chamber.sealed ?? false })) };
  assertBlueprintImportOwner({ before, blueprint, receipt, owner, request: { blueprint, expectedRevision: before.revision } });
}
export function assertOverviewBriefClipboard({ brief, markdown }) {
  assert.equal(brief.spend.scope, "instance");
  const text = markdown.replaceAll("\r\n", "\n");
  assert.ok(text.startsWith(`# Daily brief — ${brief.citadelName ?? brief.citadelId}\nWindow: ${brief.since} → ${brief.generatedAt}\n`));
  assert.ok(text.includes(`- Pending approvals: ${brief.approvals.pendingCount}`));
  assert.ok(text.includes(`- Activity: ${brief.activity.eventsSince} events · ${brief.activity.completedSince} completed · ${brief.activity.failedSince} failed · ${brief.activity.wardHitsSince} ward hits`));
  const spend = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(brief.spend.sinceUsd);
  assert.ok(text.includes(`- Spend (instance): ${spend} · ${brief.spend.sinceTokens} tokens${brief.spend.complete ? "" : " (partial data)"}`));
  assert.ok(text.includes("unavailable" in brief.memory ? `- Memory: unavailable (${brief.memory.unavailable})` : `- Memory: ${brief.memory.pendingRecommendations} recommendation(s) pending review`));
  for (const item of brief.approvals.pending) assert.ok(text.includes(`(${item.workspaceId})`));
}

/** Only new disposable Citadels are changed; clipboard is the actual browser clipboard. */
export async function runCockpitCitadelOverviewProof({ context, browser, stack, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Overview proof requires a disposable runtime.");
  const api = async (route, init) => { const reply = await requestJson(stack.gatewayUrl, route, init); assert.ok(reply.ok, `${route} returned ${reply.status}`); return reply.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-citadel-overview.${variant}`, lane: "ux-budgets",
      title: `Native Citadel template, Charter, inspection and actual clipboard ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const screenshots = [], writes = [], directory = path.join(context.artifactRoot, "screenshots");
      let browserContext, page, panel, stage = "create disposable Citadel";
      try {
        const suffix = `${variant}-${randomUUID().slice(0, 8)}`, id = `ux-overview-${suffix}`;
        const initial = (await api("/api/v1/citadels?view=all&limit=500")).items;
        const record = await api("/api/v1/citadels", { method: "POST", body: { name: `Overview ${suffix}`, slug: id, kind: "team" } }); assert.equal(record.citadelId, id);
        const workspace = await api("/api/v1/workspaces", { method: "POST", body: { name: `Overview workspace ${suffix}`, citadelId: id } });
        const ownerPath = `/api/v1/citadels/${encodeURIComponent(id)}`, read = () => api(`${ownerPath}/structure`);
        const original = await read(), templates = (await api("/api/v1/citadel-templates")).items;
        const template = templates.find(item => item.kind === "personal"); assert.ok(template?.revision);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme, permissions: ["clipboard-read", "clipboard-write"] });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, id); page = await browserContext.newPage();
        page.on("request", request => { const pathname = new URL(request.url()).pathname;
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) writes.push({ method: request.method(), pathname, body: request.postDataJSON() }); });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-overview?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 }); panel = page.getByRole("region", { name: "Citadel Overview", exact: true });
        const reviewTemplate = async () => { await panel.getByRole("article").filter({ has: page.getByRole("heading", { name: template.name, exact: true }) }).getByRole("button", { name: "Review template", exact: true }).click(); return page.getByRole("dialog", { name: "Apply this Citadel template?", exact: true }); };
        stage = "review and cancel exact template"; const cancelled = await reviewTemplate(); await cancelled.waitFor();
        for (const value of [template.purpose, template.revision, original.revision, id]) assert.ok((await cancelled.innerText()).includes(value));
        await capture("template-review", cancelled, ["Apply template", "Cancel"]); await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(writes.length, 0); assert.deepEqual(await read(), original);
        stage = "apply exact template and confirm owner"; const review = await reviewTemplate();
        const applied = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${ownerPath}/from-template`);
        await review.getByRole("button", { name: "Apply template", exact: true }).click(); const response = await applied; assert.equal(response.status(), 201); const receipt = await response.json();
        await panel.getByText("Citadel template applied and confirmed.", { exact: true }).waitFor();
        const templateWrites = writes.filter(item => item.pathname === `${ownerPath}/from-template`); assert.equal(templateWrites.length, 1);
        assertOverviewTemplateOwner({ before: original, template, request: templateWrites[0].body, receipt, owner: await read() });
        stage = "retain Charter draft and reject a stale reviewed structure";
        await panel.getByRole("button", { name: "Edit Charter", exact: true }).click(); const editor = page.getByRole("dialog", { name: "Edit Charter", exact: true });
        const purpose = `Reviewed native purpose ${suffix}`; await editor.getByLabel("Purpose", { exact: true }).fill(purpose);
        await editor.getByRole("button", { name: "Review Charter save", exact: true }).click(); const count = writes.length;
        const peerBefore = await read(); await api(`${ownerPath}/charter`, { method: "PUT", body: { ...charterInput(peerBefore.charter), purpose: `Peer purpose ${suffix}`, expectedRevision: peerBefore.revision } });
        const peer = await read(); await editor.getByRole("button", { name: "Confirm Charter save", exact: true }).click();
        await editor.getByText(/^The Citadel changed after this draft began/).waitFor(); assert.equal(writes.length, count);
        await editor.getByRole("button", { name: "Apply draft to current Charter", exact: true }).click();
        await editor.getByRole("button", { name: "Close Charter", exact: true }).click();
        await page.getByRole("dialog", { name: "Unsaved Charter draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await panel.getByRole("button", { name: "Edit Charter · Unsaved", exact: true }).click(); assert.equal(await editor.getByLabel("Purpose", { exact: true }).inputValue(), purpose);
        await editor.getByRole("button", { name: "Review Charter save", exact: true }).click(); await capture("charter-review", editor, ["Confirm Charter save", "Cancel review"]);
        const saved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `${ownerPath}/charter`);
        await editor.getByRole("button", { name: "Confirm Charter save", exact: true }).click(); const saveReply = await saved; assert.equal(saveReply.status(), 200);
        await panel.getByText("Citadel Charter saved and confirmed.", { exact: true }).waitFor(); const charterReceipt = await saveReply.json();
        assertOverviewCharterOwner({ before: peer, purpose, request: writes.filter(item => item.pathname === `${ownerPath}/charter`).at(-1).body, receipt: charterReceipt, owner: await read() });
        stage = "inspect actual Chambers, Gatehouse and Brief";
        await panel.getByRole("button", { name: "Chambers", exact: true }).click(); for (const chamber of charterReceipt.chambers) await panel.getByText(chamber.name, { exact: true }).waitFor(); await capture("chambers");
        await panel.getByRole("button", { name: "Gatehouse", exact: true }).click(); await panel.getByText("External writes", { exact: true }).waitFor(); await capture("gatehouse");
        const briefResponse = page.waitForResponse(reply => reply.request().method() === "GET" && new URL(reply.url()).pathname === `${ownerPath}/brief`);
        await panel.getByRole("button", { name: "Brief", exact: true }).click(); const brief = await (await briefResponse).json(); assert.equal(brief.citadelId, id);
        const briefPanel = panel.getByRole("article", { name: "Daily Citadel brief", exact: true }); await briefPanel.getByText("Spend and token totals cover the installation; they are not filtered to this Citadel.", { exact: true }).waitFor();
        const beforeCopy = writes.length; await briefPanel.getByRole("button", { name: "Copy as Markdown", exact: true }).click(); await briefPanel.getByText("Brief copied as Markdown.", { exact: true }).waitFor();
        assertOverviewBriefClipboard({ brief, markdown: await page.evaluate(() => navigator.clipboard.readText()) }); assert.equal(writes.length, beforeCopy); await capture("brief");
        stage = "lose committed Charter response and retain shared Blueprint lock";
        await panel.getByRole("button", { name: "Charter", exact: true }).click(); await panel.getByRole("button", { name: "Edit Charter", exact: true }).click();
        const lostPurpose = `Unconfirmed purpose ${suffix}`, beforeLost = await read(); await editor.getByLabel("Purpose", { exact: true }).fill(lostPurpose);
        await editor.getByRole("button", { name: "Review Charter save", exact: true }).click(); let lostReceipt;
        const lose = async route => { if (route.request().method() !== "PUT") return route.continue(); const reply = await route.fetch(); assert.equal(reply.status(), 200); lostReceipt = await reply.json(); await route.abort("failed"); };
        await page.route(`**${ownerPath}/charter`, lose); await editor.getByRole("button", { name: "Confirm Charter save", exact: true }).click();
        await editor.getByText(/^Citadel structure outcome is unconfirmed/).waitFor(); await page.unroute(`**${ownerPath}/charter`, lose);
        assertOverviewCharterOwner({ before: beforeLost, purpose: lostPurpose, request: writes.filter(item => item.pathname === `${ownerPath}/charter`).at(-1).body, receipt: lostReceipt, owner: await read() });
        await editor.getByRole("button", { name: "Close Charter", exact: true }).click(); await page.getByRole("dialog", { name: "Unsaved Charter draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await page.getByRole("navigation", { name: "Library sections", exact: true }).getByRole("link", { name: "Capabilities", exact: true }).click();
        await page.evaluate(() => { window.history.pushState(null, "", "/library/citadel-overview?shell=cockpit"); window.dispatchEvent(new window.PopStateEvent("popstate")); });
        await panel.getByRole("button", { name: "Edit Charter · Unsaved", exact: true }).click(); assert.equal(await editor.getByLabel("Purpose", { exact: true }).inputValue(), lostPurpose); assert.equal(await editor.getByLabel("Purpose", { exact: true }).isDisabled(), true);
        await capture("unknown-locked", editor, ["Review Charter save", "Close Charter"]);
        const finalCount = writes.length; await editor.getByRole("button", { name: "Close Charter", exact: true }).click(); await page.getByRole("dialog", { name: "Unsaved Charter draft", exact: true }).getByRole("button", { name: "Keep draft and close", exact: true }).click();
        await page.evaluate(() => { window.history.pushState(null, "", "/library/citadel-blueprint?shell=cockpit"); window.dispatchEvent(new window.PopStateEvent("popstate")); });
        const blueprint = page.getByRole("region", { name: "Citadel Blueprint", exact: true }); await blueprint.getByRole("button", { name: "Import", exact: true }).click();
        assert.equal(await blueprint.getByRole("button", { name: "Validate", exact: true }).isDisabled(), true); assert.equal(await blueprint.getByRole("button", { name: "Review import", exact: true }).isDisabled(), true); assert.equal(writes.length, finalCount);
        const final = (await api("/api/v1/citadels?view=all&limit=500")).items; for (const prior of initial) assert.deepEqual(final.find(item => item.citadelId === prior.citadelId), prior);
        return { status: "passed", metrics: { cancelledWrites: 0, staleWrites: 0, exactTemplateOwner: true, exactCharterOwner: true, actualClipboard: true, retainedCrossOwnerLock: true, blockingAxe: 0,
          limitation: "Disposable Citadel structure and read-only daily brief. No Wards, Council, Vault, capability grants or external actions." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await mkdir(directory, { recursive: true }); const shot = path.join(directory, `ux-budgets-cockpit-citadel-overview-${variant}-failure.png`); await page.screenshot({ path: shot, fullPage: false }); screenshots.push(relativeToRun(context, shot)); } catch { /* Preserve original failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, metrics: { failedStage: stage }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext?.close(); }
      async function capture(name, dialog, labels = []) {
        await mkdir(directory, { recursive: true }); await page.addScriptTag({ path: axeSourcePath }); const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        if (dialog) { const buttons = {}; for (const label of labels) buttons[label] = await dialog.getByRole("button", { name: label, exact: true }).boundingBox(); assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons }); }
        else await panel.scrollIntoViewIfNeeded();
        const shot = path.join(directory, `ux-budgets-cockpit-citadel-overview-${variant}-${name}.png`); await page.screenshot({ path: shot, fullPage: false }); screenshots.push(relativeToRun(context, shot));
      }
    });
  }
}
