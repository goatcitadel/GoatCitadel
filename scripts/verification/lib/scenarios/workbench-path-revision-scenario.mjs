import assert from "node:assert/strict";

/** Runs on the content-save scenario's owned temporary project and real Gateway. */
export async function exerciseWorkbenchPathReview(context, deps, input) {
  const { requestJson, assertOk, captureBrowserArtifacts, assertBrowserConsoleHealthy, NEXT_UI_PACKAGE } = deps;
  const { page, browserLog, gatewayUrl, workbenchUrl, correlationId } = input;
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByText("File actions", { exact: true }).click();
  const form = page.locator('[aria-label="File tree actions"]');
  await form.getByRole("combobox").selectOption("rename");
  await form.getByLabel("Path", { exact: true }).fill("index.ts");
  await form.getByLabel("Target", { exact: true }).fill("reviewed.ts");
  const actionUrl = `${workbenchUrl}/file-operation`;
  const action = { operation: "rename", path: "index.ts", targetPath: "reviewed.ts" };
  const unguarded = await requestJson(gatewayUrl, actionUrl, { method: "POST", body: action });
  assert.equal(unguarded.status, 400);
  const waitForAction = (suffix = "") => page.waitForResponse((response) => new URL(response.url()).pathname === `${actionUrl}${suffix}`
    && response.request().method() === "POST");
  const reviewButton = form.getByRole("button", { name: "Review file action", exact: true });
  const applyButton = form.getByRole("button", { name: "Apply reviewed action", exact: true });
  assert.equal(await applyButton.count(), 0);
  const [reviewResponse] = await Promise.all([waitForAction("/preview"), reviewButton.click()]);
  assert.equal(reviewResponse.status(), 200);
  const reviewed = await reviewResponse.json();
  assert.deepEqual(reviewed.affectedPaths.map((entry) => entry.path), ["index.ts"]);
  let concurrent;
  const submittedRevisions = [];
  const intercept = async (route) => {
    const submitted = route.request().postDataJSON();
    submittedRevisions.push(submitted.expectedRevision);
    if (!concurrent) {
      assert.equal(submitted.expectedRevision, reviewed.revision);
      const before = await requestJson(gatewayUrl, `${workbenchUrl}/file?path=index.ts`);
      assertOk(before, "read source before a separate writer changes it");
      concurrent = await requestJson(gatewayUrl, `${workbenchUrl}/file`, { method: "PUT", body: {
        path: "index.ts", content: "export const changedAfterPathReview = true;\n", expectedRevision: before.body.revision,
      } });
      assertOk(concurrent, "change the actual source after the path review");
    }
    await route.continue();
  };
  await page.route(`**${actionUrl}`, intercept);
  try {
    const [conflict] = await Promise.all([waitForAction(), applyButton.click()]);
    assert.equal(conflict.status(), 409);
    assert.equal((await conflict.json()).details?.reason, "WORKBENCH_PATH_REVISION_CONFLICT");
    await form.getByText("File action was not confirmed.", { exact: false }).waitFor();
    assert.equal(await form.getByLabel("Path", { exact: true }).inputValue(), "index.ts");
    assert.equal(await form.getByLabel("Target", { exact: true }).inputValue(), "reviewed.ts");
    assert.equal(await applyButton.count(), 0);
    const tree = await requestJson(gatewayUrl, `${workbenchUrl}/tree`);
    assertOk(tree, "read the unchanged file tree after the conflict");
    assert.equal(tree.body.items.some((entry) => entry.path === "reviewed.ts"), false);
    assert.equal((await requestJson(gatewayUrl, `${workbenchUrl}/file?path=index.ts`)).body.content, concurrent.body.content);
    assert.equal(await page.getByText("API error 409", { exact: false }).count(), 0);
    const conflictArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-path-conflict", page, browserLog, gatewayUrl, correlationId });
    const logCursor = browserLog.mark();
    const [currentResponse] = await Promise.all([waitForAction("/preview"), reviewButton.click()]);
    assert.equal(currentResponse.status(), 200);
    const current = await currentResponse.json();
    assert.notEqual(current.revision, reviewed.revision);
    await form.getByRole("region", { name: "File action review" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Browse files", exact: true }).click();
    const reviewRegion = form.getByRole("region", { name: "File action review" });
    await reviewRegion.waitFor({ state: "visible" });
    await reviewRegion.getByText("Review affected paths (1)", { exact: true }).click();
    await applyButton.scrollIntoViewIfNeeded();
    const reviewBounds = await reviewRegion.boundingBox();
    assert.ok(reviewBounds && reviewBounds.x >= 0 && reviewBounds.x + reviewBounds.width <= 390);
    const narrowArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-path-review-narrow", page, browserLog, gatewayUrl, correlationId, logCursor });
    const [applied] = await Promise.all([waitForAction(), applyButton.click()]);
    assert.equal(applied.status(), 200);
    const result = await applied.json();
    assert.equal(result.targetPath, "reviewed.ts");
    const saved = await requestJson(gatewayUrl, `${workbenchUrl}/file?path=reviewed.ts`);
    assertOk(saved, "read the exact source bytes after the reviewed rename");
    assert.equal(saved.body.content, concurrent.body.content);
    assert.equal(result.tree.items.some((entry) => entry.path === "index.ts"), false);
    assert.deepEqual(submittedRevisions, [reviewed.revision, current.revision]);
    await form.getByText("Rename done.", { exact: true }).waitFor();
    assertBrowserConsoleHealthy(browserLog, logCursor, NEXT_UI_PACKAGE);
    await page.setViewportSize({ width: 1440, height: 1080 });
    const appliedArtifacts = await captureBrowserArtifacts(context, { slug: "workbench-path-reviewed-rename", page, browserLog, gatewayUrl, correlationId, logCursor });
    return {
      metrics: { unreviewedPathActionRejected: 1, stalePathActionRejected: 1, explicitlyReviewedPathAction: 1 },
      diagnostics: { reviewed, current, submittedRevisions, unguardedStatus: 400, conflictStatus: 409, applyStatus: 200, preservedContent: saved.body.content },
      artifacts: Object.fromEntries(Object.keys(appliedArtifacts).map((key) => [key, [...appliedArtifacts[key], ...conflictArtifacts[key], ...narrowArtifacts[key]]])),
    };
  } finally { await page.unroute(`**${actionUrl}`, intercept); }
}
