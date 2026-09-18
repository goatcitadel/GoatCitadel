import assert from "node:assert/strict";

/** Uses the caller's disposable Gateway and browser; never provisions native volumes. */
export async function runCitadelStructureRevisionsScenario(context, deps, stack) {
  const { path, runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState,
    attachBrowserLogging, buildVerificationUiUrl, waitForVerificationRouteReady, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, writeJson, relativeToRun, NEXT_UI_PACKAGE } = deps;
  await runScenario(context, { id: "citadels.structure-revisions", lane: "citadel-record-revisions",
    title: "Charter, template, and Blueprint reviews reject competing edits and preserve drafts", subsystem: "library" }, async ({ correlationId }) => {
    const created = await requestJson(stack.gatewayUrl, "/api/v1/citadels", { method: "POST", body: {
      name: "Structure Review Citadel", slug: "citadel-structure-proof", kind: "custom" } });
    assertOk(created, "create owned structure Citadel");
    const citadelId = created.body.citadelId;
    const baseUrl = `/api/v1/citadels/${citadelId}`;
    const workspace = await requestJson(stack.gatewayUrl, "/api/v1/workspaces", { method: "POST", body: { citadelId, name: "Structure review workspace" } });
    assertOk(workspace, "create owned structure workspace");
    const read = async () => { const result = await requestJson(stack.gatewayUrl, `${baseUrl}/structure`); assertOk(result, "read structure"); return result.body; };
    const mutate = async (suffix, method, body) => { const result = await requestJson(stack.gatewayUrl, baseUrl + suffix, { method, body }); assertOk(result, "owned peer mutation"); return result.body; };
    const initial = await read();
    const browser = await chromium.launch({ headless: true });
    let page; let browserLog; let logCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspace.body.workspaceId, citadelId);
      page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
      const artifacts = []; const receipts = [];
      const capture = async (slug) => artifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
      const waitMutation = (suffix, method) => page.waitForResponse((response) => new URL(response.url()).pathname === baseUrl + suffix && response.request().method() === method);
      const race = async (suffix, method, reviewed, peer) => {
        const state = { tokens: [], winner: null };
        await page.route(`**${baseUrl}${suffix}`, async (route) => {
          if (route.request().method() === method) {
            const input = route.request().postDataJSON(); state.tokens.push(input.expectedRevision);
            if (!state.winner) {
              assert.equal(input.expectedRevision, reviewed.revision);
              await peer(reviewed);
              state.winner = await read();
            }
          }
          await route.continue();
        });
        return state;
      };
      const reject = async (suffix, method, click, state) => {
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), 409);
        assert.equal((await response.json()).details?.reason, "CITADEL_STRUCTURE_REVISION_CONFLICT");
        assert.deepEqual(await read(), state.winner);
      };
      const accept = async (suffix, method, click, state) => {
        logCursor = browserLog.mark();
        const [response] = await Promise.all([waitMutation(suffix, method), click()]);
        assert.equal(response.status(), method === "PUT" ? 200 : 201);
        const saved = await response.json();
        assert.notEqual(saved.revision, state.winner.revision);
        assert.deepEqual(state.tokens, [state.tokens[0], state.winner.revision]);
        assert.deepEqual(await read(), saved);
        assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
        receipts.push({ suffix, method, reviewed: state.tokens, winner: state.winner, saved });
        await page.unroute(`**${baseUrl}${suffix}`);
        return saved;
      };

      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-overview"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-overview", readyText: "Citadel" }, NEXT_UI_PACKAGE);
      await page.locator("#citadel-defaults > summary").click();
      await page.getByText("Personal Chief of Staff", { exact: true }).waitFor();
      const templateRace = await race("/from-template", "POST", initial, (reviewed) => mutate("", "PATCH", { expectedRevision: reviewed.record.revision, description: "Peer reviewed profile" }));
      await reject("/from-template", "POST", () => page.getByRole("button", { name: "Use template", exact: true }).first().click(), templateRace);
      await page.getByText(/Citadel or template changed/).waitFor();
      await capture("citadel-template-conflict-desktop");
      let current = await accept("/from-template", "POST", () => page.getByRole("button", { name: "Use template", exact: true }).first().click(), templateRace);
      assert.ok(current.charter);

      await page.getByRole("button", { name: "Edit Charter", exact: true }).click();
      const purpose = page.getByRole("textbox", { name: "Purpose", exact: true });
      await purpose.fill("Preserve this reviewed Charter draft");
      const charterRace = await race("/charter", "PUT", current, (reviewed) => mutate("/chambers", "POST", { expectedRevision: reviewed.revision, name: "Peer added Chamber", sensitivity: "restricted", sealed: true }));
      await reject("/charter", "PUT", () => page.getByRole("button", { name: "Save charter", exact: true }).click(), charterRace);
      await page.getByRole("button", { name: "Apply draft to current Charter", exact: true }).waitFor();
      assert.equal(await purpose.inputValue(), "Preserve this reviewed Charter draft");
      assert.equal(await page.getByRole("button", { name: "Save charter", exact: true }).isEnabled(), false);
      await capture("citadel-charter-retained-draft-desktop");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("citadel-charter-reviewed-draft-narrow");
      await page.getByRole("button", { name: "Apply draft to current Charter", exact: true }).click();
      current = await accept("/charter", "PUT", () => page.getByRole("button", { name: "Save charter", exact: true }).click(), charterRace);
      assert.equal(current.charter.purpose, "Preserve this reviewed Charter draft");
      assert.ok(current.chambers.some((chamber) => chamber.name === "Peer added Chamber"));

      const exported = await requestJson(stack.gatewayUrl, `${baseUrl}/blueprint`); assertOk(exported, "export owned Blueprint");
      const blueprint = { ...exported.body, charter: { ...exported.body.charter, purpose: "Reviewed Blueprint purpose" },
        chambers: [{ name: "Reviewed Blueprint Chamber", sensitivity: "private", sealed: false }] };
      const input = JSON.stringify(blueprint, null, 2);
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/citadel-blueprint"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "library", expectedSection: "citadel-blueprint", readyText: "Blueprint" }, NEXT_UI_PACKAGE);
      await page.getByRole("group", { name: "Blueprint view" }).getByRole("button", { name: "Import", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "Blueprint JSON", exact: true });
      await editor.fill(input);
      await page.getByRole("button", { name: "Validate", exact: true }).click();
      await page.getByRole("button", { name: "Review import", exact: true }).click();
      const blueprintRace = await race("/from-blueprint", "POST", current, (reviewed) => mutate("/charter", "PUT", {
        ...reviewed.charter, purpose: "Peer Charter before import", expectedRevision: reviewed.revision }));
      await reject("/from-blueprint", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Apply Blueprint", exact: true }).click(), blueprintRace);
      await page.getByText(/Validate again to review/).waitFor();
      assert.equal(await editor.inputValue(), input);
      assert.equal(await page.getByRole("button", { name: "Review import", exact: true }).isEnabled(), false);
      await capture("citadel-blueprint-retained-input-narrow");
      await page.getByRole("button", { name: "Validate", exact: true }).click();
      await page.getByText("Peer Charter before import", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Review import", exact: true }).click();
      await capture("citadel-blueprint-reviewed-import-narrow");
      current = await accept("/from-blueprint", "POST", () => page.getByRole("dialog").getByRole("button", { name: "Apply Blueprint", exact: true }).click(), blueprintRace);
      assert.equal(current.charter.purpose, blueprint.charter.purpose);
      assert.equal(current.chambers.filter((chamber) => chamber.name === "Reviewed Blueprint Chamber").length, 1);
      assert.equal(current.chambers.length, blueprintRace.winner.chambers.length + 1);
      await page.getByText("Blueprint imported.", { exact: true }).waitFor();
      assert.equal(await editor.inputValue(), "");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      await capture("citadel-blueprint-committed-narrow");
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "citadel-structure-revisions.json");
      await writeJson(diagnostics, { citadelId, workspaceId: workspace.body.workspaceId, initial, receipts, terminal: current,
        note: "Three real competing structure writes rejected with 409 and three explicit reviewed retries saved. Charter and Blueprint drafts preserved. No native volumes or live providers used." });
      const combined = Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key] ?? [])]));
      combined.diagnostics = [...(combined.diagnostics ?? []), relativeToRun(context, diagnostics)];
      return { status: "passed", metrics: { staleMutationsRejected: 3, reviewedMutations: 3, narrowWidth: 390 }, artifacts: combined };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "citadel-structure-revisions-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
