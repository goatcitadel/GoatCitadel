import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";

export function assertInboxDeliverableProjection({ projection, workspaceId, task, deliverable }) {
  assert.equal(projection.authority, "derived_projection");
  assert.equal(projection.workspaceId, workspaceId);
  assert.ok(projection.items.every((item) => item.source.workspaceId === workspaceId));
  assert.equal(task.workspaceId, workspaceId);
  assert.equal(deliverable.taskId, task.taskId);
  const matches = projection.items.filter((item) => item.id === `task_deliverable:${deliverable.deliverableId}`);
  assert.equal(matches.length, 1);
  const item = matches[0];
  assert.match(item.version, /^[a-f0-9]{64}$/u);
  assert.ok(["operator", "browser_local"].includes(projection.readStatus?.scope));
  const { version: _version, read, ...publicItem } = item;
  if (projection.readStatus.scope === "operator") assert.equal(typeof read, "boolean");
  assert.deepEqual(publicItem, {
    id: `task_deliverable:${deliverable.deliverableId}`,
    kind: "task_deliverable",
    group: "updates",
    title: deliverable.title,
    summary: `A ${deliverable.deliverableType} deliverable was recorded for ${task.title}. Open Kanban to inspect its current record.`,
    createdAt: deliverable.createdAt,
    source: { workspaceId, taskId: task.taskId, deliverableId: deliverable.deliverableId },
    href: `/ops/kanban?shell=classic&taskId=${encodeURIComponent(task.taskId)}`,
  });
  assert.ok(projection.counts.updates.known >= 1);
  assert.equal(projection.counts.updates.complete, false, "Recent deliverables remain a partial view.");
  return item;
}

export function assertInboxOwnerUnchanged(before, after) {
  const stableProjection = ({ generatedAt: _generatedAt, ...projection }) => ({
    ...projection,
    items: projection.items.map((item) => {
      // This rolling coverage warning is authored anew on each Gateway read.
      // All identity, scope, content, coverage, counts and persisted timestamps remain exact.
      if (item.group === "updates") {
        const { read: _read, ...stable } = item;
        return stable;
      }
      if (item.id !== "spend_coverage:seven_days" || item.kind !== "spend_coverage") return item;
      const { createdAt, ...stable } = item;
      assert.ok(Number.isFinite(Date.parse(createdAt)));
      return stable;
    }),
  });
  assert.deepEqual(
    stableProjection(after),
    stableProjection(before),
    "Local viewed state changed the Gateway projection.",
  );
}

export async function finishInboxProof(outcome, cleanupSteps) {
  const errors = [];
  for (const [label, cleanup] of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(`${label}: ${error?.stack ?? error}`);
    }
  }
  return errors.length
    ? {
        ...outcome,
        status: "failed",
        error: [outcome.error, ...errors].filter(Boolean).join("\n"),
        metrics: { ...outcome.metrics, cleanupFailed: true },
      }
    : outcome;
}

/** Real disposable deliverable records; read status is scoped to the operator or explicitly browser-local. */
export async function runCockpitInboxViewedProof({ context, browser, stack, citadelId, viewports, deps }) {
  const {
    requestJson,
    runScenario,
    path,
    buildVerificationUiUrl,
    installMissionControlNextBrowserState,
    auditPageAccessibility,
    axeSourcePath,
    relativeToRun,
    emptyArtifacts,
  } = deps;
  assert.ok(
    stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)),
    "Inbox proof requires an isolated runtime.",
  );
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.body;
  };
  for (const { variant, viewport } of viewports)
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-inbox-viewed.${variant}`,
        lane: "ux-budgets",
        subsystem: "mission-control-ux",
        title: `Inbox scoped versioned read status ${variant}`,
      },
      async () => {
        const screenshots = [],
          writes = [],
          presence = [];
        let outcome,
          page,
          browserContext,
          workspace,
          task,
          deliverable,
          navigations = 0,
          stage = "prepare disposable deliverable";
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        const taskPath = () => `/api/v1/tasks/${encodeURIComponent(task.taskId)}`;
        const query = () => `workspaceId=${encodeURIComponent(workspace.workspaceId)}`;
        const readTask = () => api(`${taskPath()}?${query()}`);
        const readInbox = () => api(`/api/v1/inbox?${query()}`);
        try {
          const suffix = `${variant}-${randomUUID().slice(0, 8)}`;
          workspace = await api("/api/v1/workspaces", {
            method: "POST",
            body: { citadelId, name: `Inbox viewed ${suffix}`, slug: `inbox-viewed-${suffix}` },
          });
          assert.equal(workspace.citadelId, citadelId);
          task = await api("/api/v1/tasks", {
            method: "POST",
            body: {
              workspaceId: workspace.workspaceId,
              title: `Inbox source ${suffix}`,
              description: "Disposable presentation proof; no execution.",
              priority: "normal",
            },
          });
          assert.deepEqual(await readTask(), task);
          deliverable = await api(`${taskPath()}/deliverables?${query()}`, {
            method: "POST",
            body: {
              workspaceId: workspace.workspaceId,
              deliverableType: "artifact",
              title: `Recorded update ${suffix}`,
              description: "Recorded test metadata only; no artifact content or process execution.",
            },
          });
          assert.deepEqual((await api(`${taskPath()}/deliverables?${query()}`)).items, [deliverable]);
          const before = await readInbox();
          const item = assertInboxDeliverableProjection({
            projection: before,
            workspaceId: workspace.workspaceId,
            task,
            deliverable,
          });
          const theme = variant === "mobile" ? "light" : "dark";
          browserContext = await browser.newContext({ viewport, colorScheme: theme });
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, citadelId);
          page = await browserContext.newPage();
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
            const pathname = new URL(request.url()).pathname;
            if (!pathname.startsWith("/api/v1/") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
              return;
            const entry = {
              method: request.method(),
              pathname,
              body: request.postData() ? request.postDataJSON() : null,
            };
            if (pathname === "/api/v1/notifications/presence") {
              entry.completed = request
                .response()
                .then(async (response) => {
                  assert.ok(response);
                  entry.status = response.status();
                  entry.receipt = await response.json();
                })
                .catch((error) => {
                  entry.error = error;
                });
              presence.push(entry);
            } else writes.push(entry);
          });
          await page.route("**/api/v1/**", (route) => {
            const request = route.request(),
              pathname = new URL(request.url()).pathname;
            if (
              ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
              pathname !== "/api/v1/notifications/presence" &&
              pathname !== "/api/v1/inbox/updates/read"
            )
              return route.abort("failed");
            return route.continue();
          });
          await page.goto(
            buildVerificationUiUrl(
              stack.uiUrl,
              `/inbox?shell=cockpit&workspaceId=${encodeURIComponent(workspace.workspaceId)}&item=${encodeURIComponent(item.id)}`,
            ),
            { waitUntil: "domcontentloaded" },
          );
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const row = page
            .locator("[data-inbox-item]")
            .filter({ has: page.getByRole("heading", { name: item.title, exact: true }) });
          const inspector = page.locator(`[aria-label="Inspector: ${item.title}"]`);
          const updates = page.locator('section[aria-labelledby="inbox-updates"]');
          const nav = page.getByRole("navigation", {
            name: variant === "mobile" ? "Areas on small screens" : "Areas",
            exact: true,
          });
          const closeDetails = async () => {
            await page
              .getByRole("button", { name: variant === "mobile" ? "Close sheet" : "Close inspector", exact: true })
              .click();
            await inspector.waitFor({ state: "hidden" });
          };
          stage = "automatic deep link does not mark viewed";
          await inspector.waitFor();
          await closeDetails();
          await row.waitFor();
          const navCount = await nav.getByRole("button", { name: /^Inbox/u }).innerText();
          const ownerCount = before.counts.updates;
          const countLabel = ownerCount.complete ? String(ownerCount.known) : `${ownerCount.known}+`;
          assert.equal(await updates.getByLabel("Updates Gateway count", { exact: true }).innerText(), countLabel);
          assert.ok((await updates.innerText()).includes("0 read from shown updates"));
          const navigationBaseline = navigations;
          stage = "selection leaves the row unviewed";
          await row.getByRole("button", { name: "Details", exact: true }).focus();
          await page.keyboard.press("j");
          await row.waitFor();
          assert.ok((await updates.innerText()).includes("0 read from shown updates"));
          stage = "explicit Details marks the exact version";
          await row.getByRole("button", { name: "Details", exact: true }).click();
          await inspector.waitFor();
          await closeDetails();
          await row.waitFor({ state: "hidden" });
          await updates.getByRole("button", { name: "Show read updates (1)", exact: true }).waitFor();
          assert.equal(await nav.getByRole("button", { name: /^Inbox/u }).innerText(), navCount);
          assert.equal(await updates.getByLabel("Updates Gateway count", { exact: true }).innerText(), countLabel);
          assertInboxOwnerUnchanged(before, await readInbox());
          await capture("hidden");
          stage = "show and hide are reversible";
          await updates.getByRole("button", { name: "Show read updates (1)", exact: true }).click();
          await row.waitFor();
          await updates.getByRole("button", { name: "Hide read updates", exact: true }).click();
          await row.waitFor({ state: "hidden" });
          stage = "same-document remount retains viewed state";
          await nav.getByRole("button", { name: "Work", exact: true }).click();
          await page.getByRole("heading", { name: "Work", exact: true }).waitFor();
          await nav.getByRole("button", { name: /^Inbox/u }).click();
          await updates.getByRole("button", { name: "Show read updates (1)", exact: true }).waitFor();
          await row.waitFor({ state: "hidden" });
          assert.equal(navigations, navigationBaseline);
          assertInboxOwnerUnchanged(before, await readInbox());
          stage = "owner-authored changed version reappears";
          const priorTask = await readTask();
          task = await api(`${taskPath()}?${query()}`, {
            method: "PATCH",
            body: {
              workspaceId: workspace.workspaceId,
              expectedRevision: priorTask.revision,
              title: `Updated source ${suffix}`,
            },
          });
          assert.deepEqual(task, {
            ...priorTask,
            title: `Updated source ${suffix}`,
            revision: priorTask.revision + 1,
            updatedAt: task.updatedAt,
          });
          assert.deepEqual(await readTask(), task);
          const changed = await readInbox();
          const changedItem = assertInboxDeliverableProjection({
            projection: changed,
            workspaceId: workspace.workspaceId,
            task,
            deliverable,
          });
          assert.deepEqual(changedItem, { ...item, summary: changedItem.summary, version: changedItem.version });
          assert.notEqual(changedItem.version, item.version);
          assert.notEqual(changedItem.summary, item.summary);
          assert.deepEqual(changed.counts, before.counts);
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await row.waitFor();
          await row.getByText(changedItem.summary, { exact: true }).waitFor();
          assert.ok((await updates.innerText()).includes("0 read from shown updates"));
          assert.equal(await nav.getByRole("button", { name: /^Inbox/u }).innerText(), navCount);
          await capture("new-version");
          await row.getByRole("button", { name: "Details", exact: true }).click();
          await inspector.waitFor();
          await closeDetails();
          await row.waitFor({ state: "hidden" });
          assertInboxOwnerUnchanged(changed, await readInbox());
          stage = "full reload preserves acknowledged update version";
          await page.reload({ waitUntil: "domcontentloaded" });
          await updates.getByRole("button", { name: "Show read updates (1)", exact: true }).waitFor();
          await row.waitFor({ state: "hidden" });
          assertInboxOwnerUnchanged(changed, await readInbox());
          assert.ok(
            writes.every(
              (entry) =>
                entry.pathname === "/api/v1/inbox/updates/read" &&
                entry.method === "POST" &&
                entry.body.workspaceId === workspace.workspaceId,
            ),
            "Read updates must never resolve approvals or tasks.",
          );
          if (before.readStatus.scope === "operator") {
            assert.ok(writes.length >= 2);
            const receipt = await readInbox();
            assert.equal(receipt.items.find((entry) => entry.id === item.id).read, true);
          } else assert.equal(writes.length, 0);
          const identity = await page.evaluate(() => ({
            workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
            clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"),
            leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id"),
          }));
          await Promise.all(presence.map((entry) => entry.completed));
          for (const entry of presence) {
            if (entry.error) throw entry.error;
            assertCitadelPresenceHeartbeat(entry, identity);
          }
          outcome = {
            status: "passed",
            metrics: {
              actualScopedDeliverable: true,
              exactDetailsOnly: true,
              automaticLinkAndSelectionUnviewed: true,
              gatewayCountsAndSidebarUnchanged: true,
              reversibleShowViewed: true,
              sameDocumentRemount: true,
              newOwnerVersionReappears: true,
              fullReloadPreservesReadStatus: true,
              browserReadStatusWrites: writes.length,
              taskOrApprovalResolutionWrites: 0,
              fixtureTaskTitleCasWrites: 1,
              systemPresenceHeartbeats: presence.length,
              limitation:
                "Recorded task-deliverable metadata in a disposable runtime. No task execution, archive or run completion is claimed; read acknowledgement has no decision authority.",
            },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } catch (error) {
          if (page && !page.isClosed())
            try {
              await mkdir(screenshotDir, { recursive: true });
              const file = path.join(screenshotDir, `ux-budgets-cockpit-inbox-viewed-${variant}-failure.png`);
              await page.screenshot({ path: file });
              screenshots.push(relativeToRun(context, file));
            } catch {
              /* Preserve original failure. */
            }
          outcome = {
            status: "failed",
            error: `${stage}: ${error?.stack ?? error}`,
            artifacts: emptyArtifacts({ screenshots }),
          };
        } finally {
          outcome = await finishInboxProof(outcome, [
            ["Close owned browser context", () => browserContext?.close()],
            [
              "Soft-delete owned task",
              async () => {
                if (task && workspace) {
                  const current = await readTask();
                  if (!current.deletedAt)
                    await api(`${taskPath()}?${query()}&mode=soft`, {
                      method: "DELETE",
                      body: {
                        workspaceId: workspace.workspaceId,
                        expectedRevision: current.revision,
                        mode: "soft",
                        deletedBy: "verification",
                        deleteReason: "End disposable Inbox viewed proof.",
                      },
                    });
                }
              },
            ],
            [
              "Archive owned workspace",
              async () => {
                if (workspace) {
                  const current = (
                    await api(`/api/v1/workspaces?view=all&limit=500&citadelId=${encodeURIComponent(citadelId)}`)
                  ).items.find((item) => item.workspaceId === workspace.workspaceId);
                  if (current?.lifecycleStatus === "active")
                    await api(`/api/v1/workspaces/${encodeURIComponent(current.workspaceId)}/archive`, {
                      method: "POST",
                      body: { expectedRevision: current.revision },
                    });
                }
              },
            ],
          ]);
        }
        return outcome;
        async function capture(name) {
          await page.addScriptTag({ path: axeSourcePath });
          const audit = await auditPageAccessibility(page);
          assert.deepEqual(
            audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id),
            [],
          );
          assert.ok(
            (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <=
              1,
          );
          await mkdir(screenshotDir, { recursive: true });
          const file = path.join(screenshotDir, `ux-budgets-cockpit-inbox-viewed-${variant}-${name}.png`);
          await page.screenshot({ path: file });
          screenshots.push(relativeToRun(context, file));
        }
      },
    );
}
