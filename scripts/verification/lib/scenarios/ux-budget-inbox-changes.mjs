import { CHAT_VIEWPORTS, measureLayout } from "./ux-budget-measurements.mjs";
import { evaluateHorizontalOverflow } from "../ux-budgets.mjs";
import { mkdir } from "node:fs/promises";

export async function runUxBudgetInboxChanges(environment) {
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
        id: `ux-budgets.cockpit-inbox-change-plan.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox change plan ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const mode = variant === "desktop" ? "saver" : "power";
        const created = await requestJson(stack.gatewayUrl, "/api/v1/change-plans", {
          method: "POST",
          body: {
            workspaceId: fixture.workspaceId,
            surface: "settings",
            request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode } },
          },
        });
        assertOk(created, `seed ${variant} Inbox change plan`);
        const seeded = created.body;
        if (
          !seeded?.planId ||
          seeded.status !== "awaiting_confirmation" ||
          seeded.requiredAction?.kind !== "confirmation"
        ) {
          throw new Error("Seeded Inbox change plan is not awaiting its canonical confirmation.");
        }
        const ownerUrl = `/api/v1/change-plans/${encodeURIComponent(seeded.planId)}?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
        const inboxUrl = `/api/v1/inbox?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
        const projected = await requestJson(stack.gatewayUrl, inboxUrl);
        assertOk(projected, `read ${variant} Inbox change plan`);
        const item = projected.body?.items?.find((entry) => entry.id === `change_plan:${seeded.planId}`);
        if (
          !item ||
          item.source?.workspaceId !== fixture.workspaceId ||
          item.source?.planRevision !== seeded.revision ||
          item.source?.planStatus !== seeded.status ||
          item.riskLevel !== seeded.risk
        ) {
          throw new Error("Inbox change plan did not preserve its exact owner revision, status, and risk.");
        }
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ hasText: item.summary });
          await row.getByRole("button", { name: "Details" }).click();
          const detail = page.getByRole("region", { name: "Current change plan" });
          await detail.getByText(seeded.impact).waitFor();
          await page.waitForFunction(() => {
            const rect = document.querySelector('[aria-label="Current change plan"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.top < window.innerHeight - 100 && rect.bottom > 100);
          });
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const reviewShot = path.join(screenshotDir, `ux-budgets-inbox-change-plan-review-${variant}.png`);
          const confirmShot = path.join(screenshotDir, `ux-budgets-inbox-change-plan-confirm-${variant}.png`);
          await page.waitForTimeout(250);
          await page.screenshot({ path: reviewShot, fullPage: false });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Inbox change plan ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          await detail.getByRole("button", { name: "Review confirmation" }).click();
          await page.getByRole("dialog", { name: "Confirm change plan" }).waitFor();
          await page.screenshot({ path: confirmShot, fullPage: false });
          const before = await requestJson(stack.gatewayUrl, ownerUrl);
          assertOk(before, `read ${variant} unconfirmed change plan`);
          if (before.body?.revision !== seeded.revision || before.body?.status !== "awaiting_confirmation") {
            throw new Error("Reviewing the Inbox confirmation changed the canonical plan.");
          }
          await page.getByRole("button", { name: "Confirm change" }).click();
          await detail.getByText("Gateway recorded the request", { exact: false }).waitFor();
          const after = await requestJson(stack.gatewayUrl, ownerUrl);
          assertOk(after, `read ${variant} confirmed change plan`);
          if (after.body?.revision <= seeded.revision || after.body?.status === "awaiting_confirmation") {
            throw new Error("The canonical change plan did not advance after confirmation.");
          }
          const currentInbox = await requestJson(stack.gatewayUrl, inboxUrl);
          assertOk(currentInbox, `read ${variant} confirmed Inbox change plan`);
          if (
            ["completed", "applied"].includes(after.body?.status) &&
            currentInbox.body?.items?.some((entry) => entry.id === item.id)
          ) {
            throw new Error("A completed change plan remained in the current Inbox projection.");
          }
          return {
            status: "passed",
            metrics: { blockingAxe: 0, overflow: overflow.overflow, canonicalStatus: after.body.status },
            artifacts: emptyArtifacts({
              screenshots: [reviewShot, confirmShot].map((shot) => relativeToRun(context, shot)),
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
        id: `ux-budgets.cockpit-inbox-document-proposal.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit Inbox document proposal ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const beforeBody = `Before ${variant} review`;
        const afterBody = `After ${variant} review`;
        const note = await requestJson(stack.gatewayUrl, "/api/v1/notes", {
          method: "POST",
          body: { workspaceId: fixture.workspaceId, title: `Inbox document ${variant}`, body: beforeBody },
        });
        assertOk(note, `seed ${variant} Inbox document target`);
        if (!note.body?.noteId || !note.body?.revision)
          throw new Error("Seeded Inbox document has no owner ID or revision.");
        const created = await requestJson(stack.gatewayUrl, "/api/v1/chat/document-patch-proposals", {
          method: "POST",
          body: {
            workspaceId: fixture.workspaceId,
            targetKind: "personal_note",
            targetId: note.body.noteId,
            baseRevision: note.body.revision,
            proposedContent: afterBody,
          },
        });
        assertOk(created, `seed ${variant} Inbox document proposal`);
        const proposal = created.body?.item;
        if (!proposal?.proposalId || proposal.state !== "pending" || !proposal.derivedDiff?.includes(afterBody)) {
          throw new Error("Seeded Inbox document proposal lacks a pending owner diff.");
        }
        const inboxUrl = `/api/v1/inbox?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
        const proposalUrl = `/api/v1/chat/document-patch-proposals?workspaceId=${encodeURIComponent(fixture.workspaceId)}`;
        const projected = await requestJson(stack.gatewayUrl, inboxUrl);
        assertOk(projected, `read ${variant} Inbox document proposal`);
        const item = projected.body?.items?.find((entry) => entry.id === `document_proposal:${proposal.proposalId}`);
        if (
          !item ||
          item.source?.proposalId !== proposal.proposalId ||
          item.source?.workspaceId !== fixture.workspaceId
        ) {
          throw new Error("Inbox document proposal did not preserve its exact owner and workspace.");
        }
        const decision = variant === "desktop" ? "apply" : "reject";
        const browserContext = await browser.newContext({ viewport, colorScheme: "dark" });
        try {
          await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox"), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page.locator("li[data-inbox-item]").filter({ hasText: item.title });
          await row.getByRole("button", { name: "Details" }).click();
          const detail = page.getByRole("region", { name: "Current document proposal" });
          await detail.getByText(afterBody, { exact: false }).waitFor();
          await page.waitForFunction(() => {
            const rect = document.querySelector('[aria-label="Current document proposal"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.top < window.innerHeight - 100 && rect.bottom > 100);
          });
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          const reviewShot = path.join(screenshotDir, `ux-budgets-inbox-document-review-${variant}.png`);
          const confirmShot = path.join(screenshotDir, `ux-budgets-inbox-document-confirm-${variant}.png`);
          await page.waitForTimeout(250);
          await page.screenshot({ path: reviewShot, fullPage: false });
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          if (blockingAxe.length || !overflow.pass) {
            throw new Error(
              `Inbox document ${variant}: accessibility ${blockingAxe.map((violation) => violation.id).join(", ") || "clear"}; overflow ${overflow.overflow}px`,
            );
          }
          await detail
            .getByRole("button", { name: decision === "apply" ? "Review apply" : "Review rejection" })
            .click();
          await page
            .getByRole("dialog", { name: decision === "apply" ? "Apply document patch" : "Reject document patch" })
            .waitFor();
          await page.screenshot({ path: confirmShot, fullPage: false });
          const before = await requestJson(stack.gatewayUrl, proposalUrl);
          assertOk(before, `read ${variant} unmodified document proposal`);
          if (before.body?.items?.find((entry) => entry.proposalId === proposal.proposalId)?.state !== "pending") {
            throw new Error("Reviewing the Inbox document decision changed its canonical owner state.");
          }
          await page
            .getByRole("button", { name: decision === "apply" ? "Confirm apply" : "Confirm rejection" })
            .click();
          await detail
            .getByText(`Gateway recorded this document proposal as ${decision === "apply" ? "applied" : "rejected"}`, {
              exact: false,
            })
            .waitFor();
          const after = await requestJson(stack.gatewayUrl, proposalUrl);
          assertOk(after, `read ${variant} settled document proposal`);
          if (
            after.body?.items?.find((entry) => entry.proposalId === proposal.proposalId)?.state !==
            (decision === "apply" ? "applied" : "rejected")
          ) {
            throw new Error("The canonical document proposal did not record the Inbox decision.");
          }
          const notes = await requestJson(
            stack.gatewayUrl,
            `/api/v1/notes?workspaceId=${encodeURIComponent(fixture.workspaceId)}`,
          );
          assertOk(notes, `read ${variant} document target`);
          if (
            notes.body?.items?.find((entry) => entry.noteId === note.body.noteId)?.body !==
            (decision === "apply" ? afterBody : beforeBody)
          ) {
            throw new Error("The document target did not match the canonical Inbox decision.");
          }
          const currentInbox = await requestJson(stack.gatewayUrl, inboxUrl);
          assertOk(currentInbox, `read ${variant} settled Inbox proposal`);
          if (currentInbox.body?.items?.some((entry) => entry.id === item.id)) {
            throw new Error("A settled document proposal remained in the Inbox projection.");
          }
          return {
            status: "passed",
            metrics: {
              blockingAxe: 0,
              overflow: overflow.overflow,
              canonicalState: decision === "apply" ? "applied" : "rejected",
            },
            artifacts: emptyArtifacts({
              screenshots: [reviewShot, confirmShot].map((shot) => relativeToRun(context, shot)),
            }),
          };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
