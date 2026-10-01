import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertIntegrationDialogBounds } from "./cockpit-integration-connections-proof.mjs";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { setFirstRunFixtureAuthBypass } from "./cockpit-first-run-auth-fixture.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";
import {
  assertAdvancedDefaultsReceipt,
  assertAdvancedDemoRecords,
  assertAdvancedFirstRunWrites,
} from "./cockpit-first-run-advanced-assertions.mjs";

const OPERATOR_TOKEN = "verification-ux-budgets-operator-token";

/** Isolated UX runtime only. Real configuration and demo records; no model, approval decision or tool execution. */
export async function runCockpitFirstRunAdvancedProof({ context, browser, stack, citadelId, viewports, deps }) {
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
    "An isolated verification runtime is required.",
  );
  const api = async (route, init = {}) => {
    const result = await requestJson(stack.gatewayUrl, route, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    assert.ok(result.ok, `${route}: ${result.status}`);
    return result.body;
  };
  const readSettings = () => api("/api/v1/settings");
  const readOnboarding = () => api("/api/v1/onboarding/state");
  for (const { variant, viewport } of viewports)
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-first-run-advanced.${variant}`,
        lane: "ux-budgets",
        subsystem: "mission-control-ux",
        title: `Advanced first-run defaults, demo records and retained outcome locks ${variant}`,
      },
      async () => {
        const screenshots = [],
          observers = [],
          writes = [],
          presence = [];
        let page,
          browserContext,
          initialSettings,
          authFixture,
          outcome,
          observerScope = {},
          configured = false,
          navigations = 0,
          stage = "prepare authenticated fixture";
        let defaultsReceipt,
          demoReceipt,
          defaultsIntercepted = 0,
          demoIntercepted = 0,
          staleReads = 0;
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        try {
          initialSettings = await readSettings();
          assert.equal(initialSettings.auth.mode, "token");
          assert.equal(initialSettings.auth.tokenConfigured, true);
          if (initialSettings.auth.allowLoopbackBypass) {
            configured = true;
            authFixture = await setFirstRunFixtureAuthBypass(api, false);
          }
          const configuredSettings = await readSettings();
          assert.equal(configuredSettings.auth.allowLoopbackBypass, false);
          assert.equal(configuredSettings.auth.mode, initialSettings.auth.mode);
          const before = await readOnboarding();
          const theme = variant === "mobile" ? "light" : "dark";
          browserContext = await browser.newContext({ viewport, colorScheme: theme });
          await browserContext.addInitScript(
            ({ theme, token }) => {
              window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
              window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
              window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "session");
              window.sessionStorage.setItem("goatcitadel.gateway.auth", JSON.stringify({ mode: "token", token }));
            },
            { theme, token: OPERATOR_TOKEN },
          );
          await installMissionControlNextBrowserState(browserContext, "default", citadelId);
          page = await browserContext.newPage();
          let demoReads = 0;
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
            const pathname = new URL(request.url()).pathname;
            if (request.method() === "GET" && pathname === "/api/v1/demo/state") demoReads++;
            if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/"))
              return;
            if (recordCockpitObserverRequest(request, observers, observerScope)) return;
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
          await page.route("**/api/v1/tools/invoke", (route) => route.abort("failed"));
          await page.route("**/api/v1/chat/**/agent-send", (route) => route.abort("failed"));
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/first-run?shell=cockpit"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const advanced = page.getByRole("button", { name: "Advanced setup and evidence", exact: true });
          await advanced.waitFor();
          assert.equal(await advanced.getAttribute("aria-expanded"), "false");
          assert.equal(demoReads, 0, "Closed advanced disclosure read the demo owner.");
          const navigationBaseline = navigations;
          await advanced.click();
          const defaults = page.getByRole("region", { name: "Advanced first-run defaults", exact: true });
          const demo = page.getByRole("region", { name: "Local demo setup", exact: true });
          const defaultsReview = page.getByRole("dialog", { name: "Apply first-run defaults", exact: true });
          const demoReview = page.getByRole("dialog", { name: "Prepare local demo", exact: true });
          await defaults.getByRole("button", { name: "Review defaults", exact: true }).waitFor();
          await page.addScriptTag({ path: axeSourcePath });
          const capture = async (name, dialog, labels = []) => {
            if (dialog) {
              const buttons = {};
              for (const label of labels)
                buttons[label] = await dialog.getByRole("button", { name: label, exact: true }).boundingBox();
              assertIntegrationDialogBounds({ viewport, dialog: await dialog.boundingBox(), buttons });
            }
            const audit = await auditPageAccessibility(page);
            assert.equal(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).length, 0);
            assert.ok(
              (await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              )) <= 1,
            );
            await mkdir(screenshotDir, { recursive: true });
            const file = path.join(screenshotDir, `ux-budgets-cockpit-first-run-advanced-${variant}-${name}.png`);
            await page.screenshot({ path: file, fullPage: false });
            screenshots.push(relativeToRun(context, file));
          };
          stage = "review and cancel defaults";
          await defaults.getByRole("button", { name: "Review defaults", exact: true }).click();
          await defaultsReview.waitFor();
          const reviewText = await defaultsReview.innerText();
          assert.ok(reviewText.includes(`Revision: ${before.settings.revision}`));
          assert.ok(reviewText.includes("Loopback auth bypass: off"));
          await capture("defaults-review", defaultsReview, ["Confirm defaults", "Cancel"]);
          await defaultsReview.getByRole("button", { name: "Cancel", exact: true }).click();
          assert.deepEqual(writes, []);
          stage = "contradictory defaults preflight";
          await defaults.getByRole("button", { name: "Review defaults", exact: true }).click();
          const stale = async (route) => {
            const response = await route.fetch(),
              body = await response.json();
            staleReads++;
            await route.fulfill({
              response,
              json: { ...body, settings: { ...body.settings, revision: body.settings.revision + 1 } },
            });
          };
          await page.route("**/api/v1/onboarding/state", stale);
          await defaultsReview.getByRole("button", { name: "Confirm defaults", exact: true }).click();
          await defaults.getByText(/Settings reads disagree|Defaults changed during review/u).waitFor();
          await page.unroute("**/api/v1/onboarding/state", stale);
          assert.ok(staleReads > 0);
          assert.deepEqual(writes, []);
          stage = "confirm unchanged defaults with real numeric CAS";
          await defaults.getByRole("button", { name: "Review defaults", exact: true }).click();
          const [response] = await Promise.all([
            page.waitForResponse(
              (item) => item.url().endsWith("/api/v1/onboarding/bootstrap") && item.request().method() === "POST",
            ),
            defaultsReview.getByRole("button", { name: "Confirm defaults", exact: true }).click(),
          ]);
          assert.ok(response.ok());
          defaultsReceipt = await response.json();
          const after = await readOnboarding();
          assertAdvancedDefaultsReceipt({ before, request: writes[0].body, receipt: defaultsReceipt, after });
          await defaults.getByRole("button", { name: "Refresh defaults", exact: true }).click();
          stage = "retain unknown defaults outcome";
          await defaults.getByRole("button", { name: "Review defaults", exact: true }).click();
          await defaultsReview
            .getByText(`Loopback auth bypass: off. Revision: ${after.settings.revision}.`, { exact: true })
            .waitFor();
          await page.route("**/api/v1/onboarding/bootstrap", async (route) => {
            defaultsIntercepted++;
            await route.abort("failed");
          });
          await defaultsReview.getByRole("button", { name: "Confirm defaults", exact: true }).click();
          await defaults.getByText(/Defaults outcome is unconfirmed/u).waitFor();
          assert.equal(defaultsIntercepted, 1);
          assert.equal((await readOnboarding()).settings.revision, after.settings.revision);
          stage = "review demo consequences and cancel";
          await demo.getByRole("button", { name: "Review demo preparation", exact: true }).click();
          await demoReview.waitFor();
          assert.match(await demoReview.innerText(), /durable memory example/u);
          assert.match(await demoReview.innerText(), /no revision guard/u);
          await capture("demo-review", demoReview, ["Confirm demo preparation", "Cancel"]);
          await demoReview.getByRole("button", { name: "Cancel", exact: true }).click();
          assert.equal(writes.length, 2);
          stage = "prepare actual demo records";
          await demo.getByRole("button", { name: "Review demo preparation", exact: true }).click();
          const [preparation] = await Promise.all([
            page.waitForResponse(
              (item) => item.url().endsWith("/api/v1/demo/bootstrap") && item.request().method() === "POST",
            ),
            demoReview.getByRole("button", { name: "Confirm demo preparation", exact: true }).click(),
          ]);
          assert.ok(preparation.ok());
          demoReceipt = await preparation.json();
          const demoState = await api("/api/v1/demo/state");
          const workspace = (await api("/api/v1/workspaces?view=all&limit=500")).items.find(
            (item) => item.workspaceId === demoState.workspace.workspaceId,
          );
          const project = (
            await api(
              `/api/v1/chat/projects?view=all&limit=300&workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
            )
          ).items.find((item) => item.projectId === demoState.project.projectId);
          const session = (
            await api(
              `/api/v1/chat/sessions?scope=all&view=all&includeHidden=true&limit=100&workspaceId=${encodeURIComponent(workspace.workspaceId)}&projectId=${encodeURIComponent(project.projectId)}`,
            )
          ).items.find((item) => item.sessionId === demoState.sessions[0].sessionId);
          const tasks = await Promise.all(
            demoState.tasks.map((task) =>
              api(
                `/api/v1/tasks/${encodeURIComponent(task.taskId)}?workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
              ),
            ),
          );
          assertAdvancedDemoRecords({ receipt: demoReceipt, state: demoState, workspace, project, session, tasks });
          const demoPrefs = await api(`/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}/prefs`);
          observerScope = {
            sessionId: session.sessionId,
            prefsOverride: {
              mode: "chat",
              providerId: configuredSettings.llm.activeProviderId,
              model: configuredSettings.llm.activeModel,
              webMode: demoPrefs.webMode,
              memoryMode: demoPrefs.memoryMode,
              thinkingLevel: demoPrefs.thinkingLevel,
              speedMode: demoPrefs.speedMode ?? "standard",
              subagentPolicy: demoPrefs.subagentPolicy ?? "off",
            },
          };
          await demo.getByText(`Last acknowledged preparation: ${demoReceipt.status}.`, { exact: true }).waitFor();
          for (const note of demoReceipt.notes) assert.ok((await demo.innerText()).includes(note));
          stage = "retain unknown demo preparation";
          await demo.getByRole("button", { name: "Review demo preparation", exact: true }).click();
          await page.route("**/api/v1/demo/bootstrap", async (route) => {
            demoIntercepted++;
            await route.abort("failed");
          });
          await demoReview.getByRole("button", { name: "Confirm demo preparation", exact: true }).click();
          await demo.getByText(/Demo preparation is unconfirmed/u).waitFor();
          assert.equal(demoIntercepted, 1);
          stage = "native remount and explicit read-only demo open";
          await advanced.click();
          await advanced.click();
          await defaults.getByText(/Defaults outcome is unconfirmed/u).waitFor();
          await demo.getByText(/Demo preparation is unconfirmed/u).waitFor();
          assert.equal(await defaults.getByRole("button", { name: "Review defaults", exact: true }).isDisabled(), true);
          assert.equal(
            await demo.getByRole("button", { name: "Review demo preparation", exact: true }).isDisabled(),
            true,
          );
          await capture("unknown-native");
          await demo.getByRole("button", { name: "Open recorded demo", exact: true }).click();
          await page.waitForURL(
            (url) => url.pathname === "/chat" && url.searchParams.get("sessionId") === session.sessionId,
          );
          assert.equal(
            await page.evaluate(() => window.localStorage.getItem("goatcitadel.ui.workspace_id.v1")),
            workspace.workspaceId,
          );
          assert.equal(
            await page.evaluate(() => window.localStorage.getItem("goatcitadel.ui.citadel_id.v1")),
            workspace.citadelId,
          );
          await page.goBack();
          await advanced.waitFor();
          stage = "same-document classic lock";
          await page.evaluate(() => {
            window.__advancedFirstRunRealm = {};
            window.__advancedFirstRunRoot = document.getElementById("root");
          });
          await page.keyboard.press("Control+k");
          await page.getByRole("option", { name: "Switch to classic Mission Control", exact: true }).click();
          await page.waitForSelector('html[data-shell="classic"] .mc-next-shell .mc-next-topbar', { timeout: 30_000 });
          await page.getByRole("button", { name: "First-run defaults", exact: true }).click();
          await page
            .getByText(/Defaults outcome is unconfirmed/u)
            .first()
            .waitFor();
          assert.equal(await page.getByRole("button", { name: "Review defaults", exact: true }).isDisabled(), true);
          await page.getByRole("button", { name: "Back to list", exact: true }).click();
          await page.getByRole("button", { name: "Try a safe demo", exact: true }).click();
          await page
            .getByText(/Demo preparation is unconfirmed/u)
            .first()
            .waitFor();
          assert.equal(
            await page.getByRole("button", { name: "Review demo preparation", exact: true }).isDisabled(),
            true,
          );
          assert.equal(navigations, navigationBaseline);
          assert.equal(
            await page.evaluate(
              () =>
                Boolean(window.__advancedFirstRunRealm) &&
                window.__advancedFirstRunRoot === document.getElementById("root"),
            ),
            true,
          );
          assertAdvancedFirstRunWrites(writes);
          await assertCockpitObserverRequests(observers);
          assert.deepEqual(
            await api(`/api/v1/chat/sessions/${encodeURIComponent(session.sessionId)}/prefs`),
            demoPrefs,
            "Classic setup inspection changed demo conversation preferences.",
          );
          const finalOwner = await readOnboarding();
          assertAdvancedDefaultsReceipt({
            before,
            request: writes[0].body,
            receipt: defaultsReceipt,
            after: finalOwner,
          });
          const presenceIdentity = await page.evaluate(() => ({
            clientId: window.sessionStorage.getItem("goatcitadel.notification-client-id"),
            leaseId: window.sessionStorage.getItem("goatcitadel.notification-lease-id"),
          }));
          await Promise.all(presence.map((entry) => entry.completed));
          for (const entry of presence) {
            if (entry.error) throw entry.error;
            assert.ok(["default", workspace.workspaceId].includes(entry.body.workspaceId));
            assertCitadelPresenceHeartbeat(entry, { ...presenceIdentity, workspaceId: entry.body.workspaceId });
          }
          await capture("unknown-classic");
          outcome = {
            status: "passed",
            metrics: {
              actualAuthFixture: "token-with-loopback-bypass-off",
              authFixtureUsedExistingSyntheticToken: true,
              authFixtureApprovalCompleted: authFixture?.receipt.changePlanReceipt?.status === "awaiting_approval",
              defaultsNumericCasConfirmed: true,
              setupMarkerUnchanged: true,
              cancelWrites: 0,
              contradictoryPreflightReads: staleReads,
              defaultsInterceptedBeforeGateway: defaultsIntercepted,
              demoInterceptedBeforeGateway: demoIntercepted,
              actualDemoReceiptStatus: demoReceipt.status,
              demoWorkspaceId: workspace.workspaceId,
              demoSessionId: session.sessionId,
              actualDemoChildrenIndependentlyRead: true,
              nativeAndClassicUnknownLocks: true,
              documentReloads: 0,
              browserModelOrToolExecution: false,
              browserApprovalDecisions: 0,
              eventBridgeRequests: observers.filter((entry) => entry.kind === "event-bridge").length,
              routeInspections: observers.filter((entry) => entry.kind === "route-inspection").length,
              systemPresenceHeartbeats: presence.length,
              limitation:
                "Source runtime fixture. Fixture auth posture uses its exact canonical approval and continuation with an existing synthetic token. Demo may create governed sample approval/memory records; POST notes are distinct from GET record readiness. Not installed-first-run or inference proof.",
            },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } catch (error) {
          if (page && !page.isClosed())
            try {
              await mkdir(screenshotDir, { recursive: true });
              const file = path.join(screenshotDir, `ux-budgets-cockpit-first-run-advanced-${variant}-failure.png`);
              await page.screenshot({ path: file });
              screenshots.push(relativeToRun(context, file));
            } catch {
              /* Keep the original stage failure. */
            }
          outcome = {
            status: "failed",
            error: `${stage}: ${String(error?.stack ?? error)}`,
            artifacts: emptyArtifacts({ screenshots }),
          };
        } finally {
          const cleanupErrors = [];
          try {
            await browserContext?.close();
          } catch (error) {
            cleanupErrors.push(`Browser cleanup: ${String(error?.stack ?? error)}`);
          }
          try {
            if (configured) {
              const current = await readSettings();
              assert.equal(current.auth.mode, initialSettings.auth.mode);
              if (current.auth.allowLoopbackBypass !== initialSettings.auth.allowLoopbackBypass)
                await setFirstRunFixtureAuthBypass(api, initialSettings.auth.allowLoopbackBypass);
              assert.equal((await readSettings()).auth.allowLoopbackBypass, initialSettings.auth.allowLoopbackBypass);
            }
          } catch (error) {
            cleanupErrors.push(`Auth fixture restoration: ${String(error?.stack ?? error)}`);
          }
          if (cleanupErrors.length) {
            outcome = {
              ...outcome,
              status: "failed",
              error: [outcome?.error, ...cleanupErrors].filter(Boolean).join("\n"),
              metrics: { ...outcome?.metrics, cleanupFailed: true },
            };
          }
        }
        return outcome;
      },
    );
}
