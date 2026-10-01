import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withNativeCompilerScratch } from "./native-compiler-scratch.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-cl-test-")));
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root);
    assert.ok(path.basename(root).startsWith("gc-cl-test-"));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

test("compiler scratch rejects deep TEMP and cleans only its own fresh directory", (t) => {
  const root = fixture(t);
  const deep = path.join(root, "nested-".repeat(20));
  fs.mkdirSync(deep);
  const sibling = path.join(root, "keep.txt");
  fs.writeFileSync(sibling, "unrelated");
  let selected;
  assert.equal(withNativeCompilerScratch((scratch) => {
    selected = scratch;
    assert.equal(path.dirname(scratch), root);
    assert.ok(scratch.length <= 160);
    fs.writeFileSync(path.join(scratch, "compiler.tmp"), "temporary");
    return 7;
  }, [deep, root]), 7);
  assert.equal(fs.existsSync(selected), false);
  assert.equal(fs.readFileSync(sibling, "utf8"), "unrelated");
  assert.ok(fs.statSync(deep).isDirectory());
});

test("compiler failure still cleans its exact scratch directory", (t) => {
  const root = fixture(t);
  let selected;
  assert.throws(() => withNativeCompilerScratch((scratch) => {
    selected = scratch;
    throw new Error("compiler failed");
  }, [root]), /compiler failed/u);
  assert.equal(fs.existsSync(selected), false);
});

test("compiler scratch refuses a replaced directory without deleting it", (t) => {
  const root = fixture(t);
  let selected;
  assert.throws(() => withNativeCompilerScratch((scratch) => {
    selected = scratch;
    fs.renameSync(scratch, path.join(root, "original"));
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, "replacement.txt"), "keep");
  }, [root]), /ownership changed/u);
  assert.equal(fs.readFileSync(path.join(selected, "replacement.txt"), "utf8"), "keep");
  assert.ok(fs.existsSync(path.join(root, "original")));
});

test("compiler scratch rejects absent or relative roots before running compiler", () => {
  assert.throws(() => withNativeCompilerScratch(() => assert.fail("must not run"), [undefined, "relative"]),
    /short absolute temporary directory/u);
});
