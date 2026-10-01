import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { recordRenderingFixture, RECORDED_OPENCODE_REPORT } from "./cockpit-chat-rendering-records.mjs";

export const RENDER_CODE = "const result: number = 42;\nconsole.log(result);";
export const RENDER_MARKDOWN = ["# Browser rendering proof", "", "**Strong evidence** and _emphasis_.", "",
  "- First recorded item", "- Second recorded item", "", "```ts", RENDER_CODE, "```", "",
  "[Safe fixture reference](https://fixture.example.invalid/rendering)", "",
  "[Unsafe fixture reference](javascript:alert(1))"].join("\n");
export const RENDER_MERMAID = "flowchart LR\n  A[Recorded input] --> B[Visible output]";
export const RENDER_BAD_MERMAID = "this is not a supported diagram syntax";
export function clipboardText(value) { return value.replaceAll("\r\n", "\n"); }
export function renderingReplyRules() {
  // The stub matches all user history: later journey markers take precedence.
  return [{ ruleId: "cockpit-mermaid-invalid", userContentIncludes: "COCKPIT_MERMAID_INVALID", replyText: `\`\`\`mermaid\n${RENDER_BAD_MERMAID}\n\`\`\`` },
    { ruleId: "cockpit-mermaid-valid", userContentIncludes: "COCKPIT_MERMAID_VALID", replyText: `\`\`\`mermaid\n${RENDER_MERMAID}\n\`\`\`` },
    { ruleId: "cockpit-markdown", userContentIncludes: "COCKPIT_RENDER_MARKDOWN", replyText: RENDER_MARKDOWN }];
}
export function assertRenderingArtifact({ artifact, sessionId, workspaceId, turnId, content }) {
  assert.ok(artifact?.artifactId);
  assert.equal(artifact.sessionId, sessionId);
  assert.equal(artifact.workspaceId, workspaceId);
  assert.equal(artifact.turnId, turnId);
  assert.equal(artifact.kind, "mermaid");
  assert.equal(artifact.content, content);
  assert.equal(artifact.contentHash, createHash("sha256").update(content).digest("hex"));
  assert.ok(Number.isInteger(artifact.version) && artifact.version > 0);
}
export function assertRenderingRunLink({ href, sessionId, turn }) {
  assert.equal(turn.trace.sessionId, sessionId);
  const runId = turn.trace.durable?.runId;
  assert.ok(typeof runId === "string" && runId.length > 0);
  assert.equal(href, `/work/runs/${encodeURIComponent(runId)}?shell=cockpit`);
}
export function assertSourceLinks({ citations, rendered, sessionId, turn }) {
  assert.equal(turn.trace.sessionId, sessionId);
  assert.deepEqual(turn.citations, citations);
  const expected = citations.flatMap((item) => {
    try { const url = new URL(item.url); return ["https:", "http:"].includes(url.protocol) ? [{ title: item.title || "Open source", href: url.href }] : []; }
    catch { return []; }
  });
  assert.deepEqual(rendered, expected, "Source links differ from exact recorded turn evidence");
}

export async function runCockpitChatRenderingProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const read = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init); assertOk(result, route); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-chat-rendering.${variant}`, lane: "ux-budgets",
      title: `Cockpit Chat rendering, clipboard and recorded Sources ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const token = randomUUID().slice(0, 8);
      const workspace = await read("/api/v1/workspaces", { method: "POST", body: { name: `Rendering proof ${token}`, ...(citadelId ? { citadelId } : {}) } });
      const workspaceId = workspace.workspaceId;
      assert.ok(workspaceId && workspace.citadelId);
      const session = await read("/api/v1/chat/sessions", { method: "POST", body: { workspaceId, title: `Rendering proof ${token}` } });
      const sessionId = session.sessionId;
      const sessionPath = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark",
        permissions: ["clipboard-read", "clipboard-write"] });
      const screenshots = [];
      const evidence = { workspaceId, sessionId, turnIds: [], artifactIds: [],
        boundary: "Actual deterministic loopback-provider turns and owner-created artifacts. Citation/tool evidence is recorded by the development fixture; this is not live web retrieval or tool execution.",
        unsupported: ["Actual OpenCode process or file effects", "External-provider execution"] };
      let page, stage = "setup";
      try {
        await browserContext.addInitScript((theme) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        }, variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        const sends = [];
        page.on("request", (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === `${sessionPath}/agent-send/stream`) sends.push(request.postDataJSON()?.content);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${sessionId}&shell=cockpit`), { waitUntil: "domcontentloaded" });
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 30_000 });
        stage = "Markdown and code rendering";
        const markdown = await send(`COCKPIT_RENDER_MARKDOWN ${token}`, RENDER_MARKDOWN);
        let article = await findTurn(markdown.userMessage.content);
        await article.getByRole("heading", { name: "Browser rendering proof", exact: true }).waitFor();
        assert.equal(await article.locator("strong").filter({ hasText: /^Strong evidence$/u }).count(), 1);
        assert.equal(await article.locator("em").filter({ hasText: /^emphasis$/u }).count(), 1);
        assert.equal(await article.locator("li").filter({ hasText: "First recorded item" }).count(), 1);
        const code = article.locator('.mc-assistant-code-shell[data-language="ts"]');
        await code.locator("code.hljs .hljs-keyword").first().waitFor({ timeout: 15_000 });
        assert.equal((await code.locator("code").textContent()).trim(), RENDER_CODE);
        assert.equal(await article.getByRole("link", { name: "Safe fixture reference", exact: true }).getAttribute("href"), "https://fixture.example.invalid/rendering");
        assert.equal(await article.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);

        stage = "clipboard readback";
        await code.getByRole("button", { name: "Copy code", exact: true }).click();
        await code.getByRole("button", { name: "Copied", exact: true }).waitFor();
        assert.equal(clipboardText(await page.evaluate(() => navigator.clipboard.readText())), RENDER_CODE);
        await article.getByRole("button", { name: "Copy answer", exact: true }).click();
        await article.getByText("Answer copied.", { exact: true }).waitFor();
        assert.equal(clipboardText(await page.evaluate(() => navigator.clipboard.readText())), clipboardText(markdown.assistantMessage.content));
        await capture("markdown-copy");

        stage = "real Mermaid artifact rendering";
        const diagram = await send(`COCKPIT_MERMAID_VALID ${token}`, `\`\`\`mermaid\n${RENDER_MERMAID}\n\`\`\``);
        const artifact = await saveArtifact(diagram, RENDER_MERMAID);
        const viewer = page.getByRole("region", { name: "Selected artifact", exact: true });
        await viewer.locator(".generated-artifact-mermaid svg").waitFor({ timeout: 30_000 });
        assert.equal(await viewer.locator("svg script, svg foreignObject, svg [onclick]").count(), 0);
        const diagramText = await viewer.locator("svg").textContent();
        assert.match(diagramText, /Recorded input/u); assert.match(diagramText, /Visible output/u);
        await capture("mermaid");
        await closeInspector();

        stage = "recorded source linkage";
        const seeded = await read("/api/v1/dev/verification/chat-attachment-evidence-scenario", { method: "POST", body: { workspaceId, sessionId } });
        assert.equal(seeded.turnId, diagram.turnId);
        const displayFixture = await recordRenderingFixture(stack, { workspaceId, sessionId, turnId: diagram.turnId });
        const thread = await read(`${sessionPath}/thread`);
        const cited = thread.turns.find((item) => item.turnId === diagram.turnId);
        assert.equal(cited.trace.sessionId, sessionId);
        assert.equal(cited.citations.length, 2);
        assert.equal(cited.citations[0].citationId, seeded.citationId);
        assert.equal(cited.citations[1].citationId, displayFixture.citationId);
        const recordedRun = cited.toolRuns.find((item) => item.toolRunId === displayFixture.toolRunId);
        assert.deepEqual(recordedRun.result.externalAgent, RECORDED_OPENCODE_REPORT);
        assert.equal(recordedRun.effectOutcomeKind, "none");
        evidence.recordedCitationId = seeded.citationId;
        evidence.recordedOpenCodeToolRunId = displayFixture.toolRunId;
        await page.reload({ waitUntil: "domcontentloaded" });
        article = await findTurn(diagram.userMessage.content);
        stage = "recorded OpenCode presentation without execution";
        const report = article.getByRole("region", { name: "OpenCode results", exact: true });
        await report.getByRole("heading", { name: "OpenCode report", exact: true }).waitFor();
        await report.getByText(RECORDED_OPENCODE_REPORT.text, { exact: true }).waitFor();
        await report.locator("summary").filter({ hasText: /^Reported files$/u }).click();
        await report.getByText(RECORDED_OPENCODE_REPORT.files[0].path, { exact: false }).waitFor();
        await report.locator("summary").filter({ hasText: /^Preview diff$/u }).click();
        assert.equal(await report.locator("pre").textContent(), RECORDED_OPENCODE_REPORT.files[0].patch);
        assert.equal(await report.locator("script").count(), 0);
        await report.getByText("Diff preview is partial.", { exact: true }).waitFor();
        await report.locator("summary").filter({ hasText: /^Agent steps$/u }).click();
        await report.getByText("Recorded edit attempt", { exact: true }).waitFor();
        await report.getByText("Failed", { exact: true }).waitFor();
        await capture("recorded-opencode");
        await report.getByRole("button", { name: "Open run evidence", exact: true }).click();
        await page.getByRole("tab", { name: "Run", exact: true }).waitFor();
        await closeInspector();
        stage = "safe recorded source linkage";
        await article.locator("summary").filter({ hasText: /^2 sources$/u }).click();
        assertSourceLinks({ citations: cited.citations, turn: cited, sessionId,
          rendered: await article.locator("details").filter({ has: page.locator("summary", { hasText: /^2 sources$/u }) }).locator("a").evaluateAll((links) => links.map((link) => ({ title: link.textContent, href: link.href }))) });
        assert.equal(await article.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);
        await article.getByRole("button", { name: "Run details", exact: true }).click();
        await page.getByRole("tab", { name: "Sources", exact: true }).click();
        const sources = page.getByRole("tabpanel", { name: "Sources", exact: true });
        assertSourceLinks({ citations: cited.citations, turn: cited, sessionId,
          rendered: await sources.getByRole("link").evaluateAll((links) => links.map((link) => ({ title: link.textContent, href: link.href }))) });
        await sources.getByText(cited.citations[0].snippet, { exact: true }).waitFor();
        await sources.getByText(cited.citations[1].snippet, { exact: true }).waitFor();
        assert.equal(await sources.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);
        await capture("recorded-sources");
        await closeInspector();
        stage = "switch to an uncited turn";
        const uncited = thread.turns.find((item) => item.turnId === markdown.turnId);
        assert.deepEqual(uncited.citations, []);
        article = await findTurn(markdown.userMessage.content, "top");
        await article.getByRole("button", { name: "Run details", exact: true }).click();
        await page.getByRole("tab", { name: "Sources", exact: true }).click();
        await sources.getByText("No sources were recorded for this turn.", { exact: true }).waitFor();
        assert.equal(await sources.getByRole("link").count(), 0);
        await closeInspector();

        stage = "invalid Mermaid readable fallback";
        const invalid = await send(`COCKPIT_MERMAID_INVALID ${token}`, `\`\`\`mermaid\n${RENDER_BAD_MERMAID}\n\`\`\``);
        await saveArtifact(invalid, RENDER_BAD_MERMAID);
        await viewer.getByText("Mermaid render failed", { exact: true }).waitFor({ timeout: 30_000 });
        assert.equal(await viewer.locator(".generated-artifact-code-block").textContent(), RENDER_BAD_MERMAID);
        assert.equal(await viewer.locator(".generated-artifact-mermaid svg").count(), 0);
        await capture("mermaid-fallback");
        await closeInspector();
        stage = "recorded terminal delegation display without execution";
        const delegation = await recordRenderingFixture(stack, { workspaceId, sessionId, turnId: invalid.turnId }, "delegation");
        const delegationOwner = await read(`${sessionPath}/delegations/${encodeURIComponent(delegation.runId)}`);
        assert.equal(delegationOwner.run.sessionId, sessionId);
        assert.equal(delegationOwner.run.status, "partial");
        assert.deepEqual(delegationOwner.steps.map((step) => step.stepId), delegation.steps.map((step) => step.stepId));
        const recordedThread = await read(`${sessionPath}/thread`);
        const recordedTurn = recordedThread.turns.find((turn) => turn.turnId === invalid.turnId);
        assert.deepEqual(recordedTurn.trace.durable, invalid.trace.durable);
        assert.equal(recordedTurn.trace.capabilityProfileId, invalid.trace.capabilityProfileId);
        assert.equal(recordedTurn.trace.capabilityProfileHash, invalid.trace.capabilityProfileHash);
        await page.reload({ waitUntil: "domcontentloaded" });
        const runCard = page.getByRole("region", { name: "Conversation run", exact: true });
        await runCard.getByText(delegation.objective, { exact: true }).waitFor();
        await runCard.getByText("Partially complete", { exact: true }).waitFor();
        await runCard.getByRole("button", { name: "Inspect run", exact: true }).click();
        await page.getByRole("tab", { name: "Run", exact: true }).click();
        const runPanel = page.getByRole("tabpanel", { name: "Run", exact: true });
        for (const step of delegation.steps) {
          await runPanel.getByText(step.label, { exact: true }).waitFor();
          await runPanel.getByRole("listitem").filter({ hasText: step.label }).locator("summary").click();
          await runPanel.getByText(step.output, { exact: true }).waitFor();
        }
        assertRenderingRunLink({ sessionId, turn: recordedTurn,
          href: await runPanel.getByRole("link", { name: "Open durable evidence", exact: true }).getAttribute("href") });
        await capture("recorded-delegation");
        await closeInspector();
        article = await findTurn(markdown.userMessage.content, "top");
        await article.getByRole("button", { name: "Run details", exact: true }).click();
        await page.getByRole("tab", { name: "Run", exact: true }).click();
        await runPanel.getByText("No delegation run is linked to this turn.", { exact: true }).waitFor();
        assert.equal(await runPanel.getByText(delegation.objective, { exact: true }).count(), 0);
        await closeInspector();
        evidence.recordedDelegationRunId = delegation.runId;
        assert.deepEqual(sends, [markdown.userMessage.content, diagram.userMessage.content, invalid.userMessage.content]);
        evidence.validArtifactId = artifact.artifactId;
        const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-rendering-${variant}.json`);
        await writeFile(diagnostic, `${JSON.stringify(evidence, null, 2)}\n`);
        return { status: "passed", metrics: { sentTurns: 3, clipboardChecks: 2, mermaidRendered: true, mermaidFallback: true,
          sources: "Recorded fixture with exact turn binding; no live web retrieval", sourceSwitch: true,
          clipboardComparison: "Text content with Windows CRLF normalized to LF",
          unsafeSourceWithheld: true, openCode: "Recorded display-only report; no process or file effects",
          delegation: "Terminal display-only records; no delegated child or worker execution", delegationTurnSwitch: true, blockingAxe: 0 },
          artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic)] }) };
      } catch (error) {
        await mkdir(path.join(context.artifactRoot, "diagnostics"), { recursive: true });
        await mkdir(path.join(context.artifactRoot, "screenshots"), { recursive: true });
        const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-chat-rendering-${variant}-failure.json`);
        await writeFile(diagnostic, `${JSON.stringify({ ...evidence, stage, error: String(error) }, null, 2)}\n`);
        if (page) {
          const screenshot = path.join(context.artifactRoot, "screenshots", `cockpit-chat-rendering-${variant}-failure.png`);
          await page.screenshot({ path: screenshot, fullPage: false }).then(() => screenshots.push(relativeToRun(context, screenshot))).catch(() => {});
        }
        return { status: "failed", error: `${stage}: ${error.stack ?? error}`, metrics: { failedStage: stage },
          artifacts: emptyArtifacts({ screenshots, diagnostics: [relativeToRun(context, diagnostic)] }) };
      } finally { await browserContext.close(); }

      async function send(content, reply) {
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(content);
        const button = page.getByRole("button", { name: "Send", exact: true });
        await poll(() => button.isEnabled(), "Send is unavailable");
        await button.click();
        let turn;
        await poll(async () => { const thread = await read(`${sessionPath}/thread`); turn = thread.turns.find((item) => item.userMessage.content === content); return turn?.trace.status === "completed"; }, "No completed deterministic rendering turn", 120);
        assert.equal(turn.trace.sessionId, sessionId); assert.equal(turn.assistantMessage.content, reply);
        // Trace completion precedes durable finalization; display records need a settled owner snapshot.
        const dispatchedTurn = turn;
        const durableRunId = dispatchedTurn.trace.durable?.runId;
        assert.ok(typeof durableRunId === "string" && durableRunId.length > 0);
        await poll(async () => {
          const run = await read(`/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`);
          assert.equal(run.runId, durableRunId); assert.equal(run.workflowKey, "chat.turn.execute");
          assert.equal(run.payload.workspaceId, workspaceId); assert.equal(run.payload.sessionId, sessionId);
          assert.equal(run.payload.turnId, dispatchedTurn.turnId);
          assert.ok(!["failed", "cancelled", "dead_lettered"].includes(run.status), "Deterministic rendering durable run did not complete successfully");
          const current = (await read(`${sessionPath}/thread`)).turns.find((item) => item.turnId === dispatchedTurn.turnId);
          assert.ok(current, "Completed rendering turn disappeared while its durable run settled");
          assert.equal(current.trace.sessionId, sessionId); assert.equal(current.trace.status, "completed");
          assert.equal(current.userMessage.messageId, dispatchedTurn.userMessage.messageId);
          assert.equal(current.userMessage.content, content);
          assert.equal(current.assistantMessage.messageId, dispatchedTurn.assistantMessage.messageId);
          assert.equal(current.assistantMessage.content, reply);
          assert.equal(current.trace.durable?.runId, durableRunId);
          assert.equal(current.trace.capabilityProfileId, dispatchedTurn.trace.capabilityProfileId);
          assert.equal(current.trace.capabilityProfileHash, dispatchedTurn.trace.capabilityProfileHash);
          if (run.status !== "completed" || current.trace.durable.status !== "completed") return false;
          assert.equal(current.trace.durable.checkpointKind, "run_completed");
          turn = current;
          return true;
        }, "No canonically completed deterministic rendering durable run", 120);
        evidence.turnIds.push(turn.turnId);
        const rendered = await findTurn(content);
        await rendered.getByText("Responding", { exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
        await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
        return turn;
      }
      async function findTurn(content, position = "bottom") {
        const messages = page.locator('[aria-label="Messages"]'); await messages.waitFor({ timeout: 30_000 });
        const scroller = messages.locator('[data-testid="virtuoso-scroller"]');
        await scroller.evaluate((element, top) => { element.scrollTop = top ? 0 : element.scrollHeight; element.dispatchEvent(new window.Event("scroll", { bubbles: true })); }, position === "top");
        const article = messages.getByRole("article", { name: "Conversation turn", exact: true }).filter({ hasText: content });
        await article.waitFor({ timeout: 15_000 }); return article;
      }
      async function saveArtifact(turn, content) {
        const article = await findTurn(turn.userMessage.content);
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === `${sessionPath}/turns/${encodeURIComponent(turn.turnId)}/generated-artifact`);
        await article.getByRole("button", { name: "Save answer", exact: true }).click();
        const response = await responsePromise; assert.equal(response.ok(), true);
        const created = await response.json();
        const owner = await read(`${sessionPath}/generated-artifacts?workspaceId=${encodeURIComponent(workspaceId)}`);
        assert.ok(created.item?.artifactId, "Artifact creation omitted the canonical response envelope");
        assert.ok(owner.items.some((item) => item.artifactId === created.item.artifactId));
        const artifact = (await read(`/api/v1/chat/generated-artifacts/${encodeURIComponent(created.item.artifactId)}?workspaceId=${encodeURIComponent(workspaceId)}`)).item;
        assertRenderingArtifact({ artifact, sessionId, workspaceId, turnId: turn.turnId, content });
        evidence.artifactIds.push(artifact.artifactId);
        await article.getByRole("region", { name: "Saved artifacts", exact: true }).getByRole("button", { name: artifact.title, exact: true }).click();
        await page.getByRole("region", { name: "Selected artifact", exact: true }).waitFor();
        return artifact;
      }
      async function closeInspector() { await page.getByRole("button", { name: variant === "mobile" ? "Close sheet" : "Close inspector", exact: true }).click(); }
      async function poll(predicate, label, limit = 80) {
        for (let index = 0; index < limit; index += 1) { if (await predicate()) return; await page.waitForTimeout(250); }
        throw new Error(label);
      }
      async function capture(label) {
        await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const screenshot = path.join(context.artifactRoot, "screenshots", `cockpit-chat-rendering-${variant}-${label}.png`);
        await mkdir(path.dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
      }
    });
  }
}
