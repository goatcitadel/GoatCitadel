import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectIconSizingViolations,
  findIconSizingViolations,
} from "./check-mission-control-next-icon-sizing.mjs";

test("icon sizing guard rejects numeric utility classes and accepts explicit sizes", () => {
  const fixture = [
    '<RefreshCw className="h-4 w-4" />',
    '<RefreshCw size={16} />',
    '<span className="h-full w-full" />',
    '<Icon className="tone-muted" size={12} />',
  ].join("\n");

  const violations = findIconSizingViolations("fixture.tsx", fixture);
  assert.deepEqual(violations.map((violation) => violation.line), [1]);
  assert.deepEqual(violations[0].tokens, ["h-4", "w-4"]);
});

test("icon sizing guard scans nested TSX sources", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-icon-sizing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "clean.tsx"), '<RefreshCw size={16} />\n', "utf8");
  await fs.writeFile(path.join(root, "nested", "bad.tsx"), '<Icon className="h-3 w-3" />\n', "utf8");

  const result = await collectIconSizingViolations({ scanRoot: root });
  assert.equal(result.files.length, 2);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].line, 1);
});
