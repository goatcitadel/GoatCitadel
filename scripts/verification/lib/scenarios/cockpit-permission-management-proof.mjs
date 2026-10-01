import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import {
  assertPermissionProfileWrite,
  assertPermissionProfileArchive,
  assertTemporaryOverrideWrite,
  assertTemporaryOverrideEnded,
} from "./cockpit-permission-management-assertions.mjs";
import { inspectPermissionContexts, revokeDisposableAutonomousGrant } from "./cockpit-permission-context-proof.mjs";

/** Real policy-record writes only in a new disposable workspace; never activates a profile or invokes a tool. */
export async function runCockpitPermissionManagementProof({ context, browser, stack, citadelId, viewports, deps }) {
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
    "Permissions proof requires a disposable runtime.",
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
        id: `ux-budgets.cockpit-permission-management.${variant}`,
        lane: "ux-budgets",
        title: `Native profile rules and temporary override lifecycle ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const writes = [],
          presence = [],
          screenshots = [],
          createdProfiles = [];
        const profilePath = "/api/v1/tools/permission-profiles",
          overridePath = "/api/v1/tools/local-operator-overrides";
        let stage = "prepare disposable workspace",
          page,
          browserContext,
          panel,
          workspaceId,
          overrideId,
          navigations = 0;
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        const readProfiles = async () =>
          (await api(`${profilePath}?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=true`)).items;
        const readProfile = async (id) => (await readProfiles()).find((item) => item.profileId === id);
        const readOverrides = async () => (await api(overridePath)).items;
        try {
          const suffix = `${variant}-${randomUUID().slice(0, 8)}`;
          const workspace = await api("/api/v1/workspaces", {
            method: "POST",
            body: { citadelId, name: `Permission management ${suffix}`, slug: `permission-management-${suffix}` },
          });
          workspaceId = workspace.workspaceId;
          assert.ok(workspaceId);
          const priorProfiles = await readProfiles(),
            priorOverrides = await readOverrides();
          const priorEffective = await api(
            `${profilePath}/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=chat`,
          );
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
            const entry = { method: request.method(), pathname, body: request.postDataJSON() };
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
          // Any accidental provider/tool execution is stopped before it reaches the isolated owner.
          await page.route("**/api/v1/chat/**/agent-send", (route) => route.abort("failed"));
          await page.route("**/api/v1/tools/invoke", (route) => route.abort("failed"));
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#permission-profile"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          panel = page.getByRole("region", { name: "Manage permission profiles", exact: true });
          const fullPanel = page.getByRole("region", { name: "Chat permission profile", exact: true });
          const review = (target) => target.getByRole("region", { name: "Review permission change", exact: true });
          const selection = () =>
            page.evaluate(() => ({
              citadel: window.localStorage.getItem("goatcitadel.ui.citadel_id.v1"),
              workspace: window.localStorage.getItem("goatcitadel.ui.workspace_id.v1"),
            }));
          const initialSelection = await selection();
          const replyFor = async (method, pathname, action) => {
            const [response] = await Promise.all([
              page.waitForResponse(
                (reply) => reply.request().method() === method && new URL(reply.url()).pathname === pathname,
              ),
              action(),
            ]);
            assert.ok(response.ok(), `${pathname}: ${response.status()}`);
            return { receipt: await response.json(), request: response.request().postDataJSON() };
          };
          const apply = (target) =>
            review(target).getByRole("button", { name: "Apply reviewed permission change", exact: true }).click();
          await mkdir(screenshotDir, { recursive: true });
          await page.addScriptTag({ path: axeSourcePath });
          const capture = async (name, target = panel) => {
            await target.scrollIntoViewIfNeeded();
            const axe = await auditPageAccessibility(page);
            assert.deepEqual(
              axe.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id),
              [],
            );
            assert.ok(
              (await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              )) <= 1,
            );
            const buttons = target.getByRole("button", {
              name: /^(Apply reviewed permission change|Cancel permission change|Revoke reviewed autonomous grant|Keep autonomous grant)$/,
            });
            for (const button of await buttons.all()) {
              await button.scrollIntoViewIfNeeded();
              const rect = await button.boundingBox();
              assert.ok(
                rect &&
                  rect.x >= 0 &&
                  rect.x + rect.width <= viewport.width + 1 &&
                  rect.width > 40 &&
                  rect.height >= 28,
                "Review action is clipped or has no usable hit target.",
              );
            }
            const file = path.join(screenshotDir, `ux-budgets-cockpit-permission-management-${variant}-${name}.png`);
            await page.screenshot({ path: file });
            screenshots.push(relativeToRun(context, file));
          };
          stage = "inspect exact effective and compatibility policy contexts without selection";
          const effectiveContexts = await inspectPermissionContexts({ page, api, workspaceId, writes, capture });
          const fillProfile = async (label) => {
            await panel.getByLabel("Profile name", { exact: true }).fill(label);
            await panel
              .getByLabel("Profile description", { exact: true })
              .fill("Disposable read-only policy profile; no activation.");
            await panel.getByLabel("Approval behavior", { exact: true }).selectOption("approve_all");
            await panel.getByLabel("Tool patterns", { exact: false }).fill("session.status");
            await panel.getByLabel("Allow rules", { exact: false }).fill("session.status");
            await panel.getByLabel("Deny rules", { exact: false }).fill("shell.*");
            await panel.getByLabel("Read access", { exact: true }).selectOption("roots_only");
          };
          const create = async (label) => {
            await panel.getByRole("button", { name: "New permission profile", exact: true }).click();
            await fillProfile(label);
            await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
            await review(panel).waitFor();
            const result = await replyFor("POST", profilePath, () => apply(panel));
            createdProfiles.push(result.receipt.profileId);
            assertPermissionProfileWrite({
              ...result,
              owner: await readProfile(result.receipt.profileId),
              workspaceId,
            });
            await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).waitFor();
            return result.receipt;
          };
          stage = "cancel exact profile review without a write";
          const label = `Permission profile ${suffix}`;
          await panel.getByRole("button", { name: "New permission profile", exact: true }).click();
          await fillProfile(label);
          await panel.getByText("Retained legacy contexts", { exact: true }).click();
          for (const name of ["Legacy Cowork compatibility", "Legacy Code compatibility"])
            assert.equal(await panel.getByRole("checkbox", { name, exact: true }).isChecked(), false);
          await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
          await review(panel).waitFor();
          await capture("profile-review", review(panel));
          assert.equal(writes.length, 0);
          await review(panel).getByRole("button", { name: "Cancel permission change", exact: true }).click();
          await review(panel).waitFor({ state: "hidden" });
          assert.equal(writes.length, 0);
          await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
          let result = await replyFor("POST", profilePath, () => apply(panel));
          let current = result.receipt;
          createdProfiles.push(current.profileId);
          assertPermissionProfileWrite({ ...result, owner: await readProfile(current.profileId), workspaceId });
          await panel.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
          stage = "apply profile rule edit with exact revision";
          const renamed = `${label} edited`;
          await panel.getByLabel("Profile name", { exact: true }).fill(renamed);
          await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
          result = await replyFor("PATCH", `${profilePath}/${current.profileId}`, () => apply(panel));
          assertPermissionProfileWrite({
            before: current,
            ...result,
            owner: await readProfile(current.profileId),
            workspaceId,
          });
          current = result.receipt;
          await panel.getByRole("button", { name: `Edit ${renamed}`, exact: true }).waitFor();
          stage = "stale canonical profile prevents mutation";
          await panel.getByLabel("Profile name", { exact: true }).fill(`${renamed} draft`);
          await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
          await review(panel).waitFor();
          current = await api(`${profilePath}/${current.profileId}`, {
            method: "PATCH",
            body: { expectedRevision: current.revision, description: "Concurrent owner metadata change" },
          });
          const count = writes.length;
          await apply(panel);
          await panel
            .getByText(/This profile changed\. Refresh and explicitly rebase/)
            .first()
            .waitFor();
          assert.equal(writes.length, count, "Stale review dispatched a profile mutation.");
          await fullPanel.getByRole("button", { name: "Refresh permission profiles", exact: true }).click();
          await panel.getByRole("button", { name: "Rebase permission draft to current profile", exact: true }).click();
          stage = "archive the reviewed profile";
          await panel.getByRole("button", { name: "Review profile archive", exact: true }).click();
          await review(panel).waitFor();
          await review(panel).getByRole("button", { name: "Cancel permission change", exact: true }).click();
          assert.equal(writes.length, count);
          await panel.getByRole("button", { name: "Review profile archive", exact: true }).click();
          result = await replyFor("POST", `${profilePath}/${current.profileId}/archive`, () => apply(panel));
          assertPermissionProfileArchive({ before: current, ...result, owner: await readProfile(current.profileId) });
          await panel.getByRole("button", { name: `Edit ${renamed}`, exact: true }).waitFor({ state: "hidden" });
          stage = "review, cancel, start and end a disposable workspace override";
          const overrides = page.getByRole("region", { name: "Temporary Local Operator Overrides", exact: true });
          const reason = `Disposable verification override ${suffix}`;
          await overrides.getByLabel("Override reason", { exact: true }).fill(reason);
          await overrides.getByRole("checkbox", { name: /I understand this grants broad local tool access/ }).check();
          await overrides.getByRole("button", { name: "Review temporary override", exact: true }).click();
          await review(overrides).waitFor();
          assert.match(await review(overrides).innerText(), /no revision token/);
          await capture("override-review", review(overrides));
          const beforeOverride = writes.length;
          await review(overrides).getByRole("button", { name: "Cancel permission change", exact: true }).click();
          assert.equal(writes.length, beforeOverride);
          await overrides.getByRole("button", { name: "Review temporary override", exact: true }).click();
          result = await replyFor("POST", overridePath, () => apply(overrides));
          overrideId = result.receipt.overrideId;
          const active = await readOverrides();
          assertTemporaryOverrideWrite({
            ...result,
            owner: active.find((item) => item.overrideId === overrideId),
            workspaceId,
            priorIds: priorOverrides.map((item) => item.overrideId),
          });
          const started = result.receipt;
          const row = overrides.getByRole("listitem").filter({ hasText: reason });
          await row.getByRole("button", { name: "Review ending override", exact: true }).click();
          result = await replyFor("POST", `${overridePath}/${overrideId}/revoke`, () => apply(overrides));
          assertTemporaryOverrideEnded({ before: started, ...result, active: await readOverrides() });
          overrideId = undefined;
          await row.waitFor({ state: "hidden" });
          stage = "review, cancel and revoke an inert disposable autonomous grant";
          const grant = await revokeDisposableAutonomousGrant({
            page,
            api,
            workspaceId,
            suffix,
            writes,
            capture,
            replyFor,
          });
          stage = "retain committed profile response loss across native and classic";
          const secondLabel = `Uncertain profile ${suffix}`;
          current = await create(secondLabel);
          await panel.getByRole("button", { name: `Edit ${secondLabel}`, exact: true }).click();
          const unknownLabel = `${secondLabel} pending`;
          await panel.getByLabel("Profile name", { exact: true }).fill(unknownLabel);
          await panel.getByRole("button", { name: "Review profile change", exact: true }).click();
          let committed,
            submitted,
            intercepted = 0;
          const loseReply = async (route) => {
            if (route.request().method() !== "PATCH") return route.continue();
            intercepted++;
            submitted = route.request().postDataJSON();
            const response = await route.fetch();
            assert.ok(response.ok());
            committed = await response.json();
            await route.abort("failed");
          };
          await page.route(`**${profilePath}/${current.profileId}`, loseReply);
          await apply(panel);
          await panel
            .getByText(/The permission change outcome is uncertain\./)
            .first()
            .waitFor();
          assert.equal(intercepted, 1);
          assertPermissionProfileWrite({
            before: current,
            request: submitted,
            receipt: committed,
            owner: await readProfile(current.profileId),
            workspaceId,
          });
          await page.unroute(`**${profilePath}/${current.profileId}`, loseReply);
          const nav = page.getByRole("navigation", { name: "Settings pages", exact: true });
          await nav.getByRole("link", { name: "General", exact: true }).click();
          const keep = page.getByRole("button", { name: "Keep draft and close", exact: true });
          if (await keep.isVisible()) await keep.click();
          await nav.getByRole("link", { name: "Safety", exact: true }).click();
          await page.getByRole("tab", { name: "Permissions", exact: true }).click();
          // Refresh may reveal the committed rename, but must not release uncertainty.
          const refreshWrites = writes.length;
          const profilesRefreshed = page.waitForResponse(
            (reply) =>
              reply.request().method() === "GET" &&
              new URL(reply.url()).pathname === profilePath &&
              new URL(reply.url()).searchParams.get("workspaceId") === workspaceId,
          );
          await fullPanel.getByRole("button", { name: "Refresh permission profiles", exact: true }).click();
          assert.ok((await profilesRefreshed).ok());
          assert.equal(writes.length, refreshWrites, "Refreshing an uncertain profile retried its mutation.");
          await panel.getByRole("button", { name: `Edit ${unknownLabel}`, exact: true }).click();
          assert.equal(await panel.getByLabel("Profile name", { exact: true }).inputValue(), unknownLabel);
          assert.equal(
            await panel.getByRole("button", { name: "Review profile change", exact: true }).isDisabled(),
            true,
          );
          assert.equal(
            await panel.getByRole("button", { name: "Review profile archive", exact: true }).isDisabled(),
            true,
          );
          await capture("unknown-native");
          const beforeHandoff = writes.length,
            beforeNavigation = navigations;
          await page.evaluate(() => {
            window.__permissionProofRealm = {};
            window.__permissionProofRoot = document.getElementById("root");
          });
          await page.getByRole("link", { name: "Open classic permission settings", exact: true }).click();
          if (await keep.isVisible()) await keep.click();
          await page.waitForSelector('html[data-shell="classic"] .mc-next-shell .mc-next-topbar', { timeout: 30_000 });
          await page
            .locator("button.mc-next-settings-selectable")
            .filter({ has: page.getByText(unknownLabel, { exact: true }) })
            .click();
          await page.getByRole("button", { name: /^Edit profile(?: · Unsaved)?$/ }).click();
          await page
            .getByText(/The permission change outcome is uncertain\./)
            .first()
            .waitFor();
          assert.equal(await page.getByRole("button", { name: "Save profile", exact: true }).isDisabled(), true);
          assert.equal(
            await page.getByRole("textbox", { name: "Edit profile name", exact: true }).inputValue(),
            unknownLabel,
          );
          assert.equal(navigations, beforeNavigation);
          assert.equal(writes.length, beforeHandoff);
          assert.ok(
            await page.evaluate(
              () =>
                Boolean(window.__permissionProofRealm) &&
                window.__permissionProofRoot === document.getElementById("root"),
            ),
          );
          assert.deepEqual(await selection(), initialSelection);
          assert.deepEqual(await readProfile(current.profileId), committed);
          await capture("unknown-classic", page.getByRole("button", { name: "Save profile", exact: true }));
          const finalProfiles = await readProfiles();
          for (const before of priorProfiles)
            assert.deepEqual(
              finalProfiles.find((item) => item.profileId === before.profileId),
              before,
            );
          assert.deepEqual(await readOverrides(), priorOverrides);
          assert.deepEqual(
            await api(`${profilePath}/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=chat`),
            priorEffective,
          );
          for (const [surface, before] of Object.entries(effectiveContexts))
            assert.deepEqual(
              await api(`${profilePath}/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=${surface}`),
              before,
            );
          assert.deepEqual(
            writes.map(({ method, pathname }) => `${method} ${pathname}`),
            [
              `POST ${profilePath}`,
              `PATCH ${profilePath}/${createdProfiles[0]}`,
              `POST ${profilePath}/${createdProfiles[0]}/archive`,
              `POST ${overridePath}`,
              `POST ${overridePath}/${started.overrideId}/revoke`,
              `POST ${grant.pathname}`,
              `POST ${profilePath}`,
              `PATCH ${profilePath}/${createdProfiles[1]}`,
            ],
          );
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
              workspaceId,
              actualProfileCreateEditArchive: true,
              noDefaultSelectionOrActivation: true,
              cancelWrites: 0,
              staleWritePrevented: true,
              exactRevisionReceiptReadback: true,
              temporaryWorkspaceOverrideStartedAndEnded: true,
              lostCommittedProfileResponse: true,
              nativeClassicUnknownLock: true,
              sameDocumentHandoff: true,
              selectionAndPriorRecordsUnchanged: true,
              effectiveContextsInspected: Object.keys(effectiveContexts),
              legacyDefaultsDisclosed: true,
              actualInertAutonomousGrantRevoked: grant.grantId,
              noCapabilityActivation: true,
              systemPresenceHeartbeats: presence.length,
              blockingAxe: 0,
              limitation:
                "Disposable workspace only; no tools or providers invoked. Profile response loss is injected after owner commit; temporary override API has no atomic revision token.",
            },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } catch (error) {
          if (page && !page.isClosed())
            try {
              await mkdir(screenshotDir, { recursive: true });
              const file = path.join(screenshotDir, `ux-budgets-cockpit-permission-management-${variant}-failure.png`);
              await page.screenshot({ path: file });
              screenshots.push(relativeToRun(context, file));
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
          await browserContext?.close();
          // Retire only exact records created by this scenario, even after a failed assertion.
          if (overrideId) await api(`${overridePath}/${overrideId}/revoke`, { method: "POST", body: {} });
          for (const id of createdProfiles) {
            const record = await readProfile(id);
            if (record?.status === "active")
              await api(`${profilePath}/${id}/archive`, {
                method: "POST",
                body: { expectedRevision: record.revision },
              });
          }
        }
      },
    );
}
