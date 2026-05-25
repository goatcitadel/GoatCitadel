import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectTokenDriftViolations } from "./check-mission-control-next-token-drift.mjs";

async function withFixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-token-drift-"));
  try {
    const scanRoot = path.join(root, "apps", "mission-control-next", "src");
    await fs.mkdir(scanRoot, { recursive: true });
    await fn({ root, scanRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("token drift check rejects deprecated token declarations in normal CSS files", async () => {
  await withFixture(async ({ scanRoot }) => {
    const cssPath = path.join(scanRoot, "features", "new-route.css");
    await fs.mkdir(path.dirname(cssPath), { recursive: true });
    await fs.writeFile(cssPath, ".new-route { --mc-new-panel: red; color: var(--mc-new-panel); }\n", "utf8");

    const result = await collectTokenDriftViolations({
      scanRoot,
      grandfatheredDeclarations: new Map(),
    });

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].token, "--mc-new-panel");
  });
});

test("token drift check only allows explicitly baselined declarations in grandfathered CSS files", async () => {
  await withFixture(async ({ root, scanRoot }) => {
    const cssPath = path.join(scanRoot, "styles", "mission-control-next.css");
    await fs.mkdir(path.dirname(cssPath), { recursive: true });
    await fs.writeFile(
      cssPath,
      [
        ":root {",
        "  --mc-area-color: teal;",
        "  --mc-fresh-drift: hotpink;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const grandfatheredDeclarations = new Map([[path.resolve(cssPath), new Set(["--mc-area-color"])]]);

    const result = await collectTokenDriftViolations({ scanRoot, grandfatheredDeclarations });

    assert.equal(result.grandfatheredFileCount, 1);
    assert.deepEqual(
      result.violations.map((violation) => violation.token),
      ["--mc-fresh-drift"],
    );
    assert.equal(result.violations[0].file, path.resolve(root, "apps/mission-control-next/src/styles/mission-control-next.css"));
  });
});
