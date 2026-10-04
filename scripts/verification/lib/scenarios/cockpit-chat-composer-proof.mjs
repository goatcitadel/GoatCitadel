import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  assertComposerConfirmation,
  assertComposerPlan,
  assertComposerSelectedScope,
  assertComposerTurn,
  assertUploadedAttachment,
  composerPackMarkdown,
} from "./cockpit-chat-composer-evidence.mjs";

/** Real browser/owner proof. Requires two configured, reachable disposable provider models. */
export async function runCockpitChatComposerProof({ context, browser, stack, citadelId, viewports, deps }) {
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
            const threadReady = page.waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname === `/api/v1/chat/sessions/${encodeURIComponent(id)}/thread`,
            );
            await page.goto(
              buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(id)}&shell=cockpit`),
              { waitUntil: "domcontentloaded" },
            );
            assert.equal((await threadReady).ok(), true, "Conversation owner could not hydrate the requested scope");
            await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 30_000 });
            assert.equal(new URL(page.url()).searchParams.get("sessionId"), id);
          };
          const switchSession = async (target) => {
            const documentStarted = await page.evaluate(() => performance.timeOrigin);
            const threadReady = page.waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname ===
                  `/api/v1/chat/sessions/${encodeURIComponent(target.sessionId)}/thread`,
            );
            await selectComposerConversation(page, variant, target);
            const response = await threadReady;
            assert.equal(response.ok(), true, "Conversation owner could not hydrate the selected scope");
            const thread = await response.json();
            // Both responsive controls share this controlled selection; the URL
            // must agree so reload/back can restore the same conversation.
            await page.waitForFunction(
              (id) => document.querySelector('select[aria-label="Choose conversation"]')?.value === id,
              target.sessionId,
            );
            await page.waitForURL((url) => url.searchParams.get("sessionId") === target.sessionId);
            assertComposerSelectedScope({
              requestedId: target.sessionId,
              selectedId: await page.locator('select[aria-label="Choose conversation"]').inputValue(),
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
            const responsePromise = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/v1/chat/attachments" &&
                response.request().method() === "POST" &&
                response.request().postDataJSON()?.fileName === item.fileName,
            );
            const picker = page.waitForEvent("filechooser");
            await page.getByRole("button", { name: "Attach files", exact: true }).click();
            await (
              await picker
            ).setFiles({ name: item.fileName, mimeType: "text/plain", buffer: Buffer.from(item.content) });
            const response = await responsePromise;
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
          const contextUpload = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/v1/chat/attachments" &&
              response.request().method() === "POST" &&
              response.request().postDataJSON()?.fileName === fileName,
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
          const catalog = await read(`/api/v1/llm/models?providerId=${encodeURIComponent(target.providerId)}`);
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
            select: () => page.getByRole("combobox", { name: "Provider", exact: true }).selectOption(target.providerId),
            checkCancel: true,
          });
          await revealComposerOptions(page);
          await waitUntil(
            page,
            async () => (await page.getByRole("combobox", { name: "Model", exact: true }).inputValue()) === prefs.model,
            "Composer model did not reconcile the confirmed owner preference",
          );
          assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), prefs.model);
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
            select: () =>
              page
                .getByRole("combobox", { name: "Thinking effort", exact: true })
                .selectOption(prefs.thinkingLevel === "extended" ? "standard" : "extended"),
          });
          evidence.preferences = {
            providerId: prefs.providerId,
            model: prefs.model,
            thinkingLevel: prefs.thinkingLevel,
            revision: prefs.revision,
          };

          stage = "typed variables invalid and apply";
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
          await revealComposerOptions(page);
          await page.getByRole("button", { name: "Open personality settings", exact: true }).click();
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
            },
            artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic)] }),
          };

          async function capture(label) {
            await page.addScriptTag({ path: axeSourcePath });
            const audit = await auditPageAccessibility(page);
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
                selectedSessionId: await page
                  .locator('select[aria-label="Choose conversation"]')
                  .inputValue({ timeout: 1_000 })
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
            artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic)] }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}

/** Phones fold the route and mode controls behind one Options toggle; wider layouts show them inline. */
export async function revealComposerOptions(page) {
  const toggle = page.locator('[aria-label="Composer controls"]').getByRole("button", { name: "Options", exact: true });
  if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

/** Exercise the shipped conversation controls; page.goto skips React scope persistence. */
export async function selectComposerConversation(page, variant, session) {
  if (variant === "mobile") {
    await page.getByRole("combobox", { name: "Choose conversation", exact: true }).selectOption(session.sessionId);
  } else {
    await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .getByRole("button", {
        name: new RegExp(`^${escapeRegex(session.title)}`, "u"),
      })
      .click();
  }
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
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/change-plans" &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.request?.kind === "session_model",
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
  const confirmed = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === confirmationPath,
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
