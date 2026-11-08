import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  assertComposerConfirmation,
  assertComposerPlan,
  assertComposerSelectedScope,
  assertComposerTurn,
  assertUploadedAttachment,
  captureComposerAccessibilityEvidence,
  composerPackMarkdown,
} from "./cockpit-chat-composer-evidence.mjs";
import { CLOSE_SHEET, readCurrentConversation, selectConversation } from "./cockpit-conversation-list.mjs";
import { runCockpitChatFirstSessionProof } from "./cockpit-chat-first-session-proof.mjs";
import { isStartupReadRequest, STARTUP_READ_BATCH_LIMIT, STARTUP_READ_BATCH_QUERY_LIMIT, STARTUP_READ_BATCH_BODY_LIMIT } from "../../../../packages/contracts/dist/gateway-startup-reads.js";

/** Admit the requested canonical core owner by request position, before UI action. */
export function matchComposerCoreStateRead(request, sessionId) {
  if (request.method() !== "GET") return null;
  const expectedPath = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/core-state`;
  const includesThread = url => {
    if (url.pathname !== expectedPath) return false;
    assert.ok([...url.searchParams.keys()].every(key => key === "includeThread") && url.searchParams.getAll("includeThread").length <= 1, "Ambiguous conversation core-state query");
    const value = url.searchParams.get("includeThread");
    assert.ok(value === null || value === "true" || value === "false", "Invalid conversation core-state query");
    return value !== "false";
  };
  const url = new URL(request.url());
  if (url.pathname !== "/api/v1/startup-reads") return includesThread(url) ? { transport: "direct", index: 0, count: 1 } : null;
  assert.ok(Buffer.byteLength(url.pathname + url.search, "utf8") <= STARTUP_READ_BATCH_QUERY_LIMIT + 100, "Startup read query exceeds contract bound");
  assert.ok(url.searchParams.getAll("reads").length === 1 && [...url.searchParams.keys()].every(key => key === "reads"), "Invalid startup read query shape");
  let rows;
  try { rows = JSON.parse(url.searchParams.get("reads")); } catch { throw new Error("Invalid conversation startup read JSON"); }
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= STARTUP_READ_BATCH_LIMIT && rows.every(isStartupReadRequest), "Invalid startup read membership");
  const matches = [];
  rows.forEach((row, index) => { if (includesThread(new URL(row.path, "http://startup-read.invalid"))) matches.push(index); });
  assert.ok(matches.length <= 1, "Duplicate conversation core-state membership");
  return matches.length ? { transport: "startup_batch", index: matches[0], count: rows.length } : null;
}

export async function readComposerCoreStateResult(request, response, { sessionId, workspaceId, status }) {
  const membership = matchComposerCoreStateRead(request, sessionId);
  assert.ok(membership, "Requested conversation hydration owner is absent");
  assert.equal(response.status(), 200, "Conversation core-state transport failed");
  assert.equal(status?.sessionId, sessionId, "Independent conversation status has foreign identity");
  assert.equal(status?.workspaceId, workspaceId, "Independent conversation status has foreign workspace");
  let body;
  try { body = await response.json(); } catch { throw new Error("Invalid conversation core-state JSON"); }
  // Same bounded transport envelope checks as the approved Inbox owner proof.
  if (membership.transport === "startup_batch") {
    assert.ok(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(key => key === "items") && Array.isArray(body.items) && body.items.length === membership.count, "Startup response does not match original membership");
    const headers = new Set(["content-type", "cache-control", "etag", "x-goatcitadel-correlation-id"]);
    assert.ok(body.items.every(row => row && typeof row === "object" && !Array.isArray(row) &&
      Object.keys(row).every(key => ["status", "bodyText", "headers", "directReadRequired"].includes(key)) &&
      Number.isInteger(row.status) && row.status >= 200 && row.status <= 599 && typeof row.bodyText === "string" && Buffer.byteLength(row.bodyText, "utf8") <= STARTUP_READ_BATCH_BODY_LIMIT &&
      row.headers && typeof row.headers === "object" && !Array.isArray(row.headers) && Object.entries(row.headers).every(([key, value]) => headers.has(key) && typeof value === "string" && !/[\r\n]/u.test(value)) &&
      (row.directReadRequired === undefined || row.directReadRequired === true)), "Invalid startup owner response envelope");
    const selected = body.items[membership.index];
    assert.ok(selected.status === 200 && selected.directReadRequired === undefined, "Conversation owner result is not a confirmed snapshot");
    try { body = JSON.parse(selected.bodyText); } catch { throw new Error("Invalid conversation owner JSON"); }
  }
  assert.equal(body?.sessionId, sessionId, "Conversation core-state has foreign identity");
  assert.equal(body?.thread?.sessionId, sessionId, "Conversation core-state omitted requested thread");
  assert.ok(Array.isArray(body.thread.turns), "Conversation core-state omitted canonical turns");
  assert.equal(body?.prefs?.sessionId, sessionId, "Conversation preferences have foreign identity");
  assert.ok(body.binding === null || body.binding?.sessionId === sessionId, "Conversation binding has foreign identity");
  return body.thread;
}

/** Real browser/owner proof. Requires two configured, reachable disposable provider models. */
export async function runCockpitChatComposerProof({ context, browser, stack, citadelId, viewports, deps,firstSession }) {
  const {
    assertOk,
    auditPageAccessibility,
    axeSourcePath,
    buildVerificationUiUrl,
    emptyArtifacts,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    requestJson,
    runScenario,
  } = deps;
  assert.ok(
    stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),
    "Composer proof requires a disposable shipped-defaults usability runtime",
  );
  const read = async (route, init) => {
    const result = await requestJson(stack.gatewayUrl, route, init);
    assertOk(result, `${init?.method ?? "GET"} ${route}`);
    return result.body;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-chat-composer.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Chat composer owner parity ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const token = randomUUID().slice(0, 8);
        const workspace = await read("/api/v1/workspaces", {
          method: "POST",
          body: { name: `Composer ${token}`, ...(citadelId ? { citadelId } : {}) },
        });
        const workspaceId = workspace.workspaceId;
        const ownerCitadelId = workspace.citadelId;
        assert.ok(workspaceId && ownerCitadelId, "Workspace owner omitted canonical workspace/Citadel identity");
        const session = await read("/api/v1/chat/sessions", {
          method: "POST",
          body: { workspaceId, title: `Composer ${token}` },
        });
        const other = await read("/api/v1/chat/sessions", {
          method: "POST",
          body: { workspaceId, title: `Other composer ${token}` },
        });
        const sessionId = session.sessionId;
        assert.ok(sessionId && other.sessionId && sessionId !== other.sessionId);
        const sessionPath = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
        const packName = `ComposerFixture-${token}`;
        const imported = await read("/api/v1/prompt-packs/import", {
          method: "POST",
          body: { name: packName, sourceLabel: "Disposable composer browser proof", content: composerPackMarkdown() },
        });
        const pack = imported.pack;
        const template = imported.tests?.[0];
        assert.ok(
          pack?.packId && pack.runVariableSchemaHash && template?.testId,
          "Typed pack owner import is incomplete",
        );
        const fileName = `000-composer-context-${token}.txt`;
        const fileContent = `Synthetic palette context ${token}.`;
        await read("/api/v1/files/upload", { method: "POST", body: { relativePath: fileName, content: fileContent } });
        const theme = variant === "mobile" ? "light" : "dark";
        const browserContext = await browser.newContext({ viewport, colorScheme: theme });
        const screenshots = [];
        const firstSessionDiagnostics=[];
        const accessibilityDiagnostics=[];
        let page,
          stage = "setup";
        const evidence = { workspaceId, citadelId: ownerCitadelId, sessionId, templateId: template.testId };
        try {
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, workspaceId, ownerCitadelId);
          page = await browserContext.newPage();
          const sends = [];
          page.on("request", (request) => {
            if (
              request.method() === "POST" &&
              /\/chat\/sessions\/[^/]+\/(?:agent-send|send)(?:\/stream)?$/u.test(new URL(request.url()).pathname)
            ) {
              sends.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
            }
          });
          const openSession = async (id) => {
            const threadReady = observePendingWait(
              page.waitForResponse(
                (response) => new URL(response.url()).origin === new URL(stack.gatewayUrl).origin && Boolean(matchComposerCoreStateRead(response.request(), id)),
              ),
            );
            await page.goto(
              buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(id)}&shell=cockpit`),
              { waitUntil: "domcontentloaded" },
            );
            const response = await threadReady;
            await readComposerCoreStateResult(response.request(), response, { sessionId: id, workspaceId,
              status: await read(`/api/v1/chat/sessions/${encodeURIComponent(id)}/status`) });
            await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 30_000 });
            assert.equal(new URL(page.url()).searchParams.get("sessionId"), id);
          };
          const switchSession = async (target) => {
            const documentStarted = await page.evaluate(() => performance.timeOrigin);
            const threadReady = observePendingWait(
              page.waitForResponse(
                (response) => new URL(response.url()).origin === new URL(stack.gatewayUrl).origin && Boolean(matchComposerCoreStateRead(response.request(), target.sessionId)),
              ),
            );
            await selectComposerConversation(page, target);
            const response = await threadReady;
            const thread = await readComposerCoreStateResult(response.request(), response, { sessionId: target.sessionId, workspaceId,
              status: await read(`/api/v1/chat/sessions/${encodeURIComponent(target.sessionId)}/status`) });
            // The rail and the phone sheet share this controlled selection (the current row);
            // the URL must agree so reload/back can restore the same conversation.
            await page.waitForURL((url) => url.searchParams.get("sessionId") === target.sessionId);
            const currentLabel = await readCurrentConversation(page, { expectedTitle: target.title });
            assertComposerSelectedScope({
              requestedId: target.sessionId,
              selectedId: currentConversationId(currentLabel, [session, other]),
              threadId: thread.sessionId,
              documentBefore: documentStarted,
              documentAfter: await page.evaluate(() => performance.timeOrigin),
            });
          };
          const draft = page.getByRole("textbox", { name: "Message", exact: true });
          await openSession(sessionId);

          stage = "slash keyboard palette";
          await draft.fill("/sta");
          await chooseKeyboardSuggestion(page, draft, /^\/status\b/u);
          assert.equal((await draft.inputValue()).trim(), "/status");
          assert.equal(sends.length, 0, "Selecting a local command sent a model turn");
          await draft.fill("");

          stage = "callable skill keyboard palette";
          const skills = await read("/api/v1/skills");
          const callable = skills.items?.filter((item) => item.state === "enabled" && item.callable === true) ?? [];
          assert.ok(callable.length, "Gateway has no enabled callable skill; skill keyboard proof cannot be claimed");
          const skill = callable.find((item) => /writing|summari|research/u.test(item.skillId)) ?? callable[0];
          await draft.fill(`$${skill.skillId}`);
          await chooseKeyboardSuggestion(page, draft, new RegExp(`^\\$${escapeRegex(skill.skillId)}(?:\\s|$)`, "u"));
          assert.equal((await draft.inputValue()).trim(), `$${skill.skillId}`);
          evidence.callableSkillId = skill.skillId;
          assert.equal(sends.length, 0, "Skill palette selection unexpectedly sent a turn");
          await draft.fill("");

          stage = "upload file picker and remove";
          const retained = { fileName: `retain-${token}.txt`, content: `Retained synthetic attachment ${token}.` };
          const removed = { fileName: `remove-${token}.txt`, content: `Removed synthetic attachment ${token}.` };
          const uploads = [];
          for (const item of [retained, removed]) {
            const responsePromise = observePendingWait(
              page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === "/api/v1/chat/attachments" &&
                  response.request().method() === "POST" &&
                  new URL(response.url()).searchParams.get("fileName") === item.fileName,
              ),
            );
            const picker = observePendingWait(page.waitForEvent("filechooser"));
            await revealAttachControl(page);
            await page.getByRole("button", { name: "Attach files", exact: true }).click();
            await (
              await picker
            ).setFiles({ name: item.fileName, mimeType: "text/plain", buffer: Buffer.from(item.content) });
            const response = await responsePromise;
            // The phone options sheet is modal; the attachment chips sit beside the draft, outside it.
            await closeComposerOptions(page);
            assert.equal(response.ok(), true, "Picker upload was rejected");
            const record = await response.json();
            assertUploadedAttachment(record, { ...item, sessionId, workspaceId, mimeType: "text/plain" });
            const canonical = await read(`/api/v1/chat/attachments/${encodeURIComponent(record.attachmentId)}`);
            assert.deepEqual(canonical, record);
            uploads.push(record);
            await page.getByRole("button", { name: `Remove ${item.fileName}`, exact: true }).waitFor();
          }
          await page.getByRole("button", { name: `Remove ${removed.fileName}`, exact: true }).click();
          assert.equal(await page.getByRole("button", { name: `Remove ${removed.fileName}`, exact: true }).count(), 0);
          stage = "attachment navigation isolation";
          await switchSession(other);
          assert.equal(
            await page.locator('[aria-label="Attached files"]').count(),
            0,
            "Attachment leaked to another conversation",
          );
          await switchSession(session);
          await page.getByRole("button", { name: `Remove ${retained.fileName}`, exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: `Remove ${removed.fileName}`, exact: true }).count(), 0);

          stage = "at keyboard file attachment";
          const contextUpload = observePendingWait(
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/v1/chat/attachments" &&
                response.request().method() === "POST" &&
                new URL(response.url()).searchParams.get("fileName") === fileName,
            ),
          );
          await draft.fill(`@${fileName}`);
          await chooseKeyboardSuggestion(page, draft, new RegExp(`^${escapeRegex(fileName)}(?:\\s|$)`, "u"));
          const contextResponse = await contextUpload;
          assert.equal(contextResponse.ok(), true);
          const contextAttachment = await contextResponse.json();
          assertUploadedAttachment(contextAttachment, {
            sessionId,
            workspaceId,
            fileName,
            content: fileContent,
            mimeType: "text/plain",
          });
          await page.getByRole("button", { name: `Remove ${fileName}`, exact: true }).waitFor();
          await draft.fill("");

          stage = "review and confirm model";
          await revealComposerOptions(page);
          let prefs = await read(`${sessionPath}/prefs`);
          const config = await read("/api/v1/llm/config");
          const target = config.providers?.find(
            (provider) =>
              provider.providerId !== prefs.providerId &&
              provider.providerId.startsWith("verification-composer-") &&
              provider.defaultModel,
          );
          assert.ok(target, "Composer model switch needs a second isolated verification-composer provider");
          const catalog = await waitForComposerModelCatalog({ page, read, target });
          assert.equal(catalog.source, "live", "Alternate model lacks live owner discovery");
          assert.notEqual(catalog.catalogStatus, "stale", "Alternate model discovery is stale");
          assert.ok(catalog.items?.some((item) => item.id === target.defaultModel));
          prefs = await changePreferences({
            page,
            read,
            sessionPath,
            workspaceId,
            sessionId,
            before: prefs,
            patch: { providerId: target.providerId, model: target.defaultModel },
            select: async () => {
              const options = await openComposerModelOptions(page);
              await options.getByRole("combobox", { name: "Provider", exact: true }).selectOption(target.providerId);
              await closeComposerModelOptions(page, options);
            },
            checkCancel: true,
          });
          const confirmedModelOptions = await openComposerModelOptions(page);
          await waitUntil(
            page,
            async () => (await confirmedModelOptions.getByRole("combobox", { name: "Model", exact: true }).inputValue()) === prefs.model,
            "Composer model did not reconcile the confirmed owner preference",
          );
          assert.equal(await confirmedModelOptions.getByRole("combobox", { name: "Model", exact: true }).inputValue(), prefs.model);
          await closeComposerModelOptions(page, confirmedModelOptions);
          stage = "review and confirm effort";
          await revealComposerOptions(page);
          prefs = await changePreferences({
            page,
            read,
            sessionPath,
            workspaceId,
            sessionId,
            before: prefs,
            patch: { thinkingLevel: prefs.thinkingLevel === "extended" ? "standard" : "extended" },
            select: async () => {
              const options = await openComposerModelOptions(page);
              await options.getByRole("combobox", { name: "Effort", exact: true })
                .selectOption(prefs.thinkingLevel === "extended" ? "standard" : "extended");
              await closeComposerModelOptions(page, options);
            },
          });
          evidence.preferences = {
            providerId: prefs.providerId,
            model: prefs.model,
            thinkingLevel: prefs.thinkingLevel,
            revision: prefs.revision,
          };

          stage = "typed variables invalid and apply";
          await closeComposerOptions(page);
          await draft.fill(`$${packName}`);
          await chooseKeyboardSuggestion(page, draft, new RegExp(`^${escapeRegex(packName)}:`, "u"));
          const panel = page.getByRole("region", { name: "Run variables", exact: true });
          await panel.waitFor();
          const values = { topic: `synthetic-${token}`, count: 2, concise: true, style: "plain" };
          await panel.getByLabel("Proof topic", { exact: false }).fill(values.topic);
          await panel.getByLabel("Proof count", { exact: false }).fill("0");
          await panel.getByLabel("Proof concise", { exact: false }).check();
          await panel.getByLabel("Proof style", { exact: false }).selectOption(values.style);
          await panel.getByRole("alert").waitFor();
          await panel.getByRole("button", { name: "Apply variables", exact: true }).click();
          assert.equal(await panel.count(), 1, "Invalid numeric value was applied");
          assert.equal(sends.length, 0);
          await panel.getByLabel("Proof count", { exact: false }).fill(String(values.count));
          await panel.getByRole("button", { name: "Apply variables", exact: true }).click();
          await panel.waitFor({ state: "hidden" });
          const content = `Composer proof topic=${values.topic}; count=2; concise=true; style=plain.`;
          assert.equal(await draft.inputValue(), content);
          const invocation = {
            ownerKind: "prompt_pack",
            ownerId: pack.packId,
            ownerRevision: pack.updatedAt,
            templateId: template.testId,
            schemaHash: pack.runVariableSchemaHash,
            values,
          };
          await capture("ready-to-send");

          stage = "send exact attachment and typed invocation";
          const send = page.getByRole("button", { name: "Send", exact: true });
          await waitUntil(page, () => send.isEnabled(), "Composer send never became available");
          await send.click();
          let turn;
          await waitUntil(
            page,
            async () => {
              const thread = await read(`${sessionPath}/thread`);
              turn = thread.turns?.find((item) => item.userMessage?.content === content);
              return turn?.trace?.status === "completed";
            },
            "No completed canonical composer turn",
            120,
          );
          assertComposerTurn({
            turn,
            sessionId,
            content,
            attachments: [uploads[0], contextAttachment],
            removedId: uploads[1].attachmentId,
            prefs,
            invocation,
          });
          const outbound = sends.filter(
            (entry) => entry.path.includes(`/${sessionId}/`) && entry.body?.content === content,
          );
          assert.equal(outbound.length, 1, "Composer submission dispatched multiple requests");
          assert.deepEqual(
            outbound[0].body.attachments?.sort(),
            [uploads[0].attachmentId, contextAttachment.attachmentId].sort(),
          );
          assert.deepEqual(outbound[0].body.templateInvocation, invocation);
          assert.equal(outbound[0].body.thinkingLevel, prefs.thinkingLevel);
          evidence.turnId = turn.turnId;
          evidence.attachmentIds = [uploads[0].attachmentId, contextAttachment.attachmentId];

          stage = "personality owner round trip";
          const personalityOwner = await read("/api/v1/personalities");
          const defaultPersonality = personalityOwner.items.find(
            (item) => item.id === personalityOwner.defaultPersonalityId,
          );
          assert.ok(defaultPersonality, "Personality owner has no canonical default");
          const personalityOptions = await openComposerModelOptions(page);
          // The name starts with the visible personality name: "<name> · Open personality settings".
          await personalityOptions.getByRole("button", { name: /· Open personality settings$/u }).click();
          await page.waitForURL(/\/settings\/general\?shell=cockpit#work-personality/u);
          const personalityPanel = page.getByRole("region", { name: "Work personality", exact: true });
          await personalityPanel
            .getByText(`Current global default: ${defaultPersonality.label}`, { exact: true })
            .waitFor();
          await page.goBack({ waitUntil: "domcontentloaded" });
          await draft.waitFor({ timeout: 30_000 });
          assert.equal(new URL(page.url()).searchParams.get("sessionId"), sessionId);
          assert.deepEqual(await read(`${sessionPath}/prefs`), prefs);
          assert.deepEqual(await read("/api/v1/personalities"), personalityOwner);
          evidence.personalityReturn =
            "native installation-wide personality inspection and browser Back preserved conversation";
          stage = "variable close and navigation cleanup";
          await closeComposerOptions(page);
          await draft.fill(`$${packName}`);
          await chooseKeyboardSuggestion(page, draft, new RegExp(`^${escapeRegex(packName)}:`, "u"));
          await panel.getByRole("button", { name: "Close", exact: true }).click();
          await panel.waitFor({ state: "hidden" });
          await draft.fill(`$${packName}`);
          await chooseKeyboardSuggestion(page, draft, new RegExp(`^${escapeRegex(packName)}:`, "u"));
          await panel.waitFor();
          await switchSession(other);
          assert.equal(await panel.count(), 0, "Run variable form leaked to another conversation");
          assert.equal(await page.locator('[aria-label="Attached files"]').count(), 0);
          const foreignThread = await read(`/api/v1/chat/sessions/${encodeURIComponent(other.sessionId)}/thread`);
          assert.equal(foreignThread.turns.length, 0, "Palette navigation sent a foreign-session turn");
          assert.equal(sends.length, 1);
          await switchSession(session);
          await capture("completed");
          if(firstSession){
            stage="first-session opt-in attachment ownership";
            const result=await runCockpitChatFirstSessionProof({context,browser,stack,citadelId,variant,viewport,deps,
              controls:{revealAttachControl,closeComposerOptions},readProviderCounters:firstSession.readProviderCounters});
            evidence.firstSession={entry:"explicit UI New conversation before first attachment",inventory:result.inventory,notExecuted:result.notExecuted,excluded:result.excluded,cases:result.cases,passed:result.passed,delayedSidebarInterleaving:"unit-only; browser not exercised"};
            screenshots.push(...result.screenshots);firstSessionDiagnostics.push(...result.diagnostics);
            if(!result.passed)throw new Error(`First-session opt-in failed: ${result.error??"incomplete cases"}`);
          }
          const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-composer-${variant}.json`);
          await writeFile(diagnostic, `${JSON.stringify(evidence, null, 2)}\n`);
          return {
            status: "passed",
            metrics: {
              uploaded: 3,
              sentAttachments: 2,
              sends: 1,
              typedVariables: 4,
              keyboardPrefixes: "/ @ $",
              blockingAxe: 0,
              personalityReturn: evidence.personalityReturn,
              ...(firstSession?{firstSessionCases:evidence.firstSession.cases.length,firstSessionExplicitCreation:true,delayedSidebarBrowserInterleaving:false}:{}),
            },
            artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic),...firstSessionDiagnostics,...accessibilityDiagnostics] }),
          };

          async function capture(label) {
            await page.addScriptTag({ path: axeSourcePath });
            const audit = await auditPageAccessibility(page);
            try {
              let observations = [], observationGap = false;
              try { observations = await measureComposerAccessibilityTargets(page, audit); }
              catch { observationGap = true; }
              await mkdir(path.join(context.artifactRoot, "diagnostics"), { recursive: true });
              const diagnostic = await captureComposerAccessibilityEvidence({ audit, observations, observationGap, variant, phase: label }, {
                artifactRoot: context.artifactRoot,
                writeJson: (file, payload) => writeFile(file, JSON.stringify(payload, null, 2) + "\n"),
              });
              if (diagnostic.relativePath) accessibilityDiagnostics.push(diagnostic.relativePath);
              if (!diagnostic.complete) (evidence.accessibilityGaps ??= []).push({ phase: label, gapReason: diagnostic.gapReason, counts: diagnostic.counts });
            } catch { (evidence.accessibilityGaps ??= []).push({ phase: label, gapReason: "capture_failure" }); }
            assert.deepEqual(
              audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id),
              [],
            );
            assert.ok(
              (await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              )) <= 1,
              "Composer overflows viewport",
            );
            const directory = path.join(context.artifactRoot, "screenshots");
            await mkdir(directory, { recursive: true });
            const screenshot = path.join(directory, `cockpit-chat-composer-${variant}-${label}.png`);
            await page.screenshot({ path: screenshot, fullPage: false });
            screenshots.push(relativeToRun(context, screenshot));
          }
        } catch (error) {
          await mkdir(path.join(context.artifactRoot, "diagnostics"), { recursive: true });
          await mkdir(path.join(context.artifactRoot, "screenshots"), { recursive: true });
          const diagnostic = path.join(
            context.artifactRoot,
            "diagnostics",
            `cockpit-chat-composer-${variant}-failure.json`,
          );
          const browserScope = page
            ? {
                url: page.url(),
                // The rail's current row; a failure report does not open the phone sheet.
                currentConversation: await page
                  .locator('nav[aria-label="Conversations"] button[aria-current="page"]')
                  .first()
                  .textContent({ timeout: 1_000 })
                  .catch(() => null),
              }
            : undefined;
          await writeFile(
            diagnostic,
            `${JSON.stringify({ stage, ...evidence, browserScope, error: String(error) }, null, 2)}\n`,
          );
          if (page) {
            const failureShot = path.join(
              context.artifactRoot,
              "screenshots",
              `cockpit-chat-composer-${variant}-failure.png`,
            );
            await page
              .screenshot({ path: failureShot, fullPage: false })
              .then(() => screenshots.push(relativeToRun(context, failureShot)))
              .catch(() => {});
          }
          return {
            status: "failed",
            error: `Composer ${variant} failed at ${stage}: ${error.stack ?? error}`,
            metrics: { failedStage: stage },
            artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic),...firstSessionDiagnostics,...accessibilityDiagnostics] }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}

/** Read only the original audit targets immediately before its unchanged blocking assertion. */
async function measureComposerAccessibilityTargets(page, audit) {
  const targets = [];
  const boundedTarget = (value, depth = 0) => depth <= 8 && (typeof value === "string" ? value.length <= 512 : Array.isArray(value) && value.length <= 8 && value.every(item => boundedTarget(item, depth + 1)));
  for (const [ruleIndex, rule] of audit.violations.slice(0, 32).entries()) {
    for (const [nodeIndex, node] of (rule.nodes ?? []).entries()) {
      if (targets.length >= 128) break;
      targets.push({ ruleIndex, nodeIndex, target: boundedTarget(node.target) ? node.target : null });
    }
    if (targets.length >= 128) break;
  }
  if (!targets.length) return [];
  return page.evaluate(rows => rows.map(({ ruleIndex, nodeIndex, target }) => {
    const unresolved = { ruleIndex, nodeIndex, resolved: false };
    try {
      if (!Array.isArray(target) || target.length !== 1) return unresolved;
      const chain = typeof target[0] === "string" ? [target[0]] : target[0];
      if (!Array.isArray(chain) || !chain.length || !chain.every(item => typeof item === "string")) return unresolved;
      let root = document, element;
      for (let index = 0; index < chain.length; index++) {
        const matches = root.querySelectorAll(chain[index]);
        if (matches.length !== 1) return unresolved;
        element = matches[0];
        if (index < chain.length - 1) { root = element.shadowRoot; if (!root) return unresolved; }
      }
      const rect = element.getBoundingClientRect();
      const candidates = element.querySelectorAll('a[href],area[href],button,input,select,textarea,iframe,[tabindex],[contenteditable="true"]');
      if (candidates.length > 512) return unresolved;
      const focusableChildCount = [...candidates].filter(child => {
        const style = getComputedStyle(child);
        return child.tabIndex >= 0 && !child.disabled && !child.hidden && child.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length;
      return { ruleIndex, nodeIndex, resolved: true, tagName: element.tagName.toUpperCase(), role: element.getAttribute("role"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        scroll: { scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight },
        tabIndex: element.tabIndex, focusableChildCount };
    } catch { return unresolved; }
  }), targets);
}

/**
 * Phones fold attach, model, mode, media, sources and commands into the modal "Message options" sheet behind the
 * Options button in the phone "Composer controls" row; wider layouts keep the model chip on the draft's row.
 */
export async function revealComposerOptions(page) {
  const toggle = page.locator('[aria-label="Composer controls"]').getByRole("button", { name: "Options", exact: true });
  if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

/** Model fields live in the deferred chip popup, not directly in phone Options. */
export async function openComposerModelOptions(page) {
  await revealComposerOptions(page);
  const trigger = page.getByRole("button", { name: /· Model and reasoning options$/u });
  assert.equal(await trigger.count(), 1, "Expected one current composer model-options owner");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  let controls;
  await waitUntil(page, async () => {
    controls = await trigger.getAttribute("aria-controls");
    return (await trigger.getAttribute("aria-expanded")) === "true" && typeof controls === "string" && controls.length > 0;
  }, "Current model-options popup did not finish opening");
  assert.match(controls, /^[A-Za-z0-9_:.-]+$/u, "Invalid controlled model-options identity");
  const popup = page.locator(`[id="${controls}"]`);
  await popup.waitFor({ state: "visible" });
  assert.equal(await popup.count(), 1, "Expected exactly the chip's controlled model-options popup");
  assert.equal(await popup.getByRole("heading", { name: "Model and reasoning", exact: true }).count(), 1);
  return popup;
}

export async function closeComposerModelOptions(page, popup) {
  const done = popup.getByRole("button", { name: "Done", exact: true });
  assert.equal(await done.count(), 1, "Expected the owned model-options Done control");
  await done.click();
  await popup.waitFor({ state: "hidden" });
  await closeComposerOptions(page);
}

/**
 * Attach sits in the phone options sheet, or behind the + button on wider layouts. Choosing it closes the + panel,
 * so only the phone sheet needs `closeComposerOptions` afterwards.
 */
export async function revealAttachControl(page) {
  await revealComposerOptions(page);
  const plus = page.locator('[aria-label="Composer controls"]').getByRole("button", {
    name: "Add and options",
    exact: true,
  });
  if ((await plus.count()) && (await plus.getAttribute("aria-expanded")) === "false") await plus.click();
}

/** The options sheet is modal, so phone steps close it before typing in or sending the draft. */
export async function closeComposerOptions(page) {
  const sheet = page.getByRole("dialog", { name: "Message options", exact: true });
  if (!(await sheet.isVisible())) return;
  await sheet.getByRole("button", { name: CLOSE_SHEET, exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
}

/** Exercise the shipped conversation list (desktop rail or phone sheet); page.goto skips React scope persistence. */
export async function selectComposerConversation(page, session) {
  await selectConversation(page, session.title);
}

/** Map the list's current row label back to the one fixture conversation whose title it starts with. */
export function currentConversationId(label, sessions) {
  const matches = sessions.filter((item) => typeof label === "string" && label.startsWith(item.title));
  return matches.length === 1 ? matches[0].sessionId : `unresolved:${label ?? "no current row"}`;
}

async function chooseKeyboardSuggestion(page, draft, name) {
  const list = page.getByRole("listbox", { name: "Composer suggestions" });
  const option = list.getByRole("option", { name });
  await option.waitFor({ timeout: 30_000 });
  const index = await option.evaluate((element) => [...element.parentElement.children].indexOf(element));
  assert.ok(index >= 0 && index < 24, "Expected palette item is outside its bounded keyboard window");
  await draft.focus();
  for (let step = 0; step < 24; step += 1) await draft.press("ArrowUp");
  for (let step = 0; step < index; step += 1) await draft.press("ArrowDown");
  assert.equal(await option.getAttribute("aria-selected"), "true");
  await draft.press("Enter");
}

async function changePreferences({
  page,
  read,
  sessionPath,
  workspaceId,
  sessionId,
  before,
  patch,
  select,
  checkCancel,
}) {
  const created = observePendingWait(
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/change-plans" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.request?.kind === "session_model",
    ),
  );
  await select();
  const response = await created;
  assert.equal(response.ok(), true, `Session model review failed: HTTP ${response.status()} ${await response.text()}`);
  const plan = await response.json();
  assertComposerPlan({ plan, workspaceId, sessionId, before, patch });
  assert.equal(plan.status, "awaiting_confirmation");
  assert.deepEqual(await read(`${sessionPath}/prefs`), before, "Preview already changed canonical preferences");
  const review = page.getByRole("button", { name: "Review and confirm", exact: true });
  await review.click();
  const dialog = page.getByRole("dialog", { name: plan.requiredAction.title, exact: true });
  await dialog.waitFor();
  if (checkCancel) {
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await read(`${sessionPath}/prefs`), before, "Closing review changed canonical preferences");
    await review.click();
  }
  const confirmationPath = `/api/v1/change-plans/${encodeURIComponent(plan.planId)}/confirmations`;
  const confirmed = observePendingWait(
    page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === confirmationPath,
    ),
  );
  await dialog.getByRole("button", { name: "Apply exact change", exact: true }).click();
  const confirmedResponse = await confirmed;
  assert.equal(confirmedResponse.ok(), true, "The exact model confirmation failed.");
  assertComposerConfirmation({
    plan,
    request: confirmedResponse.request().postDataJSON(),
    receipt: await confirmedResponse.json(),
    owner: await read(
      `/api/v1/change-plans/${encodeURIComponent(plan.planId)}?${new URLSearchParams({
        workspaceId,
        sessionId,
        ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
      })}`,
    ),
  });
  let after;
  await waitUntil(
    page,
    async () => {
      after = await read(`${sessionPath}/prefs`);
      return after.revision > before.revision;
    },
    "Confirmed preferences never settled",
  );
  assertComposerPlan({ plan, workspaceId, sessionId, before, patch, after });
  await dialog.waitFor({ state: "hidden" });
  return after;
}

export async function waitForComposerModelCatalog({ page, read, target, attempts = 80 }) {
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 80, "Catalog readiness exceeds the existing finite polling budget");
  let catalog;
  await waitUntil(page, async () => {
    // A stale cache hit starts background refresh; subsequent genuine GETs observe it.
    // Transport exceptions propagate immediately, without a request retry policy.
    catalog = await read(`/api/v1/llm/models?providerId=${encodeURIComponent(target.providerId)}`);
    return catalog.source === "live" && catalog.catalogStatus !== "stale" &&
      catalog.items?.some(item => item.id === target.defaultModel);
  }, "Alternate owned model catalog never became live, nonstale and available", attempts);
  return catalog;
}

async function waitUntil(page, predicate, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await page.waitForTimeout(250);
  }
  throw new Error(message);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Observe rejection before starting an action. Awaiters still receive the original
 * failure, while a failed action can reach its reporting/finally cleanup safely. */
export function observePendingWait(pending) {
  void pending.catch(() => undefined);
  return pending;
}
