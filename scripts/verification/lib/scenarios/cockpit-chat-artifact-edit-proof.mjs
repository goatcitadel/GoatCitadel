import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { seedVisibleChatArtifact } from "./chat-artifact-fixture.mjs";

const proposalsPath = "/api/v1/chat/document-patch-proposals";
const versionPath = (id) => `/api/v1/chat/generated-artifacts/${encodeURIComponent(id)}/versions`;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const hash = (content) => createHash("sha256").update(content).digest("hex");

export function assertArtifactEditVersion(item, base, content) {
  assert.ok(item?.artifactId && item.artifactId !== base.artifactId, "An edit must create an immutable artifact identity");
  for (const key of ["workspaceId", "sessionId", "turnId", "kind"]) assert.equal(item[key], base[key], `Edited artifact lost ${key}`);
  assert.equal(item.supersedesArtifactId, base.artifactId);
  assert.equal(item.version, base.version + 1);
  assert.equal(item.content, content);
  assert.equal(item.contentHash, hash(content));
  return item;
}

export function assertArtifactProposal(item, base, content, state = "pending") {
  assert.ok(item?.proposalId, "The proposal has no canonical identity");
  assert.equal(item.workspaceId, base.workspaceId);
  assert.equal(item.sessionId, base.sessionId);
  assert.equal(item.targetKind, "generated_artifact");
  assert.equal(item.targetId, base.artifactId);
  assert.equal(item.baseContentHash, base.contentHash);
  assert.equal(item.proposedContent, content);
  assert.equal(item.authorKind, "operator");
  assert.ok(item.authorId, "Operator provenance is absent");
  assert.equal(item.state, state);
  assert.ok(item.derivedDiff.includes("--- current\n+++ proposed\n@@ full replacement @@"));
  for (const line of content.split("\n")) assert.ok(item.derivedDiff.includes(`+${line}`));
  return item;
}

/** Seeded initial evidence; every edit/proposal decision below uses its real Gateway owner. */
export async function runCockpitChatArtifactEditProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-chat-artifact-edit.${variant}`, lane: "ux-budgets",
      title: `Cockpit Chat artifact edits and proposal decisions ${variant}`, subsystem: "mission-control-ux" }, async () => {
      assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),
        "Artifact edit proof requires the disposable usability runtime");
      const { workspaceId, sessionId, artifact: initial } = await seedVisibleChatArtifact(stack.gatewayUrl, { requestJson, assertOk });
      assert.ok(["markdown", "text"].includes(initial.kind), "Seeded artifact is not an editable Markdown/text record");
      assert.equal(initial.contentHash, hash(initial.content));
      const note = await requestJson(stack.gatewayUrl, "/api/v1/notes", { method: "POST",
        body: { workspaceId, title: `Artifact edit cancel target ${variant}`, body: "Synthetic navigation target." } });
      assertOk(note, "create isolated draft-switch target");
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
      let page, files;
      let stage = "open seeded artifact";
      const screenshots = [], writes = [];
      const read = async (route) => {
        const response = await requestJson(stack.gatewayUrl, route);
        assertOk(response, stage);
        return response.body;
      };
      const readArtifact = async (id) => (await read(`/api/v1/chat/generated-artifacts/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId, citadelId })}`)).item;
      const readProposal = async (id) => (await read(`${proposalsPath}?${new URLSearchParams({ workspaceId, sessionId })}`)).items.find((item) => item.proposalId === id);
      const listArtifacts = async () => (await read(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/generated-artifacts?${new URLSearchParams({ workspaceId })}`)).items;
      const waitPost = (pathname) => page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === pathname);
      const clickPost = async (button, pathname, status) => {
        const responsePromise = waitPost(pathname);
        await button.click();
        const response = await responsePromise;
        assert.equal(response.status(), status, `${stage}: unexpected owner status`);
        return { body: await response.json(), input: response.request().postDataJSON() };
      };
      const selectArtifact = async (artifact, discardPriorDraft = false) => {
        const name = new RegExp(`^Artifact · ${escapePattern(artifact.title)} · ${artifact.kind} v${artifact.version}(?: · Unsaved)?$`, "u");
        await files.getByRole("group", { name: "Chat documents", exact: true }).getByRole("button", { name }).click();
        if (discardPriorDraft) await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
        await files.getByRole("textbox", { name: "Document content", exact: true }).waitFor();
      };
      const editor = () => files.getByRole("textbox", { name: "Document content", exact: true });
      const openFiles = async () => {
        await page.locator('[aria-label="Messages"]').waitFor({ timeout: 30_000 });
        if (variant === "mobile") {
          await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
          await page.getByRole("menuitem", { name: "Inspect conversation", exact: true }).click();
        } else await page.getByRole("button", { name: "Inspect", exact: true }).click();
        await page.getByRole("tab", { name: "Files", exact: true }).click();
        files = page.getByRole("tabpanel", { name: "Files", exact: true });
        await files.getByRole("group", { name: "Chat documents", exact: true }).waitFor();
      };
      const snapshot = async (label) => {
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        assert.deepEqual(blocking.map((item) => item.id), [], `${stage}: accessibility violations`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${stage}: horizontal overflow ${overflow}px`);
        const screenshot = path.join(context.artifactRoot, "screenshots", `ux-budgets-cockpit-chat-artifact-${label}-${variant}.png`);
        await mkdir(path.dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: false });
        screenshots.push(relativeToRun(context, screenshot));
      };
      const proposalView = async (proposal) => {
        const section = files.locator("details").filter({ has: page.locator("pre").filter({ hasText: proposal.derivedDiff }) });
        await section.waitFor();
        if (!(await section.evaluate((element) => element.open))) await section.locator("summary").click();
        await section.getByText(`operator provenance · ${proposal.authorId}`, { exact: true }).waitFor();
        assert.equal(await section.locator("pre").textContent(), proposal.derivedDiff);
        return section;
      };
      const createProposal = async (base, content) => {
        await editor().fill(content);
        const response = await clickPost(files.getByRole("button", { name: "Create review proposal", exact: true }), proposalsPath, 201);
        assert.deepEqual(response.input, { workspaceId, sessionId, targetKind: "generated_artifact",
          targetId: base.artifactId, baseContentHash: base.contentHash, proposedContent: content });
        const proposal = assertArtifactProposal(response.body.item, base, content);
        assert.deepEqual(await readProposal(proposal.proposalId), proposal);
        return proposal;
      };
      try {
        await browserContext.addInitScript((theme) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        }, variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        page.setDefaultTimeout(20_000);
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (request.method() === "POST" && (pathname.startsWith(proposalsPath) || /\/generated-artifacts\/[^/]+\/versions$/u.test(pathname))) writes.push(pathname);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(sessionId)}&shell=cockpit`), { waitUntil: "domcontentloaded" });
        await openFiles();
        await selectArtifact(initial);
        assert.equal(await editor().inputValue(), initial.content);

        stage = "cancel draft switch without saving";
        const directContent = `# Browser artifact edit\n\nSaved directly in ${variant}.`;
        await editor().fill(directContent);
        await files.getByRole("button", { name: `Note · ${note.body.title} · r1`, exact: true }).click();
        await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await editor().inputValue(), directContent);
        assert.deepEqual(writes, []);
        assert.equal((await readArtifact(initial.artifactId)).contentHash, initial.contentHash);

        stage = "save exact immutable artifact version";
        const saved = await clickPost(files.getByRole("button", { name: "Save directly", exact: true }), versionPath(initial.artifactId), 201);
        assert.deepEqual(saved.input, { workspaceId, baseContentHash: initial.contentHash, content: directContent });
        const direct = assertArtifactEditVersion(saved.body.item, initial, directContent);
        assert.deepEqual(await readArtifact(direct.artifactId), direct);
        assert.equal((await readArtifact(initial.artifactId)).content, initial.content);
        await selectArtifact(direct);
        assert.equal(await editor().inputValue(), directContent);
        await snapshot("saved");

        stage = "review and apply exact artifact proposal";
        const appliedContent = `# Browser reviewed change\n\nApplied after diff review in ${variant}.`;
        const proposed = await createProposal(direct, appliedContent);
        const review = await proposalView(proposed);
        await snapshot("proposal-review");
        const applied = await clickPost(review.getByRole("button", { name: "Apply", exact: true }), `${proposalsPath}/${encodeURIComponent(proposed.proposalId)}/apply`, 200);
        assert.deepEqual(applied.input, { workspaceId });
        assertArtifactProposal(applied.body.item, direct, appliedContent, "applied");
        const accepted = assertArtifactEditVersion(await readArtifact(applied.body.item.appliedTargetId), direct, appliedContent);
        assert.equal(applied.body.item.appliedContentHash, accepted.contentHash);
        assert.equal(applied.body.item.appliedRevision, accepted.version);
        assert.deepEqual(await readProposal(proposed.proposalId), applied.body.item);
        await selectArtifact(accepted, true);

        stage = "reject exact artifact proposal without creating a version";
        const rejectedContent = `Rejected draft ${variant}.`;
        const rejected = await createProposal(accepted, rejectedContent);
        const beforeReject = (await listArtifacts()).map((item) => item.artifactId).sort();
        const rejectedView = await proposalView(rejected);
        const rejection = await clickPost(rejectedView.getByRole("button", { name: "Reject", exact: true }), `${proposalsPath}/${encodeURIComponent(rejected.proposalId)}/reject`, 200);
        assert.deepEqual(rejection.input, { workspaceId });
        assertArtifactProposal(await readProposal(rejected.proposalId), accepted, rejectedContent, "rejected");
        assert.deepEqual((await listArtifacts()).map((item) => item.artifactId).sort(), beforeReject);
        assert.equal(await editor().inputValue(), rejectedContent);

        stage = "preserve stale draft and reject conflicting proposal";
        const conflictContent = `Preserved proposal draft ${variant}.`;
        const conflict = await createProposal(accepted, conflictContent);
        const concurrentContent = `Concurrent owner update ${variant}.`;
        const concurrentResponse = await requestJson(stack.gatewayUrl, versionPath(accepted.artifactId), { method: "POST",
          body: { workspaceId, baseContentHash: accepted.contentHash, content: concurrentContent } });
        assertOk(concurrentResponse, "create isolated concurrent artifact version");
        const concurrent = assertArtifactEditVersion(concurrentResponse.body.item, accepted, concurrentContent);
        const conflictView = await proposalView(conflict);
        await clickPost(conflictView.getByRole("button", { name: "Apply", exact: true }), `${proposalsPath}/${encodeURIComponent(conflict.proposalId)}/apply`, 409);
        const conflictOwner = assertArtifactProposal(await readProposal(conflict.proposalId), accepted, conflictContent, "conflicted");
        assert.ok(conflictOwner.conflictReason);
        await files.getByText(conflictOwner.conflictReason, { exact: true }).first().waitFor();
        assert.equal(await editor().inputValue(), conflictContent);
        await clickPost(files.getByRole("button", { name: "Save directly", exact: true }), versionPath(accepted.artifactId), 409);
        assert.equal(await editor().inputValue(), conflictContent);
        assert.equal((await listArtifacts()).filter((item) => item.supersedesArtifactId === accepted.artifactId).length, 1);
        await snapshot("conflict");

        stage = "retain draft after a real save response is lost";
        // The conflict refresh reloads document owners. Reopen the conversation to
        // acquire the concurrent immutable version, after explicitly discarding this tested draft.
        await files.getByRole("button", { name: `Note · ${note.body.title} · r1`, exact: true }).click();
        await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Discard changes", exact: true }).click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await openFiles();
        await selectArtifact(concurrent);
        const unknownContent = `Owner saved, browser response lost ${variant}.`;
        await editor().fill(unknownContent);
        let forwarded;
        const faultUrl = `**${versionPath(concurrent.artifactId)}`;
        await page.route(faultUrl, async (route) => {
          const response = await route.fetch();
          forwarded = { status: response.status(), body: await response.json() };
          await route.abort("failed");
        }, { times: 1 });
        const writesBeforeUnknown = writes.length;
        await files.getByRole("button", { name: "Save directly", exact: true }).click();
        await files.getByRole("alert").last().waitFor();
        assert.equal(forwarded?.status, 201);
        const unknownSaved = assertArtifactEditVersion(forwarded.body.item, concurrent, unknownContent);
        assert.equal(await editor().inputValue(), unknownContent);
        await page.waitForTimeout(500);
        assert.equal(writes.length, writesBeforeUnknown + 1, "A lost response must not trigger an automatic mutation retry");
        assert.deepEqual(await readArtifact(unknownSaved.artifactId), unknownSaved);
        assert.equal((await listArtifacts()).filter((item) => item.supersedesArtifactId === concurrent.artifactId).length, 1);
        await snapshot("unknown-response");
        await files.getByRole("button", { name: `Note · ${note.body.title} · r1`, exact: true }).click();
        await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await editor().inputValue(), unknownContent);
        assert.equal(writes.length, writesBeforeUnknown + 1);
        return { status: "passed", metrics: { seededInitialRecord: true, workspaceId, sessionId,
          directVersion: direct.version, appliedVersion: accepted.version, rejectedProposal: rejected.proposalId,
          conflictedProposal: conflict.proposalId, unknownResponseOwnerVersion: unknownSaved.version,
          exactHashReadback: true, cancelledWithoutMutation: true, unknownDraftRetained: true,
          automaticUnknownRetries: 0, blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          const screenshot = path.join(context.artifactRoot, "screenshots", `ux-budgets-cockpit-chat-artifact-edit-${variant}-failure.png`);
          try { await mkdir(path.dirname(screenshot), { recursive: true }); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Preserve the original failure. */ }
        }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, documentMutationRequests: writes.length, seededInitialRecord: true }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
