import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectVisualBaselineCoverage } from "./visual-baseline-coverage.mjs";

test("visual baseline coverage reports missing and unexpected PNGs as exact-set drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-visual-coverage-"));
  try {
    await fs.writeFile(path.join(root, "expected-a.png"), "a");
    await fs.writeFile(path.join(root, "retired-cowork.png"), "stale");
    await fs.writeFile(path.join(root, "notes.txt"), "ignored");

    const coverage = await collectVisualBaselineCoverage(root, ["expected-a.png", "expected-b.png"]);
    assert.deepEqual(coverage.expectedFiles, ["expected-a.png", "expected-b.png"]);
    assert.deepEqual(coverage.actualFiles, ["expected-a.png", "retired-cowork.png"]);
    assert.deepEqual(coverage.missingFiles, ["expected-b.png"]);
    assert.deepEqual(coverage.unexpectedFiles, ["retired-cowork.png"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("visual baseline coverage treats a missing directory as all expected files missing", async () => {
  const root = path.join(os.tmpdir(), `goatcitadel-visual-missing-${Date.now()}`);
  const coverage = await collectVisualBaselineCoverage(root, ["expected.png"]);
  assert.deepEqual(coverage.actualFiles, []);
  assert.deepEqual(coverage.missingFiles, ["expected.png"]);
  assert.deepEqual(coverage.unexpectedFiles, []);
});
