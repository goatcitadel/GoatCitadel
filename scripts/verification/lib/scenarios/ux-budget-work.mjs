import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";

export async function runUxBudgetWork(environment) {
  const { context, browser, stack, fixture, deps } = environment;
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
  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-work-task.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Work task ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const taskTitle = `Review ${variant} Work task`;
        const browserContext = await browser.newContext({
          viewport,
          colorScheme: variant === "mobile" ? "light" : "dark",
        });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/work"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.getByRole("button", { name: "New task" }).click();
          const createPanel = page.locator('section[aria-label="New task"]');
          await createPanel.getByRole("textbox", { name: "Title" }).fill(taskTitle);
          await createPanel.getByRole("textbox", { name: "Description" }).fill(`Inspect the ${variant} task evidence.`);
          await createPanel.getByRole("button", { name: "Review task" }).click();
          await createPanel.getByRole("button", { name: "Confirm create" }).waitFor();
          const beforeCreate = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks?workspaceId=${encodeURIComponent(fixture.workspaceId)}&view=active&limit=200`,
          );
          assertOk(beforeCreate, `read ${variant} tasks before confirmation`);
          if (beforeCreate.body?.items?.some((task) => task.title === taskTitle)) {
            throw new Error(`Work task ${variant}: review created a task before confirmation.`);
          }
          await page.addScriptTag({ path: axeSourcePath });
          const createAxe = await auditPageAccessibility(page);
          const createBlockingAxe = createAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const createOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (createBlockingAxe.length || !createOverflow.pass) {
            throw new Error(
              `Work task create ${variant}: accessibility ${createBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${createOverflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const createShot = path.join(screenshotDir, `ux-budgets-cockpit-work-create-${variant}.png`);
          await page.screenshot({ path: createShot, fullPage: false });
          await createPanel.getByRole("button", { name: "Confirm create" }).click();
          await page.getByRole("heading", { name: taskTitle }).waitFor();
          const taskId = decodeURIComponent(new URL(page.url()).pathname.match(/\/work\/tasks\/([^/]+)$/)?.[1] ?? "");
          if (!taskId) throw new Error(`Work task ${variant}: create did not navigate to a canonical task.`);
          const created = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(created, `read ${variant} created Work task`);
          if (
            created.body?.title !== taskTitle ||
            created.body?.workspaceId !== fixture.workspaceId ||
            created.body?.revision < 1 ||
            created.body?.priority !== "normal"
          ) {
            throw new Error(`Work task ${variant}: create did not persist the reviewed workspace task.`);
          }
          await page
            .getByRole("heading", { name: "Description" })
            .locator("..")
            .getByText(`Inspect the ${variant} task evidence.`, { exact: true })
            .waitFor();
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Work task ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-work-task-${variant}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          const editor = page.locator('section[aria-label="Task details editor"]');
          await editor.getByRole("textbox", { name: "Description" }).fill(`Updated ${variant} task evidence.`);
          await editor.getByRole("combobox", { name: "Priority" }).selectOption("high");
          await editor.getByRole("button", { name: "Review details" }).click();
          const editDialog = page.getByRole("dialog", { name: "Confirm task details" });
          await editDialog.getByRole("button", { name: "Confirm details" }).waitFor();
          const beforeEdit = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(beforeEdit, `read ${variant} task before detail edit`);
          if (beforeEdit.body?.revision !== created.body.revision || beforeEdit.body?.priority !== "normal") {
            throw new Error(`Work task ${variant}: detail review changed the canonical task.`);
          }
          const editAxe = await auditPageAccessibility(page);
          const editBlockingAxe = editAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const editOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (editBlockingAxe.length || !editOverflow.pass) {
            throw new Error(
              `Work task edit ${variant}: accessibility ${editBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${editOverflow.overflow}px`,
            );
          }
          const editShot = path.join(screenshotDir, `ux-budgets-cockpit-work-edit-${variant}.png`);
          await page.screenshot({ path: editShot, fullPage: false });
          await editDialog.getByRole("button", { name: "Confirm details" }).click();
          await page.getByText("Gateway recorded the task details", { exact: false }).waitFor();
          const edited = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(edited, `read ${variant} edited Work task`);
          if (
            edited.body?.revision <= created.body.revision ||
            edited.body?.priority !== "high" ||
            edited.body?.description !== `Updated ${variant} task evidence.`
          ) {
            throw new Error(`Work task ${variant}: detail edit did not update the exact canonical task revision.`);
          }
          await page.getByRole("combobox", { name: "Status" }).selectOption("blocked");
          await page.getByRole("button", { name: "Review change" }).click();
          await page
            .getByRole("dialog", { name: "Change task status" })
            .getByRole("button", { name: "Confirm status change" })
            .click();
          await page.getByText("Gateway recorded blocked", { exact: false }).waitFor();
          const owner = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(owner, `read ${variant} changed Work task`);
          if (owner.body?.status !== "blocked" || owner.body?.revision <= edited.body.revision) {
            throw new Error("Work task status control did not update the exact canonical task revision.");
          }
          const agents = await requestJson(stack.gatewayUrl, "/api/v1/agents?view=active&limit=300");
          assertOk(agents, `read ${variant} active agents`);
          const selectedAgent = agents.body?.items?.find((agent) => agent.lifecycleStatus === "active");
          if (!selectedAgent?.agentId)
            throw new Error(`Work task ${variant}: no active agent is available for assignment proof.`);
          await page.getByRole("combobox", { name: "Agent" }).selectOption(selectedAgent.agentId);
          await page.getByRole("button", { name: "Review assignment" }).click();
          await page
            .getByRole("dialog", { name: "Confirm task assignment" })
            .getByRole("button", { name: "Confirm assignment" })
            .waitFor();
          const beforeAssignment = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(beforeAssignment, `read ${variant} task before assignment`);
          if (beforeAssignment.body?.revision !== owner.body.revision || beforeAssignment.body?.assignedAgentId) {
            throw new Error(`Work task ${variant}: assignment review changed the canonical task.`);
          }
          const assignmentAxe = await auditPageAccessibility(page);
          const assignmentBlockingAxe = assignmentAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const assignmentOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (assignmentBlockingAxe.length || !assignmentOverflow.pass) {
            throw new Error(
              `Work assignment ${variant}: accessibility ${assignmentBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${assignmentOverflow.overflow}px`,
            );
          }
          const assignmentShot = path.join(screenshotDir, `ux-budgets-cockpit-work-assignment-${variant}.png`);
          await page.screenshot({ path: assignmentShot, fullPage: false });
          await page
            .getByRole("dialog", { name: "Confirm task assignment" })
            .getByRole("button", { name: "Confirm assignment" })
            .click();
          await page.getByText("Gateway recorded the task assignment", { exact: false }).waitFor();
          const assigned = await requestJson(
            stack.gatewayUrl,
            `/api/v1/tasks/${encodeURIComponent(taskId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(assigned, `read ${variant} assigned task`);
          if (
            assigned.body?.revision <= owner.body.revision ||
            assigned.body?.assignedAgentId !== selectedAgent.agentId ||
            assigned.body?.status !== "blocked"
          ) {
            throw new Error(`Work task ${variant}: assignment did not update only the canonical board record.`);
          }
          return {
            status: "passed",
            metrics: {
              blockingAxe: 0,
              overflow: Math.max(
                createOverflow.overflow,
                overflow.overflow,
                editOverflow.overflow,
                assignmentOverflow.overflow,
              ),
              canonicalStatus: assigned.body.status,
            },
            artifacts: emptyArtifacts({
              screenshots: [createShot, screenshot, editShot, assignmentShot].map((shot) =>
                relativeToRun(context, shot),
              ),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }

  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-work-schedule.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Work schedule ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const scheduleName = `UX review schedule ${variant}`;
        const browserContext = await browser.newContext({
          viewport,
          colorScheme: variant === "mobile" ? "light" : "dark",
        });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/work/schedules"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.getByRole("button", { name: "New schedule" }).click();
          const form = page.getByRole("form", { name: "New schedule" });
          await form.getByRole("textbox", { name: "Name" }).fill(scheduleName);
          await form.getByRole("combobox", { name: "Action" }).selectOption("cost_report");
          await form.getByRole("button", { name: "Create schedule" }).click();
          await page.getByText("Schedule created. Review its current settings below.").waitFor();
          const listed = await requestJson(stack.gatewayUrl, "/api/v1/cron/jobs");
          assertOk(listed, `read ${variant} schedules after creation`);
          const matches = listed.body?.items?.filter((item) => item.name === scheduleName) ?? [];
          if (matches.length !== 1 || matches[0].revision < 1 || !matches[0].enabled) {
            throw new Error(`Work schedule ${variant}: create did not persist one enabled canonical job.`);
          }
          const created = matches[0];
          const detail = page.getByLabel("Schedule detail");
          await detail.getByRole("heading", { name: scheduleName }).waitFor();
          await detail.getByRole("button", { name: "Pause", exact: true }).click();
          await detail.getByRole("button", { name: "Confirm pause" }).waitFor();
          const before = await requestJson(stack.gatewayUrl, `/api/v1/cron/jobs/${encodeURIComponent(created.jobId)}`);
          assertOk(before, `read ${variant} schedule before confirmation`);
          if (before.body?.revision !== created.revision || !before.body?.enabled) {
            throw new Error(`Work schedule ${variant}: review changed the canonical job before confirmation.`);
          }
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Work schedule ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const reviewShot = path.join(screenshotDir, `ux-budgets-cockpit-work-schedule-review-${variant}.png`);
          const confirmedShot = path.join(screenshotDir, `ux-budgets-cockpit-work-schedule-confirmed-${variant}.png`);
          await page.screenshot({ path: reviewShot, fullPage: false });
          await detail.getByRole("button", { name: "Confirm pause" }).click();
          await page.getByText("Schedule paused.").waitFor();
          const after = await requestJson(stack.gatewayUrl, `/api/v1/cron/jobs/${encodeURIComponent(created.jobId)}`);
          assertOk(after, `read ${variant} paused schedule`);
          if (after.body?.revision <= created.revision || after.body?.enabled !== false) {
            throw new Error(`Work schedule ${variant}: pause did not update the canonical job revision.`);
          }
          await page.screenshot({ path: confirmedShot, fullPage: false });
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow, canonicalRevision: after.body.revision },
            artifacts: emptyArtifacts({
              screenshots: [reviewShot, confirmedShot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
