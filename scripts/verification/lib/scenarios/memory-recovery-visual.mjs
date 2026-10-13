import assert from "node:assert/strict";

/** Inspect the actual recovery state at both widths without repeating a write. */
export async function captureMemoryRecoveryVisual(
  context,
  stack,
  deps,
  { page, browserLog, correlationId, logCursor, slug },
) {
  const original = page.viewportSize();
  const artifacts = [];
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await page.addScriptTag({ path: deps.axeSourcePath });
      const audit = await deps.auditPageAccessibility(page);
      const blocking = audit.violations.filter((item) => ["serious", "critical"].includes(item.impact));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const name = `${slug}-${width}`;
      const filename = deps.path.join(context.artifactRoot, "diagnostics", `${name}-accessibility.json`);
      await deps.writeJson(filename, { viewport: page.viewportSize(), overflow, violations: audit.violations });
      artifacts.push(
        await deps.captureBrowserArtifacts(context, {
          slug: name,
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
          logCursor,
        }),
      );
      assert.deepEqual(
        blocking.map((item) => item.id),
        [],
        "Memory recovery has blocking accessibility violations.",
      );
      assert.equal(overflow, false, "Memory recovery overflows the viewport.");
      artifacts.at(-1).diagnostics.push(deps.relativeToRun(context, filename));
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
  return Object.fromEntries(Object.keys(artifacts[0]).map((key) => [key, artifacts.flatMap((item) => item[key])]));
}
