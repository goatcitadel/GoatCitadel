import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { runWorkDraftLeaveProof } from "./cockpit-work-draft-proof.mjs";

// Weekly scheduling is supported by the canonical simple-cron owner.
const FUTURE_SCHEDULE = "0 0 * * 0 UTC";

export function scheduleConfiguration(job) {
  return Object.fromEntries(
    [
      "jobId",
      "revision",
      "name",
      "action",
      "actionConfig",
      "description",
      "schedule",
      "enabled",
      "endAt",
      "workdir",
      "contextFrom",
    ].map((key) => [key, job[key] ?? null]),
  );
}
export function assertScheduleToggle({ before, enabled, request, receipt, owner }) {
  assert.deepEqual(request, { expectedRevision: before.revision });
  assert.deepEqual(receipt, owner);
  assert.ok(owner.revision > before.revision);
  assert.deepEqual(
    scheduleConfiguration(owner),
    scheduleConfiguration({ ...before, enabled, revision: owner.revision }),
  );
  assert.equal(owner.lastRunId, before.lastRunId);
}

/** Future task schedules only. Run-now requests are intercepted before Gateway execution. */
export async function runCockpitScheduleLifecycleProof({
  context,
  browser,
  stack,
  workspaceId,
  citadelId,
  viewports,
  deps,
}) {
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
    "Schedule proof needs a disposable runtime.",
  );
  const api = async (route, init) => {
    const result = await requestJson(stack.gatewayUrl, route, init);
    assert.ok(result.ok, `${route}: ${result.status}`);
    return result.body;
  };
  for (const { variant, viewport } of viewports)
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-schedule-lifecycle.${variant}`,
        lane: "ux-budgets",
        title: `Schedule review, stale cancellation and retained owner lock ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const screenshots = [],
          writes = [],
          presence = [],
          ownedIds = new Set();
        let stage = "prepare isolated schedules",
          page,
          browserContext,
          navigations = 0,
          releaseRead;
        const screenshotDir = path.join(context.artifactRoot, "screenshots"),
          collection = "/api/v1/cron/jobs";
        const routeFor = (id) => `${collection}/${encodeURIComponent(id)}`;
        const read = (id) => api(routeFor(id));
        try {
          const suffix = `${variant}-${randomUUID().slice(0, 8)}`;
          const prior = (await api(collection)).items;
          const seed = await api(collection, {
            method: "POST",
            body: {
              jobId: `ux-schedule-${suffix}`,
              name: `Schedule review ${suffix}`,
              action: "task",
              schedule: FUTURE_SCHEDULE,
              enabled: true,
            },
          });
          ownedIds.add(seed.jobId);
          assert.equal(seed.lastRunId, undefined);
          assert.ok(Date.parse(seed.nextRunAt) > Date.now(), "The fixture schedule must be in the future.");
          const theme = variant === "mobile" ? "light" : "dark";
          browserContext = await browser.newContext({ viewport, colorScheme: theme });
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
          page = await browserContext.newPage();
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
            const pathname = new URL(request.url()).pathname;
            if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/"))
              return;
            const entry = {
              method: request.method(),
              pathname,
              body: request.postData() ? request.postDataJSON() : null,
              query: new URL(request.url()).searchParams.toString(),
            };
            if (entry.method === "PUT" && pathname === "/api/v1/notifications/presence") {
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
          await page.route("**/api/v1/cron/jobs/*/run", (route) => route.abort("failed"));
          await page.route("**/api/v1/tools/invoke", (route) => route.abort("failed"));
          await page.route("**/api/v1/chat/**/agent-send", (route) => route.abort("failed"));
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/work/schedules?shell=cockpit"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
          const selection = () =>
            page.evaluate(() => ({
              workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
              citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"),
            }));
          const initialSelection = await selection();
          const detail = page.locator('[aria-label="Schedule detail"]');
          const select = async (name) => {
            await page.getByRole("button", { name: `Review ${name}`, exact: true }).click();
            await detail.getByRole("heading", { name, exact: true }).waitFor();
          };
          const responseFor = async (method, pathname, action) => {
            const [response] = await Promise.all([
              page.waitForResponse(
                (reply) => reply.request().method() === method && new URL(reply.url()).pathname === pathname,
              ),
              action(),
            ]);
            assert.ok(response.ok(), `${pathname}: ${response.status()}`);
            return {
              receipt: await response.json(),
              request: response.request().postData() ? response.request().postDataJSON() : null,
              query: new URL(response.url()).searchParams,
            };
          };
          stage = "retain or discard all unsent schedule fields without a Gateway write";
          await page.getByRole("button", { name: "New schedule", exact: true }).click();
          const draftForm = page.getByRole("form", { name: "New schedule", exact: true });
          const scheduleDraftProof = await runWorkDraftLeaveProof({
            page, form: draftForm, label: "New schedule",
            fields: [{ label: "Name", value: "Unsent schedule " + suffix },
              { label: "Cron schedule", value: "0 12 * * 1 UTC" },
              { label: "Action", value: "cost_report", select: true }],
            clearedFields: { Name: "", "Cron schedule": "0 9 * * *", Action: "task" },
            destinationLink: page.getByRole("navigation", { name: "Work views", exact: true })
              .getByRole("link", { name: "History", exact: true }),
            destinationPath: "/work/history?shell=cockpit",
            destinationReady: () => page.getByRole("heading", { name: "Work history", exact: true }).waitFor(),
            reopen: () => page.getByRole("button", { name: "New schedule", exact: true }).click(),
            selection, writes, documentCount: () => navigations,
            capture: (name, target) => capture("schedule-create-" + name, target),
          });
          assert.deepEqual(await read(seed.jobId), seed);
          await draftForm.getByRole("button", { name: "Close", exact: true }).click();
          stage = "create a future schedule through the native form";
          await page.getByRole("button", { name: "New schedule", exact: true }).click();
          const form = page.getByRole("form", { name: "New schedule", exact: true });
          const name = `Created schedule ${suffix}`;
          await form.getByLabel("Name", { exact: true }).fill(name);
          await form.getByLabel("Cron schedule", { exact: true }).fill(FUTURE_SCHEDULE);
          const created = await responseFor("POST", collection, () =>
            form.getByRole("button", { name: "Create schedule", exact: true }).click(),
          );
          ownedIds.add(created.receipt.jobId);
          assert.deepEqual(created.request, {
            jobId: created.receipt.jobId,
            name,
            schedule: FUTURE_SCHEDULE,
            action: "task",
            enabled: true,
          });
          assert.deepEqual(await read(created.receipt.jobId), created.receipt);
          await detail.getByRole("heading", { name, exact: true }).waitFor();
          stage = "confirm exact schedule deletion";
          await detail.getByRole("button", { name: "Cancel schedule", exact: true }).click();
          const removed = await responseFor("DELETE", routeFor(created.receipt.jobId), () =>
            detail.getByRole("button", { name: "Confirm cancel", exact: true }).click(),
          );
          assert.deepEqual(removed.receipt, { deleted: true, jobId: created.receipt.jobId });
          assert.equal(removed.query.get("expectedRevision"), String(created.receipt.revision));
          const absent = await requestJson(stack.gatewayUrl, routeFor(created.receipt.jobId));
          assert.equal(absent.status, 404);
          assert.equal(absent.body.error, `Cron job not found: ${created.receipt.jobId}`);
          ownedIds.delete(created.receipt.jobId);
          await select(seed.name);
          stage = "cancel review without a write";
          await detail.getByRole("button", { name: "Pause", exact: true }).click();
          const cancelledWrites = writes.length;
          await detail.getByRole("button", { name: "Keep schedule", exact: true }).click();
          assert.equal(writes.length, cancelledWrites);
          assert.deepEqual(await read(seed.jobId), seed);
          stage = "reject a stale actual owner revision before dispatch";
          await detail.getByRole("button", { name: "Pause", exact: true }).click();
          let current = await api(routeFor(seed.jobId), {
            method: "PATCH",
            body: { expectedRevision: seed.revision, description: "Concurrent fixture metadata edit" },
          });
          const beforeStale = writes.length;
          await detail.getByRole("button", { name: "Confirm pause", exact: true }).click();
          await page
            .getByText(/This schedule changed during review/)
            .first()
            .waitFor();
          assert.equal(writes.length, beforeStale);
          assert.deepEqual(await read(seed.jobId), current);
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await detail.getByText(current.description, { exact: true }).waitFor();
          stage = "pause and resume with exact CAS and independent readback";
          await detail.getByRole("button", { name: "Pause", exact: true }).click();
          let changed = await responseFor("POST", `${routeFor(seed.jobId)}/pause`, () =>
            detail.getByRole("button", { name: "Confirm pause", exact: true }).click(),
          );
          let owner = await read(seed.jobId);
          assertScheduleToggle({ before: current, enabled: false, ...changed, owner });
          current = owner;
          await detail.getByRole("button", { name: "Resume", exact: true }).waitFor();
          await capture("paused", detail);
          await detail.getByRole("button", { name: "Resume", exact: true }).click();
          changed = await responseFor("POST", `${routeFor(seed.jobId)}/start`, () =>
            detail.getByRole("button", { name: "Confirm resume", exact: true }).click(),
          );
          owner = await read(seed.jobId);
          assertScheduleToggle({ before: current, enabled: true, ...changed, owner });
          current = owner;
          await detail.getByRole("button", { name: "Pause", exact: true }).waitFor();
          stage = "cancel an in-flight preflight by navigating away";
          let observedRead;
          const observed = new Promise((resolve) => {
            observedRead = resolve;
          });
          const held = new Promise((resolve) => {
            releaseRead = resolve;
          });
          const holdGet = async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            observedRead();
            await held;
            await route.continue();
          };
          await page.route(`**${routeFor(seed.jobId)}`, holdGet, { times: 1 });
          await detail.getByRole("button", { name: "Run now", exact: true }).click();
          await detail.getByRole("button", { name: "Confirm run", exact: true }).click();
          await observed;
          await page
            .getByRole("navigation", { name: "Work views", exact: true })
            .getByRole("link", { name: "History", exact: true })
            .click();
          const settledRead = page.waitForResponse(
            (reply) => reply.request().method() === "GET" && new URL(reply.url()).pathname === routeFor(seed.jobId),
          );
          releaseRead();
          await settledRead;
          releaseRead = undefined;
          await page
            .getByRole("navigation", { name: "Work views", exact: true })
            .getByRole("link", { name: "Schedules", exact: true })
            .click();
          await select(seed.name);
          assert.equal(
            writes.some((item) => item.pathname.endsWith("/run")),
            false,
          );
          assert.deepEqual(await read(seed.jobId), current);
          stage = "retain a committed response loss across native remount and classic handoff";
          let committed;
          await page.route(
            `**${routeFor(seed.jobId)}/pause`,
            async (route) => {
              const response = await route.fetch();
              assert.ok(response.ok());
              committed = await response.json();
              await route.abort("failed");
            },
            { times: 1 },
          );
          await detail.getByRole("button", { name: "Pause", exact: true }).click();
          await detail.getByRole("button", { name: "Confirm pause", exact: true }).click();
          await page
            .getByText(/action outcome is unconfirmed/)
            .first()
            .waitFor();
          assertScheduleToggle({
            before: current,
            enabled: false,
            request: { expectedRevision: current.revision },
            receipt: committed,
            owner: await read(seed.jobId),
          });
          const nav = page.getByRole("navigation", { name: "Work views", exact: true });
          await nav.getByRole("link", { name: "History", exact: true }).click();
          await nav.getByRole("link", { name: "Schedules", exact: true }).click();
          await select(seed.name);
          // The query cache may still show the pre-request record. Both the old and freshly read controls must stay locked.
          for (const name of ["Run now", "Cancel schedule"])
            assert.equal(await detail.getByRole("button", { name, exact: true }).isDisabled(), true);
          const toggle = detail.getByRole("button", { name: /^(Pause|Resume)$/ });
          assert.equal(await toggle.count(), 1);
          assert.equal(await toggle.isDisabled(), true);
          const refreshed = page.waitForResponse(
            (reply) => reply.request().method() === "GET" && new URL(reply.url()).pathname === routeFor(seed.jobId),
          );
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await refreshed;
          await detail.getByRole("button", { name: "Resume", exact: true }).waitFor();
          for (const action of ["Run now", "Resume", "Cancel schedule"])
            assert.equal(await detail.getByRole("button", { name: action, exact: true }).isDisabled(), true);
          await capture("unknown-native", detail);
          const documentCount = navigations,
            writeCount = writes.length;
          await page.evaluate(() => {
            window.__scheduleRealm = {};
            window.__scheduleRoot = document.getElementById("root");
          });
          await detail.getByRole("link", { name: "Open full schedule controls in Ops", exact: true }).click();
          await page.waitForSelector('html[data-shell="classic"] .mc-next-shell .mc-next-topbar', { timeout: 30_000 });
          await page.getByRole("button", { name: `Inspect schedule ${seed.name}`, exact: true }).click();
          await page
            .getByText(/action outcome is unconfirmed/)
            .first()
            .waitFor();
          assert.equal(
            await page.getByRole("button", { name: `Run ${seed.name} now`, exact: true }).isDisabled(),
            true,
          );
          assert.equal(await page.getByRole("button", { name: `Cancel ${seed.name}`, exact: true }).isDisabled(), true);
          assert.equal(navigations, documentCount);
          assert.equal(writes.length, writeCount);
          assert.ok(
            await page.evaluate(
              () => Boolean(window.__scheduleRealm) && window.__scheduleRoot === document.getElementById("root"),
            ),
          );
          assert.deepEqual(await selection(), initialSelection);
          await capture("unknown-classic", page.locator(".mc-next-detail-inspector"));
          assert.deepEqual(
            writes.map((item) => `${item.method} ${item.pathname}`),
            [
              `POST ${collection}`,
              `DELETE ${routeFor(created.receipt.jobId)}`,
              `POST ${routeFor(seed.jobId)}/pause`,
              `POST ${routeFor(seed.jobId)}/start`,
              `POST ${routeFor(seed.jobId)}/pause`,
            ],
          );
          const final = (await api(collection)).items;
          for (const original of prior)
            assert.deepEqual(
              scheduleConfiguration(final.find((item) => item.jobId === original.jobId)),
              scheduleConfiguration(original),
            );
          assert.equal((await read(seed.jobId)).lastRunId, undefined);
          const expectedPresence = await page.evaluate(() => ({
            workspaceId: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
            clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"),
            leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id"),
          }));
          await Promise.all(presence.map((item) => item.completed));
          for (const item of presence) {
            if (item.error) throw item.error;
            assertCitadelPresenceHeartbeat(item, expectedPresence);
          }
          return {
            status: "passed",
            metrics: {
              actualCreateDeletePauseResume: true,
              scheduleDraftDecisions: scheduleDraftProof,
              exactCasReceiptReadback: true,
              staleWrites: 0,
              cancelledPreflightRunWrites: 0,
              cancelledReviewWrites: 0,
              lostCommittedResponse: true,
              nativeClassicUnknownLock: true,
              sameDocumentHandoff: true,
              noScheduledRunExecuted: true,
              priorConfigurationPreserved: true,
              blockingAxe: 0,
              systemPresenceHeartbeats: presence.length,
              limitation:
                "Disposable future task schedules only. Run endpoints are intercepted; no cron execution is claimed. Existing Run now API has no atomic expectedRevision fence.",
            },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } catch (error) {
          if (page && !page.isClosed())
            try {
              await capture("failure", page.locator("main"));
            } catch {
              /* Preserve original failure. */
            }
          return {
            status: "failed",
            error: `${stage}: ${error?.stack ?? error}`,
            metrics: { failedStage: stage, writes },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } finally {
          releaseRead?.();
          await browserContext?.close();
          for (const id of ownedIds) {
            const result = await requestJson(stack.gatewayUrl, routeFor(id));
            if (result.ok) await api(`${routeFor(id)}?expectedRevision=${result.body.revision}`, { method: "DELETE" });
          }
        }
        async function capture(name, target) {
          await target.scrollIntoViewIfNeeded();
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
          for (const button of await target
            .getByRole("button", {
              name: /^(Run now|Resume|Pause|Cancel schedule|Run Schedule review .+ now|Cancel Schedule review .+)$/u,
            })
            .all()) {
            await button.scrollIntoViewIfNeeded();
            const box = await button.boundingBox();
            assert.ok(
              box && box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.width >= 40 && box.height >= 28,
              "Schedule action is clipped or has no usable hit target.",
            );
          }
          await mkdir(screenshotDir, { recursive: true });
          const file = path.join(screenshotDir, `ux-budgets-cockpit-schedule-lifecycle-${variant}-${name}.png`);
          await page.screenshot({ path: file });
          screenshots.push(relativeToRun(context, file));
        }
      },
    );
}
