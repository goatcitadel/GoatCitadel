import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";

export async function runUxBudgetBoards(environment) {
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
        id: `ux-budgets.cockpit-saved-board-editor.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit saved-board editor ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const boardName = `UX operator board ${variant}`;
        const browserContext = await browser.newContext({
          viewport,
          colorScheme: variant === "mobile" ? "light" : "dark",
        });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/system/dashboards"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.getByRole("button", { name: "New board" }).click();
          const create = page.getByRole("region", { name: "Create board" });
          await create.getByRole("textbox", { name: "Board name" }).fill(boardName);
          for (const kind of [
            "agentic_run_kanban",
            "approval_queue_summary",
            "task_status_summary",
            "usage_cost_summary",
          ]) {
            await create.getByRole("combobox", { name: "Add widget" }).selectOption(kind);
            await create.getByRole("button", { name: "Add", exact: true }).click();
          }
          await create.getByRole("button", { name: "Review new board" }).click();
          await create.getByRole("button", { name: "Confirm save" }).waitFor();
          const before = await requestJson(
            stack.gatewayUrl,
            `/api/v1/ops/boards?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(before, `read ${variant} boards before confirmation`);
          if (before.body?.items?.some((item) => item.name === boardName)) {
            throw new Error(`Saved board ${variant}: review created a canonical board before confirmation.`);
          }
          await page.addScriptTag({ path: axeSourcePath });
          const createAxe = await auditPageAccessibility(page);
          const createBlockingAxe = createAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const createOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (createBlockingAxe.length || !createOverflow.pass) {
            throw new Error(
              `Saved board create ${variant}: accessibility ${createBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${createOverflow.overflow}px`,
            );
          }
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const createShot = path.join(screenshotDir, `ux-budgets-cockpit-saved-board-create-${variant}.png`);
          const editShot = path.join(screenshotDir, `ux-budgets-cockpit-saved-board-edit-${variant}.png`);
          const liveShot = path.join(screenshotDir, `ux-budgets-cockpit-saved-board-live-${variant}.png`);
          await page.screenshot({ path: createShot, fullPage: false });
          await create.getByRole("button", { name: "Confirm save" }).click();
          await page.getByRole("heading", { name: boardName }).waitFor();
          const listed = await requestJson(
            stack.gatewayUrl,
            `/api/v1/ops/boards?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(listed, `read ${variant} created board`);
          const matches = listed.body?.items?.filter((item) => item.name === boardName) ?? [];
          const widgetKinds = [
            "runtime_truth_summary",
            "agentic_run_kanban",
            "approval_queue_summary",
            "task_status_summary",
            "usage_cost_summary",
          ];
          const defaultPositions = [
            [0, 0],
            [6, 0],
            [0, 4],
            [6, 4],
            [0, 8],
          ];
          if (
            matches.length !== 1 ||
            matches[0].revision !== 1 ||
            JSON.stringify(matches[0].placements.map((item) => item.kind)) !== JSON.stringify(widgetKinds) ||
            JSON.stringify(matches[0].placements.map((item) => [item.x, item.y])) !== JSON.stringify(defaultPositions)
          ) {
            throw new Error(`Saved board ${variant}: create did not persist the five-widget two-column layout.`);
          }
          const created = matches[0];
          const [agenticRuns, approvals, health, tasks, cost] = await Promise.all([
            requestJson(
              stack.gatewayUrl,
              `/api/v1/agentic/runs?workspaceId=${encodeURIComponent(fixture.workspaceId)}&limit=200`,
            ),
            requestJson(
              stack.gatewayUrl,
              `/api/v1/approvals?status=pending&limit=200&workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
            ),
            requestJson(stack.gatewayUrl, "/api/v1/observe/health"),
            requestJson(
              stack.gatewayUrl,
              `/api/v1/tasks?limit=200&view=active&workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
            ),
            requestJson(stack.gatewayUrl, "/api/v1/costs/summary?scope=day"),
          ]);
          for (const [source, response] of [
            ["agentic runs", agenticRuns],
            ["approvals", approvals],
            ["health", health],
            ["tasks", tasks],
            ["cost", cost],
          ])
            assertOk(response, `read ${variant} ${source} widget owner`);
          const widgets = Object.fromEntries(
            ["Runtime truth", "Agentic runs", "Approval queue", "Task status", "Usage and cost"].map((title) => [
              title,
              page.getByRole("region", { name: title }),
            ]),
          );
          const metric = (title, label) => widgets[title].getByText(label, { exact: true }).locator("..").locator("dd");
          const expectedMetrics = [
            ["Agentic runs", "Known runs", agenticRuns.body.items.length],
            [
              "Approval queue",
              "Known pending",
              approvals.body.items.filter((item) => item.linkage?.workspaceId === fixture.workspaceId).length,
            ],
            ["Task status", "Known tasks", tasks.body.items.length],
            ["Usage and cost", "Groups", cost.body.items.length],
          ];
          for (const [title, label, expected] of expectedMetrics) {
            await metric(title, label).waitFor();
            const actual = await metric(title, label).innerText();
            if (actual !== String(expected))
              throw new Error(`${title} ${variant}: ${label} showed ${actual}, owner reported ${expected}.`);
          }
          await metric("Runtime truth", "Gateway host").waitFor();
          if (
            (await metric("Runtime truth", "Gateway host").innerText()) !==
            (health.body.systemVitals.hostname || "Unknown")
          ) {
            throw new Error(`Runtime truth ${variant}: host did not match the Gateway owner.`);
          }
          const liveTask = await requestJson(stack.gatewayUrl, "/api/v1/tasks", {
            method: "POST",
            body: { workspaceId: fixture.workspaceId, title: `Live dashboard task ${variant}` },
          });
          assertOk(liveTask, `seed ${variant} live dashboard task`);
          if (liveTask.body?.workspaceId !== fixture.workspaceId)
            throw new Error(`Dashboard task ${variant}: wrong workspace.`);
          await widgets["Task status"].getByRole("button", { name: "Refresh" }).click();
          await page.waitForFunction((expected) => {
            const section = document.querySelector('section[aria-label="Task status"]');
            const label = [...(section?.querySelectorAll("dt") ?? [])].find(
              (item) => item.textContent?.trim() === "Known tasks",
            );
            return label?.nextElementSibling?.textContent?.trim() === String(expected);
          }, tasks.body.items.length + 1);
          const boardAxe = await auditPageAccessibility(page);
          const boardBlockingAxe = boardAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const boardOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (boardBlockingAxe.length || !boardOverflow.pass) {
            throw new Error(
              `Saved board live ${variant}: accessibility ${boardBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${boardOverflow.overflow}px`,
            );
          }
          await page.screenshot({ path: liveShot, fullPage: true });
          await page.getByRole("button", { name: "Edit layout" }).click();
          const edit = page.getByRole("region", { name: "Edit board" });
          const runtimeAdjustment = edit.getByRole("combobox", { name: "Adjust Runtime truth" });
          await runtimeAdjustment.selectOption("wider");
          await runtimeAdjustment.locator("..").locator("..").getByRole("button", { name: "Apply" }).click();
          await edit.getByRole("button", { name: "Review changes" }).click();
          await edit.getByRole("button", { name: "Confirm save" }).waitFor();
          const preEdit = await requestJson(
            stack.gatewayUrl,
            `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(preEdit, `read ${variant} board before edit confirmation`);
          if (preEdit.body?.revision !== created.revision || preEdit.body?.placements[0]?.width !== 6) {
            throw new Error(`Saved board ${variant}: edit review mutated the canonical layout.`);
          }
          const editAxe = await auditPageAccessibility(page);
          const editBlockingAxe = editAxe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const editOverflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (editBlockingAxe.length || !editOverflow.pass) {
            throw new Error(
              `Saved board edit ${variant}: accessibility ${editBlockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${editOverflow.overflow}px`,
            );
          }
          await page.screenshot({ path: editShot, fullPage: false });
          await edit.getByRole("button", { name: "Confirm save" }).click();
          await page.getByText("Saved layout revision 2", { exact: false }).waitFor();
          const updated = await requestJson(
            stack.gatewayUrl,
            `/api/v1/ops/boards/${encodeURIComponent(created.boardId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(updated, `read ${variant} updated board`);
          if (updated.body?.revision !== 2 || updated.body?.placements[0]?.width !== 7) {
            throw new Error(`Saved board ${variant}: edit did not persist the reviewed canonical layout.`);
          }
          return {
            status: "passed",
            metrics: {
              blockingAxe: 0,
              overflow: Math.max(createOverflow.overflow, boardOverflow.overflow, editOverflow.overflow),
              canonicalRevision: updated.body.revision,
              liveWidgets: widgetKinds.length,
            },
            artifacts: emptyArtifacts({
              screenshots: [createShot, liveShot, editShot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
