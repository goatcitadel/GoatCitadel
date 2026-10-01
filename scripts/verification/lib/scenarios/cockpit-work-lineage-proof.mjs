import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";

const CHILD_COUNT = 45;
const DISPLAY_LIMIT = 40;
const FOREIGN_LABEL = "Foreign workspace lineage must be withheld";
const FOREIGN_OUTPUT = "This foreign output must never appear in the Work lineage panel.";
const SYNTHESIS = "Seeded lineage proof: recorded sources are available, but two watched children cannot be verified. This fixture did not execute a delegated turn.";

// Only called with lane-owned Storage, after the real API has created the sessions.
// These are canonical persisted fixtures, not evidence of delegated execution.
export function seedWorkLineageRecords(storage, { workspaceId, sessionId, childSessionId, foreignWorkspaceId, foreignSessionId }) {
  assert.equal(storage.chatSessionMeta.get(sessionId)?.workspaceId, workspaceId);
  assert.equal(storage.chatSessionMeta.get(childSessionId)?.workspaceId, workspaceId);
  assert.equal(storage.chatSessionMeta.get(foreignSessionId)?.workspaceId, foreignWorkspaceId);
  assert.notEqual(foreignWorkspaceId, workspaceId);
  const prefix = `ux-lineage-${randomUUID()}`;
  const parentRunId = `${prefix}-parent`;
  const delegationRunId = `${prefix}-delegation`;
  const now = new Date().toISOString();
  const createRun = (runId, ownerWorkspace, ownerSession, turnId) => {
    const userMessageId = `${turnId}-fixture-message`;
    storage.chatMessages.upsert({ messageId: userMessageId, sessionId: ownerSession, role: "user", actorType: "system",
      actorId: "verification", sourceAuthority: "unknown", content: "Seeded lineage inspection fixture; no delegated turn executed.", timestamp: now });
    storage.durableRuns.createRun({ runId, workflowKey: "chat.turn.execute", status: "completed",
      payload: { workspaceId: ownerWorkspace, sessionId: ownerSession, turnId }, finishedAt: now, now });
    storage.chatTurnTraces.create({ turnId, sessionId: ownerSession, userMessageId, mode: "chat", status: "completed",
      webMode: "off", memoryMode: "off", thinkingLevel: "off", durable: { runId, status: "completed" }, startedAt: now, finishedAt: now });
  };
  createRun(parentRunId, workspaceId, sessionId, `${prefix}-parent-turn`);
  storage.chatDelegationRuns.create({ runId: delegationRunId, parentRunId, sessionId,
    taskId: `${prefix}-task`, objective: "Inspect seeded recorded lineage", roles: ["Coder"], mode: "sequential",
    status: "completed", finalSummary: SYNTHESIS, startedAt: now, finishedAt: now });
  for (let index = 0; index < CHILD_COUNT + 1; index += 1) {
    const foreign = index === CHILD_COUNT;
    const runId = `${prefix}-child-${index}`;
    const stepId = `${prefix}-step-${index}`;
    const turnId = `${prefix}-turn-${index}`;
    const ownerSession = foreign ? foreignSessionId : childSessionId;
    createRun(runId, foreign ? foreignWorkspaceId : workspaceId, ownerSession, turnId);
    storage.chatDelegationSteps.create({ stepId, runId: delegationRunId, role: "Coder", index,
      label: foreign ? FOREIGN_LABEL : `Seeded child ${String(index + 1).padStart(2, "0")}`,
      output: foreign ? FOREIGN_OUTPUT : `Seeded recorded output ${index + 1}. No delegated provider execution is claimed.`,
      status: "completed", durableRunId: runId, childSessionId: ownerSession, childTurnId: turnId,
      startedAt: now, finishedAt: now });
    storage.durableChildWatchers.create({ watcherId: `${prefix}-watcher-${index}`, parentRunId, childRunId: runId,
      source: "chat_delegation", metadata: { delegationRunId, stepId, childSessionId: ownerSession, childTurnId: turnId } });
  }
  const orphanRunId = `${prefix}-orphan`;
  const orphanTurnId = `${prefix}-orphan-turn`;
  createRun(orphanRunId, workspaceId, childSessionId, orphanTurnId);
  storage.durableChildWatchers.create({ watcherId: `${prefix}-orphan-watcher`, parentRunId, childRunId: orphanRunId,
    source: "chat_delegation", metadata: { delegationRunId: `${prefix}-missing`, stepId: `${prefix}-missing-step`,
      childSessionId, childTurnId: orphanTurnId } });
  return { parentRunId, delegationRunId };
}

async function seedFixture(stack, variant, { requestJson, assertOk, path }) {
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),
    "Work lineage proof requires the isolated usability runtime");
  const runtimeRoot = await realpath(stack.runtimeRoot);
  const dbPath = await realpath(path.join(runtimeRoot, "data", "index.db"));
  const relative = path.relative(runtimeRoot, dbPath);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  assert.ok((await stat(dbPath)).isFile());
  const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
    body: { workspaceName: `Seeded Work lineage ${variant}`, sessionTitle: "Seeded lineage parent", sessionCount: 1, longThreadTurns: 2 } });
  assertOk(seeded, "seed lineage workspace");
  const { workspaceId, sessionId } = seeded.body ?? {};
  assert.ok(workspaceId && sessionId);
  const child = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", { method: "POST",
    body: { workspaceId, title: "Seeded lineage child conversation", mode: "chat" } });
  assertOk(child, "create scoped lineage child conversation");
  const foreign = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
    body: { workspaceName: `Foreign lineage ${variant}`, sessionTitle: "Foreign lineage conversation", sessionCount: 1, longThreadTurns: 2 } });
  assertOk(foreign, "seed foreign lineage workspace");
  const { Storage } = await import(new URL("../../../../packages/storage/dist/index.js", import.meta.url));
  const storage = new Storage({ dbPath, transcriptsDir: path.join(runtimeRoot, "data", "transcripts"), auditDir: path.join(runtimeRoot, "data", "audit") });
  try {
    const records = seedWorkLineageRecords(storage, { workspaceId, sessionId, childSessionId: child.body?.sessionId,
      foreignWorkspaceId: foreign.body?.workspaceId, foreignSessionId: foreign.body?.sessionId });
    return { ...records, workspaceId, sessionId, foreignWorkspaceId: foreign.body.workspaceId };
  } finally { storage.close(); }
}

export function visibleLinks(links) {
  return links.flatMap((link) => link.kind === "durable_run"
    ? [{ text: link.label, href: `/work/runs/${encodeURIComponent(link.id)}?shell=cockpit` }]
    : link.kind === "chat_session" ? [{ text: link.label, href: `/chat?sessionId=${encodeURIComponent(link.id)}&shell=cockpit` }] : []);
}

export function assertLineageNativeNavigation({ url, uiUrl, child, trace, selection, workspaceId, citadelId,
  documentRequestsBefore, documentRequestsAfter, marker, expectedMarker, chatHref }) {
  assert.equal(url, new URL(`/work/runs/${encodeURIComponent(child.childRunId)}?shell=cockpit`, uiUrl).href);
  assert.equal(documentRequestsAfter, documentRequestsBefore, "Child run navigation must not request a new document");
  assert.equal(marker, expectedMarker, "Child run navigation must retain the document realm");
  assert.deepEqual(selection, { workspaceId, citadelId });
  assert.equal(trace?.lifecycle?.state, "available");
  assert.equal(trace.lifecycle.response.canonical.runId, child.childRunId);
  assert.equal(trace.lifecycle.response.canonical.sessionId, child.scope.sessionId);
  assert.equal(trace.run.payload.workspaceId, workspaceId);
  assert.equal(chatHref, `/chat?sessionId=${encodeURIComponent(child.scope.sessionId)}&shell=cockpit`);
}

async function renderedLinks(locator) {
  return locator.locator("a").evaluateAll((links) => links.map((link) => ({ text: link.textContent, href: link.getAttribute("href") })));
}

export async function runCockpitWorkLineageProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-work-lineage.${variant}`, lane: "ux-budgets",
      title: `Cockpit seeded canonical lineage ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const fixture = await seedFixture(stack, variant, deps);
      const { parentRunId, workspaceId, sessionId, foreignWorkspaceId } = fixture;
      const ownerPath = `/api/v1/durable/runs/${encodeURIComponent(parentRunId)}/background-tasks`;
      const scope = new URLSearchParams({ workspaceId, sessionId });
      const owner = await requestJson(stack.gatewayUrl, `${ownerPath}?${scope}`);
      assertOk(owner, "read seeded lineage owner");
      const snapshot = owner.body;
      assert.equal(snapshot?.parent?.runId, parentRunId);
      assert.deepEqual(snapshot.scope, { workspaceId, sessionId, verified: true });
      const verified = snapshot.tasks.filter((task) => task.scope.verified);
      assert.equal(verified.length, CHILD_COUNT);
      assert.equal(snapshot.tasks.length - verified.length, 2);
      assert.equal(snapshot.synthesis.availability, "partial");
      assert.equal(snapshot.synthesis.summary, SYNTHESIS);
      assert.equal(snapshot.synthesis.lineage.length, CHILD_COUNT);
      assert.equal(snapshot.synthesis.uncoveredChildRunIds.length, 2);
      assert.equal(snapshot.synthesis.uncoveredStepIds.length, 1);
      const foreign = await requestJson(stack.gatewayUrl, `${ownerPath}?${new URLSearchParams({ workspaceId: foreignWorkspaceId, sessionId })}`);
      assert.equal(foreign.status, 404, "Lineage owner must reject a different workspace");
      const trace = await requestJson(stack.gatewayUrl, `/api/v1/observe/runs/${encodeURIComponent(parentRunId)}/trace`);
      assertOk(trace, "read seeded canonical lineage binding");
      assert.equal(trace.body?.lifecycle?.state, "available", `Seeded lineage lifecycle unavailable: ${String(trace.body?.lifecycle?.error ?? "no owner error").slice(0, 1000)}`);
      assert.equal(trace.body.lifecycle.response.canonical.runId, parentRunId);
      assert.equal(trace.body.lifecycle.response.canonical.sessionId, sessionId);
      assert.equal(trace.body.run.payload.workspaceId, workspaceId);

      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      try {
        await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
        await browserContext.addInitScript((value) => window.localStorage.setItem("goatcitadel.ui.theme.v1", value), theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        const page = await browserContext.newPage();
        const requests = [];
        let documentRequests = 0;
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests += 1;
          if (new URL(request.url()).pathname.startsWith(ownerPath)) requests.push({ url: request.url(), method: request.method() });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/work/runs/${encodeURIComponent(parentRunId)}?shell=cockpit`), { waitUntil: "domcontentloaded" });
        const lineage = page.getByRole("region", { name: "Delegation lineage", exact: true });
        await lineage.waitFor({ timeout: 30_000 });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        assert.equal(requests.length, 0, "Lineage owner reads require explicit inspection");
        await lineage.getByRole("button", { name: "Inspect lineage", exact: true }).click();
        const children = lineage.getByRole("list", { name: "Watched child runs", exact: true });
        await children.waitFor();
        assert.deepEqual(await children.locator("h3").allTextContents(), verified.slice(0, DISPLAY_LIMIT).map((task) => task.label));
        assert.deepEqual(await renderedLinks(children), verified.slice(0, DISPLAY_LIMIT).flatMap((task) => visibleLinks(task.links)));
        for (const task of verified.slice(0, DISPLAY_LIMIT)) await children.getByText(task.output.summary, { exact: true }).waitFor();
        await lineage.getByText("2 child records have unverified scope; details are withheld.", { exact: true }).waitFor();
        await lineage.getByText("5 additional verified children are outside this display.", { exact: true }).waitFor();
        const text = await lineage.textContent();
        assert.ok(!text.includes(FOREIGN_LABEL) && !text.includes(FOREIGN_OUTPUT));
        const synthesis = lineage.getByRole("region", { name: "Recorded synthesis sources", exact: true });
        await synthesis.getByText("Synthesis is partial", { exact: true }).waitFor();
        await synthesis.getByText(SYNTHESIS, { exact: true }).waitFor();
        await synthesis.getByText("5 additional cited sources are outside this display.", { exact: true }).waitFor();
        assert.equal(await synthesis.locator("li").count(), DISPLAY_LIMIT);
        for (const source of snapshot.synthesis.lineage.slice(0, DISPLAY_LIMIT)) {
          await synthesis.getByText(`${source.byteCount} bytes · SHA-256 ${source.sha256}`, { exact: true }).waitFor();
        }
        assert.deepEqual(await renderedLinks(synthesis), snapshot.synthesis.lineage.slice(0, DISPLAY_LIMIT).flatMap((source) => visibleLinks(source.links)));
        assert.ok(requests.length > 0 && requests.every((request) => request.method === "GET"
          && new URL(request.url).pathname === ownerPath && new URL(request.url).searchParams.get("workspaceId") === workspaceId
          && new URL(request.url).searchParams.get("sessionId") === sessionId), "Lineage inspection must use only scoped owner GETs");
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(blocking.length, 0, `Blocking lineage accessibility: ${blocking.map((item) => item.id).join(", ")}`);
        assert.ok(overflow <= 1, `Lineage horizontal overflow: ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshots = [];
        for (const [part, locator] of [["children", lineage], ["synthesis", synthesis]]) {
          await locator.evaluate((node) => node.scrollIntoView({ block: "start" }));
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-work-lineage-${variant}-${part}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          screenshots.push(relativeToRun(context, screenshot));
        }
        const firstChild = verified[0];
        const marker = randomUUID(), documentRequestsBefore = documentRequests;
        await page.evaluate((value) => { window.__lineageNavigationMarker = value; }, marker);
        await children.locator("li").first().getByRole("link", { name: "Child run", exact: true }).click();
        await page.waitForURL(new URL(`/work/runs/${encodeURIComponent(firstChild.childRunId)}?shell=cockpit`, stack.uiUrl).href);
        await page.getByRole("region", { name: "Delegation lineage", exact: true }).waitFor();
        const childChatHref = `/chat?sessionId=${encodeURIComponent(firstChild.scope.sessionId)}&shell=cockpit`;
        const chatLink = page.getByRole("link", { name: "Open this conversation in Chat", exact: true })
          .and(page.locator(`a[href="${childChatHref}"]`));
        await chatLink.waitFor();
        const childTrace = await requestJson(stack.gatewayUrl, `/api/v1/observe/runs/${encodeURIComponent(firstChild.childRunId)}/trace`);
        assertOk(childTrace, "independently read navigated child owner");
        const navigated = await page.evaluate(() => ({ marker: window.__lineageNavigationMarker,
          selection: { workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
            citadelId: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1") } }));
        assertLineageNativeNavigation({ url: page.url(), uiUrl: stack.uiUrl, child: firstChild, trace: childTrace.body,
          ...navigated, workspaceId, citadelId, documentRequestsBefore, documentRequestsAfter: documentRequests,
          expectedMarker: marker, chatHref: await chatLink.getAttribute("href") });
        const foreignContext = await browser.newContext({ viewport, colorScheme: theme });
        try {
          await foreignContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(foreignContext, foreignWorkspaceId, citadelId);
          const foreignPage = await foreignContext.newPage();
          const foreignReads = [];
          foreignPage.on("request", (request) => {
            if (new URL(request.url()).pathname.startsWith(ownerPath)) foreignReads.push(request.url());
          });
          await foreignPage.goto(buildVerificationUiUrl(stack.uiUrl, `/work/runs/${encodeURIComponent(parentRunId)}?shell=cockpit`), { waitUntil: "domcontentloaded" });
          await foreignPage.getByText("Run outside this workspace", { exact: true }).waitFor();
          assert.equal(await foreignPage.getByRole("region", { name: "Delegation lineage", exact: true }).count(), 0);
          assert.equal(foreignReads.length, 0, "Foreign workspace must not inspect parent lineage");
        } finally { await foreignContext.close(); }
        return { status: "passed", metrics: { fixtureKind: "seeded_canonical_lineage", actualDelegationExecuted: false,
          parentRunId, verifiedChildren: CHILD_COUNT, withheldChildren: 2, displayedChildren: DISPLAY_LIMIT,
          displayedSources: DISPLAY_LIMIT, synthesisAvailability: "partial", ownerLinksMatch: true,
          nativeChildNavigation: true, documentReloads: documentRequests - documentRequestsBefore,
          foreignWorkspaceRejected: true, scopedReads: requests.length, blockingAxe: 0, overflow },
        artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
