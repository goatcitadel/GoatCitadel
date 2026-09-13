import assert from "node:assert/strict";

/** Actual Gateway peers race reviewed browser activation, default edits and default creation. */
export async function runPermissionSelectionRevisionScenario(context, stack, deps) {
  const { runScenario, requestJson, assertOk, chromium, installMissionControlNextBrowserState, attachBrowserLogging,
    buildVerificationUiUrl, waitForVerificationRouteReady, NEXT_UI_PACKAGE, captureBrowserArtifacts,
    assertBrowserConsoleHealthy, path, writeJson, relativeToRun } = deps;
  await runScenario(context, { id: "permissions.selection-revisions", lane: "permission-profile-revisions",
    title: "Reviewed activations and defaults preserve competing selections and drafts", subsystem: "permissions" }, async ({ correlationId }) => {
    const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
      body: { workspaceName: "Permission selection workspace", sessionTitle: "Selection fixture", sessionCount: 1, longThreadTurns: 2 } });
    assertOk(seed, "seed selection review workspace");
    const workspaceId = seed.body.workspaceId;
    assert.ok(workspaceId);
    const collection = "/api/v1/tools/permission-profiles";
    const fixture = (label) => ({ label, scope: "workspace", scopeRef: workspaceId, approvalMode: "approve_all",
      toolPatterns: ["session.status"], deny: ["shell.exec"], readAccessMode: "roots_only", defaultForSurfaces: [] });
    const aResponse = await requestJson(stack.gatewayUrl, collection, { method: "POST", body: fixture("Selection profile A") });
    const bResponse = await requestJson(stack.gatewayUrl, collection, { method: "POST", body: fixture("Selection profile B") });
    assertOk(aResponse, "create first selectable profile"); assertOk(bResponse, "create competing profile");
    const a = aResponse.body; const b = bResponse.body;
    const profileUrl = `${collection}/${encodeURIComponent(a.profileId)}`;
    const effective = async (surface = "chat") => {
      const result = await requestJson(stack.gatewayUrl, `${collection}/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=${surface}`);
      assertOk(result, "read effective selection"); return result.body.permissionProfileId;
    };
    const list = async () => {
      const result = await requestJson(stack.gatewayUrl, `${collection}?workspaceId=${encodeURIComponent(workspaceId)}`);
      assertOk(result, "read profile list"); return result.body.items;
    };
    const peerActivate = async () => {
      const review = await requestJson(stack.gatewayUrl, `${collection}/selection-review`, { method: "POST",
        body: { operation: "activate", profileId: b.profileId, workspaceId, surface: "chat" } });
      assertOk(review, "review competing selection through actual API");
      const applied = await requestJson(stack.gatewayUrl, `${collection}/activate`, { method: "POST", body: {
        profileId: b.profileId, workspaceId, surface: "chat", expectedProfileRevision: review.body.profile.revision,
        expectedSelectionRevision: review.body.revision,
      } });
      assertOk(applied, "apply actual competing selection"); return applied.body;
    };
    const unreviewed = await requestJson(stack.gatewayUrl, `${collection}/activate`, { method: "POST", body: { profileId: a.profileId, workspaceId, surface: "chat" } });
    assert.equal(unreviewed.status, 400);
    const browser = await chromium.launch({ headless: true });
    let page; let browserLog; let logCursor;
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: "dark" });
      await installMissionControlNextBrowserState(browserContext, workspaceId);
      page = await browserContext.newPage(); browserLog = attachBrowserLogging(page); logCursor = browserLog.mark();
      await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/permissions"), { waitUntil: "domcontentloaded" });
      await waitForVerificationRouteReady(page, { expectedArea: "settings", expectedSection: "permissions", readyText: "Permission profiles" }, NEXT_UI_PACKAGE);
      await page.getByRole("button", { name: /^Selection profile A/ }).click();
      const waitMutation = (url, method) => page.waitForResponse((response) => new URL(response.url()).pathname === url && response.request().method() === method);
      const browserReview = async (buttonName) => {
        const [response] = await Promise.all([waitMutation(`${collection}/selection-review`, "POST"), page.getByRole("button", { name: buttonName, exact: true }).click()]);
        assert.equal(response.status(), 200);
        await page.getByRole("region", { name: "Reviewed permission selection", exact: true }).waitFor();
        return response.json();
      };
      const capturedArtifacts = [];
      const capture = async (slug, actionLabel) => {
        const notifications = page.getByRole("button", { name: "Dismiss notification", exact: true });
        for (let remaining = await notifications.count(); remaining > 0; remaining -= 1) await notifications.first().click();
        const region = page.getByRole("region", { name: "Reviewed permission selection", exact: true });
        await region.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        capturedArtifacts.push(await captureBrowserArtifacts(context, { slug, page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
        const action = page.getByRole("button", { name: actionLabel, exact: true });
        assert.equal(await action.isDisabled(), false);
        await action.scrollIntoViewIfNeeded();
        capturedArtifacts.push(await captureBrowserArtifacts(context, { slug: `${slug}-action`, page, browserLog,
          gatewayUrl: stack.gatewayUrl, correlationId, logCursor }));
      };
      const firstActivationReview = await browserReview("Use for Chat");
      assert.equal(await effective() === a.profileId, false, "review alone must not activate the selected profile");
      let activationWinner;
      const activationTokens = [];
      await page.route(`**${collection}/activate`, async (route) => {
        if (route.request().method() === "POST") {
          const input = route.request().postDataJSON(); activationTokens.push(input.expectedSelectionRevision);
          if (!activationWinner) { assert.equal(input.expectedSelectionRevision, firstActivationReview.revision); activationWinner = await peerActivate(); }
        }
        await route.continue();
      });
      const apply = () => page.getByRole("button", { name: "Apply reviewed selection", exact: true }).click();
      const [activationConflict] = await Promise.all([waitMutation(`${collection}/activate`, "POST"), apply()]);
      assert.equal(activationConflict.status(), 409);
      assert.equal((await activationConflict.json()).details?.reason, "PERMISSION_SELECTION_REVISION_CONFLICT");
      await page.getByText("Permission selections changed. Review the current selection before applying it again.", { exact: true }).waitFor();
      assert.equal(await effective(), b.profileId);
      assert.equal(await page.getByRole("button", { name: "Apply reviewed selection", exact: true }).count(), 0);
      const freshActivationReview = await browserReview("Use for Chat");
      assert.notEqual(freshActivationReview.revision, firstActivationReview.revision);
      await page.getByRole("region", { name: "Current selections in reviewed scope", exact: true }).getByText("Chat: Selection profile B", { exact: true }).waitFor();
      await page.getByRole("region", { name: "Reviewed profile rules", exact: true }).getByText("Workspace roots only", { exact: true }).waitFor();
      await capture("permission-selection-activation-conflict-review", "Apply reviewed selection");
      logCursor = browserLog.mark();
      const [activationAccepted] = await Promise.all([waitMutation(`${collection}/activate`, "POST"), apply()]);
      assert.equal(activationAccepted.status(), 200);
      await page.getByText("Selection profile A activated.", { exact: true }).waitFor();
      assert.equal(await effective(), a.profileId);
      assert.deepEqual(activationTokens, [firstActivationReview.revision, freshActivationReview.revision]);
      assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);

      await page.getByRole("button", { name: "Edit profile", exact: true }).click();
      const name = page.getByRole("textbox", { name: "Edit profile name", exact: true });
      await name.fill("Default draft retained");
      await page.getByRole("checkbox", { name: "Chat", exact: true }).check();
      const save = page.getByRole("button", { name: "Save profile", exact: true });
      assert.equal(await save.isDisabled(), true);
      const firstDefaultsReview = await browserReview("Review default selection");
      let defaultWinner;
      const defaultTokens = [];
      await page.route(`**${profileUrl}`, async (route) => {
        if (route.request().method() === "PATCH") {
          const input = route.request().postDataJSON(); defaultTokens.push(input.expectedSelectionRevision);
          if (!defaultWinner) { assert.equal(input.expectedSelectionRevision, firstDefaultsReview.revision); defaultWinner = await peerActivate(); }
        }
        await route.continue();
      });
      const [defaultConflict] = await Promise.all([waitMutation(profileUrl, "PATCH"), save.click()]);
      assert.equal(defaultConflict.status(), 409);
      assert.equal((await defaultConflict.json()).details?.reason, "PERMISSION_SELECTION_REVISION_CONFLICT");
      await page.getByText("Permission selections changed. Your draft is preserved; review the default selection again.", { exact: true }).waitFor();
      assert.equal(await name.inputValue(), "Default draft retained");
      assert.equal(await save.isDisabled(), true); assert.equal(await effective(), b.profileId);
      assert.equal((await list()).find((item) => item.profileId === a.profileId).revision, a.revision);
      await page.setViewportSize({ width: 390, height: 844 });
      const freshDefaultsReview = await browserReview("Review default selection");
      assert.notEqual(freshDefaultsReview.revision, firstDefaultsReview.revision);
      await capture("permission-selection-default-review-narrow", "Save profile");
      logCursor = browserLog.mark();
      const [defaultAccepted] = await Promise.all([waitMutation(profileUrl, "PATCH"), save.click()]);
      assert.equal(defaultAccepted.status(), 200);
      const savedProfile = await defaultAccepted.json();
      assert.equal(savedProfile.label, "Default draft retained"); assert.deepEqual(savedProfile.defaultForSurfaces, ["chat"]);
      await page.getByText("Permission profile updated.", { exact: true }).waitFor();
      assert.equal(await effective(), a.profileId);
      assert.deepEqual(defaultTokens, [firstDefaultsReview.revision, freshDefaultsReview.revision]);
      assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);

      await page.getByRole("button", { name: "Back to list", exact: true }).click();
      await page.getByRole("button", { name: "New profile", exact: true }).click();
      const createName = page.getByPlaceholder("Review mode, research mode, release captain", { exact: true });
      await createName.fill("New reviewed default");
      await page.getByRole("checkbox", { name: "Direct tools", exact: true }).check();
      const create = page.getByRole("button", { name: "Create profile", exact: true });
      assert.equal(await create.isDisabled(), true);
      const firstCreateReview = await browserReview("Review default selection");
      let createWinner;
      const createTokens = [];
      const profileCount = (await list()).length;
      await page.route(`**${collection}`, async (route) => {
        if (route.request().method() === "POST") {
          const input = route.request().postDataJSON(); createTokens.push(input.expectedSelectionRevision);
          if (!createWinner) {
            assert.equal(input.expectedSelectionRevision, firstCreateReview.revision);
            const response = await requestJson(stack.gatewayUrl, profileUrl, { method: "PATCH",
              body: { expectedRevision: savedProfile.revision, label: "Peer profile edit after review" } });
            assertOk(response, "invalidate creation review with an actual permission edit"); createWinner = response.body;
          }
        }
        await route.continue();
      });
      const [createConflict] = await Promise.all([waitMutation(collection, "POST"), create.click()]);
      assert.equal(createConflict.status(), 409);
      await page.getByText("Permission selections changed. Your draft is preserved; review the default selection again.", { exact: true }).waitFor();
      assert.equal(await createName.inputValue(), "New reviewed default"); assert.equal(await create.isDisabled(), true);
      assert.equal((await list()).length, profileCount);
      const freshCreateReview = await browserReview("Review default selection");
      await capture("permission-selection-create-reviewed-narrow", "Create profile");
      logCursor = browserLog.mark();
      const [created] = await Promise.all([waitMutation(collection, "POST"), create.click()]);
      assert.equal(created.status(), 201); const createdProfile = await created.json();
      await page.getByText("Permission profile created.", { exact: true }).waitFor();
      assert.equal(await effective("tools"), createdProfile.profileId);
      assert.equal((await list()).length, profileCount + 1);
      assert.deepEqual(createTokens, [firstCreateReview.revision, freshCreateReview.revision]);
      assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
      const diagnostics = path.join(context.artifactRoot, "diagnostics", "permission-selection-revisions.json");
      await writeJson(diagnostics, { workspaceId, a, b, savedProfile, createdProfile, activationTokens, defaultTokens, createTokens,
        conflicts: [activationConflict.status(), defaultConflict.status(), createConflict.status()],
        note: "All peers use actual Gateway API calls. No live provider, external message or disk operation is involved. A permission change invalidates outstanding selection reviews across the permission domain." });
      const artifacts = Object.fromEntries(Object.keys(capturedArtifacts[0]).map((key) => [key, capturedArtifacts.flatMap((item) => item[key] ?? [])]));
      artifacts.diagnostics = [...(artifacts.diagnostics ?? []), relativeToRun(context, diagnostics)];
      return { status: "passed", metrics: { rejectedUnguardedActivation: 1, rejectedStaleSelections: 3, reviewedSelectionsApplied: 3,
        retainedDrafts: 2, noPartialCreation: 1, narrowWidth: 390 }, artifacts };
    } catch (error) {
      if (page && browserLog) await captureBrowserArtifacts(context, { slug: "permission-selection-revision-failure", page, browserLog,
        gatewayUrl: stack.gatewayUrl, correlationId, logCursor });
      throw error;
    } finally { await browser.close(); }
  });
}
