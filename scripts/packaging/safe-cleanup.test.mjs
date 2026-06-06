import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertSafeRecursiveCleanup } from "./safe-cleanup.mjs";

test("safe recursive cleanup allows artifact children", () => {
  const repoRoot = path.resolve("repo");
  const allowedRoot = path.join(repoRoot, "artifacts", "installers");
  const target = path.join(allowedRoot, "bundles", "GoatCitadel-test");

  assert.equal(
    assertSafeRecursiveCleanup(target, {
      repoRoot,
      allowedRoot,
      cwd: path.join(repoRoot, "scripts"),
    }).targetPath,
    normalizeExpected(target),
  );
});

test("safe recursive cleanup rejects cwd and cwd ancestors", () => {
  const repoRoot = path.resolve("repo");
  const allowedRoot = path.join(repoRoot, "artifacts");
  const cwd = path.join(allowedRoot, "installers", "windows");

  assert.throws(
    () =>
      assertSafeRecursiveCleanup(cwd, {
        repoRoot,
        allowedRoot,
        cwd,
      }),
    /current working directory/,
  );
  assert.throws(
    () =>
      assertSafeRecursiveCleanup(path.join(allowedRoot, "installers"), {
        repoRoot,
        allowedRoot,
        cwd,
      }),
    /ancestor of cwd/,
  );
});

function normalizeExpected(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

test("safe recursive cleanup rejects repo root, filesystem root, and outside roots", () => {
  const repoRoot = path.resolve("repo");
  const allowedRoot = path.join(repoRoot, "artifacts");
  const cwd = path.join(repoRoot, "scripts");

  assert.throws(
    () =>
      assertSafeRecursiveCleanup(repoRoot, {
        repoRoot,
        allowedRoot,
        cwd,
      }),
    /repo root/,
  );
  assert.throws(
    () =>
      assertSafeRecursiveCleanup(path.parse(repoRoot).root, {
        repoRoot,
        allowedRoot,
        cwd,
      }),
    /filesystem root/,
  );
  assert.throws(
    () =>
      assertSafeRecursiveCleanup(path.join(repoRoot, "apps"), {
        repoRoot,
        allowedRoot,
        cwd,
      }),
    /outside allowed root/,
  );
});
