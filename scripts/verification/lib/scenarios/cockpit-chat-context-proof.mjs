import { assertNativeShellPresence } from "./cockpit-native-presence-proof.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";
import { assertProjectReadRequests } from "./cockpit-chat-project-proof.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const pathname = (url) => new URL(url).pathname;
async function until(read, accepts, page, label) {
  for (let i = 0; i < 80; i += 1) {
    const value = await read();
    if (accepts(value)) return value;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function disclose(actions, name) {
  const detail = actions
    .locator("details")
    .filter({ has: actions.page().locator("summary", { hasText: new RegExp(`^${name}$`) }) });
  if (!(await detail.evaluate((node) => node.open))) await detail.locator(":scope > summary").click();
  return detail;
}
async function review(page, title, confirm, viewport) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.waitFor();
  for (const locator of [
    dialog,
    dialog.getByRole("button", { name: confirm, exact: true }),
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ]) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert.ok(
      box &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      "Context review extends outside the viewport.",
    );
  }
  return dialog;
}

/** Disposable Gateway records; no external integration invocation or inferred mutation settlement. */
export async function runCockpitChatContextProof({ context, browser, stack, citadelId, viewports, deps }) {
  const {
    requestJson,
    assertOk,
    runScenario,
    emptyArtifacts,
    installMissionControlNextBrowserState,
    buildVerificationUiUrl,
    path,
    relativeToRun,
    axeSourcePath,
    auditPageAccessibility,
  } = deps;
  assert.ok(stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)));
  const api = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, "Native context owner request");
    return response.body;
  };
  const catalog = await api("/api/v1/integrations/catalog");
  const github = catalog.items.find(
    (item) => item.key === "github" && item.kind !== "channel" && item.kind !== "external_connector",
  );
  assert.ok(github);
  for (const { variant, viewport } of viewports)
    for (const theme of ["light", "dark"]) {
      const id = `ux-budgets.cockpit-chat-context.${variant}.${theme}`;
      await runScenario(
        context,
        { id, lane: "ux-budgets", title: `Native Chat context ${variant} ${theme}`, subsystem: "mission-control-ux" },
        async () => {
          const seed = await api("/api/v1/dev/verification/seed", {
            method: "POST",
            body: {
              workspaceName: `Context ${variant} ${theme}`,
              sessionTitle: `Context ${variant} ${theme}`,
              sessionCount: 1,
              longThreadTurns: 2,
            },
          });
          assert.ok(seed.workspaceId && seed.sessionId);
          const connection = await api("/api/v1/integrations/connections", {
            method: "POST",
            body: {
              catalogId: github.catalogId,
              label: `Native context ${seed.sessionId}`,
              enabled: false,
              status: "paused",
              config: { owner: "synthetic-cockpit-owner" },
            },
          });
          const base = `/api/v1/chat/sessions/${encodeURIComponent(seed.sessionId)}`;
          const bindingRoute = `${base}/binding`,
            rebuildRoute = `${base}/learned-memory/rebuild`;
          const threadBefore = await api(`${base}/thread`);
          const connectionBefore = await api(
            `/api/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}`,
          );
          const browserContext = await browser.newContext({ viewport, colorScheme: theme });
          const screenshots = [],
            writes = [],
            observers = [],
            presence = [],
            routingReads = [];
          let page;
          try {
            await browserContext.addInitScript((value) => {
              window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
              window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
            }, theme);
            await installMissionControlNextBrowserState(browserContext, seed.workspaceId, citadelId);
            page = await browserContext.newPage();
            page.on("request", (request) => {
              const route = pathname(request.url());
              if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !route.startsWith("/api/v1/"))
                return;
              if (recordCockpitObserverRequest(request, observers)) return;
              if (route === `${base}/route-preflight`) {
                routingReads.push({ method: request.method(), path: route, body: request.postDataJSON() });
                return;
              }
              if (route === "/api/v1/notifications/presence") {
                const entry = { method: request.method(), pathname: route, body: request.postDataJSON() };
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
                return;
              }
              writes.push({ method: request.method(), pathname: route, body: request.postDataJSON() });
            });
            await page.goto(
              buildVerificationUiUrl(
                stack.uiUrl,
                `/chat?sessionId=${encodeURIComponent(seed.sessionId)}&shell=cockpit`,
              ),
              { waitUntil: "domcontentloaded" },
            );
            await page.locator('[aria-label="Messages"]').waitFor({ timeout: 30000 });
            if (variant === "mobile") {
              await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
              await page.getByRole("menuitem", { name: "Inspect conversation", exact: true }).click();
            } else await page.getByRole("button", { name: "Inspect", exact: true }).click();
            await page.getByRole("tab", { name: "Conversation", exact: true }).click();
            const actions = page.locator('[aria-label="Conversation context actions"]');
            await actions.waitFor();
            const capture = async (stage) => {
              await page.addScriptTag({ path: axeSourcePath });
              const axe = await auditPageAccessibility(page);
              const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
              if (blocking.length) {
                const folder = path.join(context.artifactRoot, "diagnostics");
                await mkdir(folder, { recursive: true });
                await writeFile(
                  path.join(folder, `${id}-${stage}-axe.json`),
                  JSON.stringify(
                    blocking.slice(0, 8).map((item) => ({
                      id: item.id,
                      impact: item.impact,
                      nodes: item.nodes.slice(0, 8).map((node) => ({
                        target: node.target,
                        checks: node.any.map((check) => ({ id: check.id, data: check.data })),
                      })),
                    })),
                    null,
                    2,
                  ),
                );
              }
              assert.deepEqual(
                axe.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id),
                [],
              );
              assert.ok(
                (await page.evaluate(
                  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
                )) <= 1,
              );
              const folder = path.join(context.artifactRoot, "screenshots");
              await mkdir(folder, { recursive: true });
              const file = path.join(folder, `${id}-${stage}.png`);
              await page.screenshot({ path: file, fullPage: false });
              screenshots.push(relativeToRun(context, file));
            };
            const memory = await disclose(actions, "Learned memory");
            const rebuild = memory.getByRole("button", { name: "Rebuild learned memory", exact: true });
            await until(() => rebuild.isEnabled(), Boolean, page, "current memory owner");
            const learnedBefore = await api(`${base}/learned-memory?limit=1000`);
            await rebuild.click();
            let dialog = await review(page, "Rebuild learned memory?", "Rebuild learned memory", viewport);
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
            assert.equal(writes.filter((write) => write.pathname === rebuildRoute).length, 0);
            assert.deepEqual(await api(`${base}/learned-memory?limit=1000`), learnedBefore);
            await until(
              () => rebuild.evaluate((node) => node === document.activeElement),
              Boolean,
              page,
              "memory review focus return",
            );
            await rebuild.click();
            dialog = await review(page, "Rebuild learned memory?", "Rebuild learned memory", viewport);
            const rebuiltResponse = page.waitForResponse(
              (response) => response.request().method() === "POST" && pathname(response.url()) === rebuildRoute,
            );
            await dialog.getByRole("button", { name: "Rebuild learned memory", exact: true }).click();
            const rebuilt = await rebuiltResponse;
            assert.equal(rebuilt.status(), 200);
            const rebuiltReceipt = await rebuilt.json();
            assert.ok(rebuiltReceipt.rebuiltAt && Array.isArray(rebuiltReceipt.items));
            await dialog.waitFor({ state: "hidden" });
            assert.equal(writes.filter((write) => write.pathname === rebuildRoute).length, 1);
            assert.deepEqual((await api(`${base}/learned-memory?limit=1000`)).items, rebuiltReceipt.items);
            await memory.getByRole("button", { name: "Inspect current learned memory", exact: true }).click();
            await capture("memory-rebuilt");
            const binding = await disclose(actions, "External binding");
            const target = `synthetic-target-${seed.sessionId}`;
            await binding
              .getByRole("textbox", { name: "Connection", exact: true })
              .fill(` ${connection.connectionId} `);
            await binding.getByRole("textbox", { name: "Target", exact: true }).fill(` ${target} `);
            const save = binding.getByRole("button", { name: "Save binding", exact: true });
            await until(() => save.isEnabled(), Boolean, page, "current binding owner");
            const bindingBefore = await api(bindingRoute);
            await save.click();
            dialog = await review(page, "Save this writable integration binding?", "Save binding", viewport);
            assert.ok((await dialog.innerText()).includes(connection.connectionId));
            assert.ok((await dialog.innerText()).includes(target));
            await capture("binding-review");
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
            assert.equal(writes.filter((write) => write.pathname === bindingRoute).length, 0);
            assert.deepEqual(await api(bindingRoute), bindingBefore);
            await save.click();
            dialog = await review(page, "Save this writable integration binding?", "Save binding", viewport);
            const savedResponse = page.waitForResponse(
              (response) => response.request().method() === "POST" && pathname(response.url()) === bindingRoute,
            );
            await dialog.getByRole("button", { name: "Save binding", exact: true }).click();
            const saved = await savedResponse;
            assert.equal(saved.status(), 200);
            const receipt = await saved.json();
            assert.equal(receipt.sessionId, seed.sessionId);
            const canonicalSessions = await api(
              `/api/v1/chat/sessions?workspaceId=${encodeURIComponent(seed.workspaceId)}&view=all&limit=1000`,
            );
            assert.equal(
              canonicalSessions.items.find((item) => item.sessionId === receipt.sessionId)?.workspaceId,
              seed.workspaceId,
            );
            assert.equal(receipt.connectionId, connection.connectionId);
            assert.equal(receipt.target, target);
            assert.equal(receipt.transport, "integration");
            assert.equal(receipt.writable, true);
            assert.deepEqual((await api(bindingRoute)).item, receipt);
            assert.deepEqual(
              writes.filter((write) => write.pathname === bindingRoute).map((write) => write.body),
              [{ transport: "integration", connectionId: connection.connectionId, target, writable: true }],
            );
            await dialog.waitFor({ state: "hidden" });
            await capture("binding-saved");
            const originalDocument = await page.evaluate(() => performance.timeOrigin);
            await page.keyboard.press("Control+i");
            await actions.waitFor({ state: "hidden" });
            // The composer no longer carries a classic link; switch layouts where the shell offers it.
            if (variant === "mobile") {
              await page.getByRole("button", { name: "More areas and settings", exact: true }).click();
              await page.getByRole("button", { name: "Switch to classic Mission Control", exact: true }).click();
            } else {
              await page.getByRole("button", { name: "Settings and account", exact: true }).click();
              await page.getByRole("menuitem", { name: "Switch to classic Mission Control", exact: true }).click();
            }
            const returnToCockpit = page.getByRole("button", { name: "Return to Cockpit layout", exact: true });
            await returnToCockpit.waitFor({ timeout: 30000 });
            assert.equal(new URL(page.url()).searchParams.get("shell"), "classic");
            assert.equal(
              await page.evaluate(() => performance.timeOrigin),
              originalDocument,
              "Classic rollback reloaded the document.",
            );
            assert.deepEqual((await api(bindingRoute)).item, receipt);
            await returnToCockpit.click();
            await page.locator('[aria-label="Messages"]').waitFor({ timeout: 30000 });
            assert.equal(
              await page.evaluate(() => performance.timeOrigin),
              originalDocument,
              "Returning to Cockpit reloaded the document.",
            );
            if (variant === "mobile") {
              await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
              await page.getByRole("menuitem", { name: "Inspect conversation", exact: true }).click();
            } else await page.getByRole("button", { name: "Inspect", exact: true }).click();
            await page.getByRole("tab", { name: "Conversation", exact: true }).click();
            await actions.waitFor();
            await disclose(actions, "External binding");
            assert.equal(
              await binding.getByRole("textbox", { name: "Connection", exact: true }).inputValue(),
              connection.connectionId,
            );
            assert.equal(await binding.getByRole("textbox", { name: "Target", exact: true }).inputValue(), target);
            await capture("classic-rollback-returned");
            // Forward a real write, discard its response, then prove readback never settles the original uncertain effect.
            const nextTarget = target + "-response-lost";
            await binding.getByRole("textbox", { name: "Target", exact: true }).fill(nextTarget);
            let lost = false;
            await page.route(
              (url) => url.pathname === bindingRoute,
              async (route) => {
                if (route.request().method() !== "POST" || lost) return route.continue();
                lost = true;
                const response = await route.fetch();
                assert.equal(response.status(), 200);
                await response.dispose();
                await route.abort("failed");
              },
            );
            await save.click();
            dialog = await review(page, "Save this writable integration binding?", "Save binding", viewport);
            await dialog.getByRole("button", { name: "Save binding", exact: true }).click();
            await until(
              () => actions.innerText(),
              (text) => text.includes("unknown outcome"),
              page,
              "uncertain mutation lock",
            );
            assert.equal(lost, true);
            assert.equal((await api(bindingRoute)).item.target, nextTarget);
            await binding.getByRole("button", { name: "Inspect current binding", exact: true }).click();
            await until(
              () => binding.innerText(),
              (text) => text.includes("writes remain locked"),
              page,
              "read-only inspection without settlement",
            );
            assert.equal(await save.isEnabled(), false);
            assert.equal(writes.filter((write) => write.pathname === bindingRoute).length, 2);
            assert.equal(writes.filter((write) => write.pathname === rebuildRoute).length, 1);
            assert.deepEqual(
              writes.filter((write) => ![bindingRoute, rebuildRoute].includes(write.pathname)),
              [],
            );
            await assertCockpitObserverRequests(observers);
            assertProjectReadRequests(routingReads, { [seed.sessionId]: await api(`${base}/prefs`) });
            await Promise.all(presence.map((entry) => entry.completed));
            const clientId = await page.evaluate(() =>
              window.sessionStorage.getItem("goatcitadel.notification-client-id"),
            );
            const leases = new Map();
            for (const entry of presence) {
              if (entry.error) throw entry.error;
              assertNativeShellPresence(
                entry,
                { clientId, sessionsByWorkspace: { [seed.workspaceId]: seed.sessionId } },
                leases,
              );
            }
            assert.deepEqual(await api(`${base}/thread`), threadBefore);
            assert.deepEqual(
              await api(`/api/v1/integrations/connections/${encodeURIComponent(connection.connectionId)}`),
              connectionBefore,
            );
            assert.equal(
              await page
                .getByText(
                  "An unconfirmed Chat context action remains locked in this document. Switching layouts does not settle or replay its result.",
                  { exact: true },
                )
                .count(),
              1,
            );
            assert.equal(
              (await page.locator("body").innerText()).includes("Can't reach the GoatCitadel gateway"),
              false,
            );
            await capture("unknown-outcome-inspected");
            return {
              status: "passed",
              metrics: {
                workspaceId: seed.workspaceId,
                sessionId: seed.sessionId,
                theme,
                cancelledMutations: 0,
                bindingWrites: 2,
                rebuildWrites: 1,
                uncertainEffectSettled: false,
                sameDocumentClassicRollback: true,
                externalIntegrationInvocations: 0,
                blockingAxe: 0,
                overflow: 0,
              },
              artifacts: emptyArtifacts({ screenshots }),
            };
          } catch (error) {
            if (page && !page.isClosed()) {
              const folder = path.join(context.artifactRoot, "screenshots");
              await mkdir(folder, { recursive: true });
              const file = path.join(folder, `${id}-failure.png`);
              await page.screenshot({ path: file, fullPage: false });
              screenshots.push(relativeToRun(context, file));
            }
            return {
              status: "failed",
              error: error instanceof Error ? (error.stack ?? error.message) : String(error),
              artifacts: emptyArtifacts({ screenshots }),
            };
          } finally {
            await browserContext.close();
          }
        },
      );
    }
}
