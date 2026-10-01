import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { keepWorkDraftOnLeave, runWorkDraftLeaveProof } from "./cockpit-work-draft-proof.mjs";

export function assertTaskCreated({ request, receipt, owner, workspaceId }) {
  assert.deepEqual(receipt, owner);
  assert.equal(request.workspaceId, workspaceId);
  assert.deepEqual(Object.keys(request).sort(), ["description", "priority", "title", "workspaceId"]);
  assert.ok(receipt.taskId && Number.isFinite(Date.parse(receipt.createdAt)));
  assert.deepEqual(receipt, { ...request, taskId: receipt.taskId, revision: 1, status: "inbox",
    createdAt: receipt.createdAt, updatedAt: receipt.createdAt });
}
export function assertTaskChanged({ before, fields, request, receipt, owner, workspaceId }) {
  assert.deepEqual(request, { workspaceId, expectedRevision: before.revision, ...fields });
  assert.deepEqual(receipt, owner);
  assert.ok(Number.isFinite(Date.parse(receipt.updatedAt)));
  assert.deepEqual(receipt, { ...before, ...fields, revision: before.revision + 1, updatedAt: receipt.updatedAt });
  assert.equal(receipt.workspaceId, workspaceId);
  assert.equal(receipt.agenticContext, undefined); assert.equal(receipt.proactiveContext, undefined);
}

export async function waitForTaskDetailsOwner({ page, details, owner, confirmedSave = false }) {
  if (confirmedSave) {
    // The query can publish our receipt before the verified save callback adopts it.
    // Its transient stale button is not a request to replace this successful draft.
    await details.getByText("Gateway recorded the task details. This board edit does not change a running execution.",
      { exact: true }).waitFor();
  } else {
    const load = details.getByRole("button", { name: "Load current details", exact: true });
    if (await load.isVisible()) await load.click();
  }
  await page.waitForFunction(expected => {
    const editor = document.querySelector('section[aria-label="Task details editor"]');
    const title = editor?.querySelector('input[maxlength="160"]');
    const description = editor?.querySelector('textarea[aria-label="Description"]');
    const priority = editor?.querySelector('select[aria-label="Priority"]');
    return window.location.pathname === `/work/tasks/${encodeURIComponent(expected.taskId)}`
      && title?.value === expected.title && !title.disabled
      && description?.value === (expected.description ?? "") && !description.disabled
      && priority?.value === expected.priority && !priority.disabled;
  }, owner);
}

/** Real records only in a fresh disposable workspace; no task run, provider or tool action is dispatched. */
export async function runCockpitTaskLifecycleProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)), "Task proof requires a disposable runtime.");
  const api = async (route, init) => { const result = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(result.ok, `${route}: ${result.status}`); return result.body; };
  for (const { variant, viewport } of viewports) await runScenario(context, {
    id: `ux-budgets.cockpit-task-lifecycle.${variant}`, lane: "ux-budgets", subsystem: "mission-control-ux",
    title: `Task creation, scoped edits and retained mutation locks ${variant}`,
  }, async () => {
    const screenshots = [], writes = [], presence = [], ownedIds = new Set();
    let page, browserContext, workspace, releaseRead, navigations = 0, stage = "prepare isolated workspace";
    const collection = "/api/v1/tasks", screenshotDir = path.join(context.artifactRoot, "screenshots");
    const routeFor = id => `${collection}/${encodeURIComponent(id)}`;
    const read = id => api(`${routeFor(id)}?workspaceId=${encodeURIComponent(workspace.workspaceId)}`);
    try {
      const suffix = `${variant}-${randomUUID().slice(0, 8)}`;
      const priorWorkspaces = (await api(`/api/v1/workspaces?view=all&limit=500&citadelId=${encodeURIComponent(citadelId)}`)).items;
      workspace = await api("/api/v1/workspaces", { method: "POST", body: { citadelId,
        name: `Task lifecycle ${suffix}`, slug: `task-lifecycle-${suffix}` } });
      assert.equal(workspace.citadelId, citadelId);
      const workspaceId = workspace.workspaceId, theme = variant === "mobile" ? "light" : "dark";
      browserContext = await browser.newContext({ viewport, colorScheme: theme });
      await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
        window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
      await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
      page = await browserContext.newPage();
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
        const url = new URL(request.url());
        if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !url.pathname.startsWith("/api/v1/")) return;
        const entry = { method: request.method(), pathname: url.pathname, query: url.searchParams.toString(),
          body: request.postData() ? request.postDataJSON() : null };
        if (entry.method === "PUT" && entry.pathname === "/api/v1/notifications/presence") {
          entry.completed = request.response().then(async response => { assert.ok(response);
            entry.status = response.status(); entry.receipt = await response.json(); }).catch(error => { entry.error = error; });
          presence.push(entry);
        } else writes.push(entry);
      });
      await page.route("**/api/v1/tools/invoke", route => route.abort("failed"));
      await page.route("**/api/v1/chat/**/agent-send", route => route.abort("failed"));
      await page.route("**/api/v1/tasks/*/run", route => route.abort("failed"));
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/work?shell=cockpit"), { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
      const selection = () => page.evaluate(() => ({ workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
        citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1") }));
      const initialSelection = await selection();
      assert.equal(initialSelection.workspace, workspaceId); assert.equal(initialSelection.citadel, citadelId);
      const createPanel = page.getByRole("region", { name: "New task", exact: true });
      const details = page.getByRole("region", { name: "Task details editor", exact: true });
      const status = page.getByRole("region", { name: "Task status", exact: true });
      const assignment = page.getByRole("region", { name: "Task assignment", exact: true });
      const responseFor = async (method, pathname, action) => {
        const [response] = await Promise.all([page.waitForResponse(reply => reply.request().method() === method
          && new URL(reply.url()).pathname === pathname), action()]);
        assert.ok(response.ok()); return { receipt: await response.json(), request: response.request().postDataJSON() };
      };
      const openCreate = async title => {
        await page.getByRole("button", { name: "New task", exact: true }).click();
        await createPanel.getByLabel("Title", { exact: true }).fill(title);
        await createPanel.getByLabel("Description", { exact: true }).fill(`Recorded evidence ${suffix}`);
        await createPanel.getByRole("button", { name: "Review task", exact: true }).click();
      };
      const taskHref = id => `/work/tasks/${encodeURIComponent(id)}`;
      const reopen = async (id, { keepDraft = false } = {}) => {
        const back = () => page.getByRole("link", { name: "Back to Work", exact: true }).click();
        if (keepDraft) await keepWorkDraftOnLeave({ page, action: back, label: "Task details" });
        else await back();
        await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
        await page.locator(`a[href="${taskHref(id)}"]`).click();
        await details.waitFor();
      };
      const adoptCurrentDetails = async (owner, confirmedSave = false) => {
        await page.getByRole("heading", { name: "Description", exact: true }).locator("..")
          .getByText(owner.description, { exact: true }).waitFor();
        await waitForTaskDetailsOwner({ page, details, owner, confirmedSave });
      };
      stage = "retain or discard unsent task creation input without a write";
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const creationDraftProof = await runWorkDraftLeaveProof({
        page, form: createPanel, label: "New task",
        fields: [{ label: "Title", value: "Unsent task " + suffix },
          { label: "Description", value: "Unsent creation evidence " + suffix },
          { label: "Priority", value: "high", select: true }],
        clearedFields: { Title: "", Description: "", Priority: "normal" },
        destinationLink: page.getByRole("navigation", { name: "Work views", exact: true })
          .getByRole("link", { name: "History", exact: true }),
        destinationPath: "/work/history?shell=cockpit",
        destinationReady: () => page.getByRole("heading", { name: "Work history", exact: true }).waitFor(),
        reopen: () => page.getByRole("button", { name: "New task", exact: true }).click(),
        selection, writes, documentCount: () => navigations,
        capture: (name, target) => capture("task-create-" + name, target),
      });
      await createPanel.getByRole("button", { name: "Close", exact: true }).click();
      stage = "review and create the exact task";
      await openCreate(`Task lifecycle ${suffix}`);
      const beforeCancel = writes.length;
      await createPanel.getByRole("button", { name: "Keep editing", exact: true }).click();
      assert.equal(writes.length, beforeCancel);
      await createPanel.getByRole("button", { name: "Review task", exact: true }).click();
      assert.match(await createPanel.innerText(), /no revision precondition/);
      await capture("create-review", createPanel);
      const created = await responseFor("POST", collection, () => createPanel.getByRole("button", { name: "Confirm create", exact: true }).click());
      ownedIds.add(created.receipt.taskId);
      let current = await read(created.receipt.taskId);
      assertTaskCreated({ ...created, owner: current, workspaceId });
      const taskId = current.taskId, taskPath = routeFor(taskId);
      await page.getByRole("heading", { name: current.title, exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, taskHref(taskId));

      stage = "retain or discard unsent task detail fields without changing the actual owner";
      await adoptCurrentDetails(current);
      const detailsDraftProof = await runWorkDraftLeaveProof({
        page, form: details, label: "Task details",
        fields: [{ label: "Title", value: "Unsent detail " + suffix },
          { label: "Description", value: "Unsent detail evidence " + suffix },
          { label: "Priority", value: "urgent", select: true }],
        clearedFields: { Title: current.title, Description: current.description ?? "", Priority: current.priority },
        destinationLink: page.getByRole("link", { name: "Back to Work", exact: true }),
        destinationPath: "/work?shell=cockpit",
        destinationReady: () => page.getByRole("heading", { name: "Work", exact: true }).waitFor(),
        reopen: () => details.waitFor(), selection, writes, documentCount: () => navigations,
        capture: (name, target) => capture("task-detail-" + name, target),
      });
      assert.deepEqual(await read(taskId), current);
      stage = "cancel detail review without mutation";
      await details.getByLabel("Description", { exact: true }).fill(`Updated evidence ${suffix}`);
      await details.getByRole("button", { name: "Review details", exact: true }).click();
      const detailDialog = page.getByRole("dialog", { name: "Confirm task details", exact: true });
      const beforeDetailCancel = writes.length;
      await detailDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(writes.length, beforeDetailCancel); assert.deepEqual(await read(taskId), current);
      await details.getByRole("button", { name: "Review details", exact: true }).click();
      let fields = { title: current.title, description: `Updated evidence ${suffix}`, priority: current.priority };
      let changed = await responseFor("PATCH", taskPath, () => detailDialog.getByRole("button", { name: "Confirm details", exact: true }).click());
      assertTaskChanged({ before: current, fields, ...changed, owner: await read(taskId), workspaceId }); current = changed.receipt;
      await detailDialog.waitFor({ state: "hidden" });
      await adoptCurrentDetails(current, true); await reopen(taskId); await adoptCurrentDetails(current);

      stage = "change status with exact owner CAS";
      await status.getByLabel("Status", { exact: true }).selectOption("blocked");
      await status.getByRole("button", { name: "Review change", exact: true }).click();
      const statusDialog = page.getByRole("dialog", { name: "Change task status", exact: true });
      changed = await responseFor("PATCH", taskPath, () => statusDialog.getByRole("button", { name: "Confirm status change", exact: true }).click());
      assertTaskChanged({ before: current, fields: { status: "blocked" }, ...changed, owner: await read(taskId), workspaceId }); current = changed.receipt;
      await statusDialog.waitFor({ state: "hidden" }); await reopen(taskId); await adoptCurrentDetails(current);
      const agents = (await api("/api/v1/agents?view=active&limit=300")).items;
      const agent = agents.find(item => item.lifecycleStatus === "active");
      let assignmentProof = "No actual active agent was available; assignment was withheld.";
      if (agent) {
        stage = "assign an actual catalog agent without starting a run";
        await assignment.getByLabel("Agent", { exact: true }).selectOption(agent.agentId);
        await assignment.getByRole("button", { name: "Review assignment", exact: true }).click();
        changed = await responseFor("PATCH", taskPath, () => page.getByRole("dialog", { name: "Confirm task assignment", exact: true })
          .getByRole("button", { name: "Confirm assignment", exact: true }).click());
        assertTaskChanged({ before: current, fields: { assignedAgentId: agent.agentId }, ...changed, owner: await read(taskId), workspaceId }); current = changed.receipt;
        await page.getByRole("dialog", { name: "Confirm task assignment", exact: true }).waitFor({ state: "hidden" });
        await reopen(taskId); await adoptCurrentDetails(current);
        assignmentProof = "Actual active catalog agent assigned to the board record only.";
      }
      stage = "reject actual owner change during held preflight";
      await details.getByLabel("Description", { exact: true }).fill(`Stale draft ${suffix}`);
      await details.getByRole("button", { name: "Review details", exact: true }).click();
      let observedRead, finishedRead;
      let observed = new Promise(resolve => { observedRead = resolve; });
      let held = new Promise(resolve => { releaseRead = resolve; });
      let finished = new Promise(resolve => { finishedRead = resolve; });
      const holdGet = async route => { if (route.request().method() !== "GET") return route.continue();
        observedRead(); await held; const response = await route.fetch(); await route.fulfill({ response }); finishedRead(); };
      await page.route(`**${taskPath}?*`, holdGet, { times: 1 });
      const beforeStale = writes.length;
      await detailDialog.getByRole("button", { name: "Confirm details", exact: true }).click(); await observed;
      current = await api(`${taskPath}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "PATCH",
        body: { workspaceId, expectedRevision: current.revision, description: `Concurrent owner edit ${suffix}` } });
      releaseRead(); releaseRead = undefined;
      await finished; await detailDialog.waitFor({ state: "hidden" });
      assert.equal(writes.length, beforeStale); assert.deepEqual(await read(taskId), current);
      await adoptCurrentDetails(current); await reopen(taskId); await adoptCurrentDetails(current);

      stage = "cancel preflight by browser-back route navigation";
      await status.getByLabel("Status", { exact: true }).selectOption("inbox");
      await status.getByRole("button", { name: "Review change", exact: true }).click();
      observed = new Promise(resolve => { observedRead = resolve; }); held = new Promise(resolve => { releaseRead = resolve; });
      finished = new Promise(resolve => { finishedRead = resolve; });
      await page.route(`**${taskPath}?*`, holdGet, { times: 1 });
      const beforeLeave = writes.length;
      await statusDialog.getByRole("button", { name: "Confirm status change", exact: true }).click(); await observed;
      await page.goBack(); await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
      releaseRead(); releaseRead = undefined; await finished;
      await page.locator(`a[href="${taskHref(taskId)}"]`).click(); await details.waitFor();
      assert.equal(writes.length, beforeLeave); assert.deepEqual(await read(taskId), current);

      stage = "retain a real committed task update after response loss";
      let lostUpdate;
      await page.route(`**${taskPath}?*`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        const response = await route.fetch(); assert.ok(response.ok()); lostUpdate = { receipt: await response.json(), request: route.request().postDataJSON() };
        await route.abort("failed");
      });
      await details.getByLabel("Description", { exact: true }).fill(`Lost acknowledgement ${suffix}`);
      await details.getByRole("button", { name: "Review details", exact: true }).click();
      await detailDialog.getByRole("button", { name: "Confirm details", exact: true }).click();
      await details.getByText(/task action outcome is unconfirmed/).waitFor();
      fields = { title: current.title, description: `Lost acknowledgement ${suffix}`, priority: current.priority };
      assertTaskChanged({ before: current, fields, ...lostUpdate, owner: await read(taskId), workspaceId }); current = lostUpdate.receipt;
      await reopen(taskId, { keepDraft: true });
      for (const region of [status, assignment, details]) await region.getByText(/task action outcome is unconfirmed/).waitFor();
      assert.equal(await status.getByRole("button", { name: "Review change", exact: true }).count(), 0);
      assert.equal(await assignment.getByRole("button", { name: "Review assignment", exact: true }).count(), 0);
      assert.equal(await details.getByRole("button", { name: "Review details", exact: true }).count(), 0);
      await capture("unknown-task", details);

      stage = "retain a committed create response loss across shells";
      await keepWorkDraftOnLeave({ page, label: "Task details",
        action: () => page.getByRole("link", { name: "Back to Work", exact: true }).click() });
      let lostCreate;
      await page.route(`**${collection}`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch(); assert.ok(response.ok()); lostCreate = { receipt: await response.json(), request: route.request().postDataJSON() };
        ownedIds.add(lostCreate.receipt.taskId); await route.abort("failed");
      });
      await openCreate(`Lost creation ${suffix}`);
      await createPanel.getByRole("button", { name: "Confirm create", exact: true }).click();
      await createPanel.getByText(/create outcome is unconfirmed/).waitFor();
      assertTaskCreated({ ...lostCreate, owner: await read(lostCreate.receipt.taskId), workspaceId });
      const nav = page.getByRole("navigation", { name: "Work views", exact: true });
      await keepWorkDraftOnLeave({ page, label: "New task",
        action: () => nav.getByRole("link", { name: "History", exact: true }).click() });
      await nav.getByRole("link", { name: "Board", exact: true }).click();
      await page.getByRole("button", { name: "New task", exact: true }).click();
      assert.equal(await createPanel.getByRole("button", { name: "Review task", exact: true }).isDisabled(), true);
      const beforeHandoff = writes.length, documents = navigations;
      await page.evaluate(() => { window.__taskRealm = {}; window.__taskRoot = document.getElementById("root"); });
      await keepWorkDraftOnLeave({ page, label: "New task",
        action: () => createPanel.getByRole("link", { name: "Review current tasks in Ops", exact: true }).click() });
      await page.waitForSelector('html[data-shell="classic"] .mc-next-shell .mc-next-topbar', { timeout: 30_000 });
      await page.getByRole("heading", { name: "Kanban", exact: true }).waitFor();
      await page.getByRole("button", { name: "New task · Unsaved", exact: true }).click();
      const inspector = page.locator(".mc-next-detail-inspector");
      await inspector.getByText(/create outcome is unconfirmed/).waitFor();
      for (const [role, label, value] of [["textbox", "Task title", lostCreate.request.title],
        ["textbox", "Description", lostCreate.request.description], ["combobox", "Priority", lostCreate.request.priority]]) {
        const field = inspector.getByRole(role, { name: label, exact: true });
        assert.equal(await field.inputValue(), value, "Classic handoff changed the exact submitted draft: " + label);
        assert.equal(await field.isDisabled(), true, "Classic handoff unlocked an uncertain creation field: " + label);
      }
      assert.equal(await inspector.getByRole("button", { name: "Create task", exact: true }).isDisabled(), true);
      await keepWorkDraftOnLeave({ page, label: "New task",
        action: () => inspector.getByRole("button", { name: "Close details", exact: true }).click() });
      await page.getByTestId(`kanban-select-${taskId}`).check();
      for (const name of ["Unblock", "Retry", "Close"]) assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
      await page.getByText(/Its mutation lock remains active in both shells/).waitFor();
      assert.equal(navigations, documents); assert.equal(writes.length, beforeHandoff);
      assert.ok(await page.evaluate(() => Boolean(window.__taskRealm) && window.__taskRoot === document.getElementById("root")));
      assert.deepEqual(await selection(), initialSelection);
      await capture("unknown-classic", page.locator('[data-testid="kanban-board"]'));
      assert.deepEqual(writes.map(item => `${item.method} ${item.pathname}`), [`POST ${collection}`, `PATCH ${taskPath}`,
        `PATCH ${taskPath}`, ...(agent ? [`PATCH ${taskPath}`] : []), `PATCH ${taskPath}`, `POST ${collection}`]);
      const finalWorkspaces = (await api(`/api/v1/workspaces?view=all&limit=500&citadelId=${encodeURIComponent(citadelId)}`)).items;
      for (const old of priorWorkspaces) assert.deepEqual(finalWorkspaces.find(item => item.workspaceId === old.workspaceId), old);
      assert.deepEqual(finalWorkspaces.find(item => item.workspaceId === workspaceId), workspace);
      assert.deepEqual(await read(taskId), current);
      const expectedPresence = await page.evaluate(() => ({ workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
        clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"), leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id") }));
      await Promise.all(presence.map(item => item.completed));
      for (const item of presence) { if (item.error) throw item.error; assertCitadelPresenceHeartbeat(item, expectedPresence); }
      return { status: "passed", metrics: { actualCreateDetailsStatus: true, assignmentProof, exactReceiptReadback: true,
        taskCreateDraftDecisions: creationDraftProof, taskDetailsDraftDecisions: detailsDraftProof,
        staleWrites: 0, routeLeaveWrites: 0, reviewCancelWrites: 0, committedUpdateAndCreateResponseLoss: true,
        nativeClassicRetainedLocks: true, sameDocumentHandoff: true, noAgentRunOrToolInvocation: true,
        selectionAndWorkspacePreferencesPreserved: true, blockingAxe: 0, systemPresenceHeartbeats: presence.length,
        limitation: "Disposable task records only. Creation has no CAS/idempotency input. Assignment is board metadata; no agent execution is claimed." }, artifacts: emptyArtifacts({ screenshots }) };
    } catch (error) {
      if (page && !page.isClosed()) try { await capture("failure", page.locator("main")); } catch { /* Preserve original cause. */ }
      return { status: "failed", error: `${stage}: ${error?.stack ?? error}`, metrics: { failedStage: stage, writes }, artifacts: emptyArtifacts({ screenshots }) };
    } finally {
      releaseRead?.(); await browserContext?.close();
      if (workspace) {
        for (const id of ownedIds) {
          const result = await requestJson(stack.gatewayUrl, `${routeFor(id)}?workspaceId=${encodeURIComponent(workspace.workspaceId)}`);
          if (result.ok && !result.body.deletedAt) await api(`${routeFor(id)}?mode=soft&workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
            { method: "DELETE", body: { workspaceId: workspace.workspaceId, expectedRevision: result.body.revision,
              mode: "soft", deletedBy: "verification", deleteReason: "End disposable task lifecycle proof." } });
        }
        const own = (await api(`/api/v1/workspaces?view=all&limit=500&citadelId=${encodeURIComponent(citadelId)}`)).items.find(item => item.workspaceId === workspace.workspaceId);
        if (own?.lifecycleStatus === "active") await api(`/api/v1/workspaces/${encodeURIComponent(own.workspaceId)}/archive`,
          { method: "POST", body: { expectedRevision: own.revision } });
      }
    }
    async function capture(name, target) {
      await target.scrollIntoViewIfNeeded(); await page.addScriptTag({ path: axeSourcePath });
      const audit = await auditPageAccessibility(page);
      assert.deepEqual(audit.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
      for (const button of await target.getByRole("button").all()) {
        if (!await button.isVisible()) continue;
        await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, "A task control extends outside the viewport.");
      }
      await mkdir(screenshotDir, { recursive: true }); const file = path.join(screenshotDir, `ux-budgets-cockpit-task-lifecycle-${variant}-${name}.png`);
      await page.screenshot({ path: file }); screenshots.push(relativeToRun(context, file));
    }
  });
}
