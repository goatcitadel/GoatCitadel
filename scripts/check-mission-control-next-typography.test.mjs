import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectTypographyViolations, findTypographyViolations } from "./check-mission-control-next-typography.mjs";

test("findTypographyViolations flags hardcoded font sizes but allows tokens, zero, and clamp", () => {
  const css = [
    ".a { font-size: 12px; }",
    ".b { font-size: 0.6rem; }",
    ".c { font-size: var(--text-xs); }",
    ".d { font-size: var(--text-xs, 0.75rem); }",
    ".e { font-size: 0; }",
    ".f { font-size: clamp(1.55rem, 3vw, 2rem); }",
    ".g { font: 600 0.7rem/1 var(--mc-font-mono); }",
    ".h { font: 600 var(--text-2xs)/1 var(--mc-font-mono); }",
    ".i { font: inherit; }",
  ].join("\n");
  const violations = findTypographyViolations("fixture.css", css);
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [1, 2, 7],
  );
});

test("collectTypographyViolations walks a scan root and reports zero on a clean tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-typography-"));
  try {
    const scanRoot = path.join(root, "src");
    await fs.mkdir(path.join(scanRoot, "styles"), { recursive: true });
    await fs.writeFile(
      path.join(scanRoot, "styles", "ok.css"),
      ".ok { font-size: var(--text-sm); }\n.hero { font-size: clamp(1.5rem, 3vw, 2rem); }\n",
      "utf8",
    );
    const clean = await collectTypographyViolations({ scanRoot });
    assert.equal(clean.violations.length, 0);

    await fs.writeFile(path.join(scanRoot, "styles", "bad.css"), ".bad { font-size: 9px; }\n", "utf8");
    const dirty = await collectTypographyViolations({ scanRoot });
    assert.equal(dirty.violations.length, 1);
    assert.equal(dirty.violations[0].property, "font-size");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
