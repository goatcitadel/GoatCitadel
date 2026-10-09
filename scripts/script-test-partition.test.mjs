import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseScriptTestArgs } from "./run-script-tests.mjs";
import {
  NATIVE_WINDOWS_SCRIPT_TEST_FILES,
  listScriptTestFiles,
  selectScriptTestFiles,
} from "./script-test-partition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every native Windows script test exists and is a remote-worker native proof", () => {
  const all = listScriptTestFiles(repoRoot);
  assert.equal(new Set(NATIVE_WINDOWS_SCRIPT_TEST_FILES).size, NATIVE_WINDOWS_SCRIPT_TEST_FILES.length);
  for (const file of NATIVE_WINDOWS_SCRIPT_TEST_FILES) {
    assert.ok(all.includes(file), `${file} must exist`);
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(source, /win32/, `${file} must gate its native bodies on win32 so Linux hygiene stays cheap`);
  }
});

test("on Windows the hygiene and native suites partition every script test exactly once", () => {
  const all = listScriptTestFiles(repoRoot);
  const hygiene = selectScriptTestFiles(all, "hygiene", "win32");
  const native = selectScriptTestFiles(all, "native-windows", "win32");
  assert.deepEqual(native, [...NATIVE_WINDOWS_SCRIPT_TEST_FILES].sort());
  assert.equal(hygiene.some((file) => native.includes(file)), false);
  assert.deepEqual([...hygiene, ...native].sort(), all);
  assert.ok(hygiene.includes("scripts/script-test-partition.test.mjs"), "this guard must run in hygiene");
});

test("off Windows hygiene keeps every script test so portable tests in native files still run", () => {
  const all = listScriptTestFiles(repoRoot);
  assert.deepEqual(selectScriptTestFiles(all, "hygiene", "linux"), all);
  assert.deepEqual(selectScriptTestFiles(all, "native-windows", "linux"), []);
});

test("partition rejects unknown suites and a stale native list", () => {
  assert.throws(() => selectScriptTestFiles([], "everything", "win32"), /Unknown script test suite/);
  assert.throws(() => selectScriptTestFiles(["scripts/other.test.mjs"], "hygiene", "win32"), /names missing file/);
});

test("script test discovery skips node_modules and returns repo-relative forward-slash paths", () => {
  const all = listScriptTestFiles(repoRoot);
  assert.ok(all.length > NATIVE_WINDOWS_SCRIPT_TEST_FILES.length);
  for (const file of all) {
    assert.match(file, /^scripts\/.+\.test\.mjs$/);
    assert.equal(file.includes("node_modules"), false);
  }
});

test("runner arguments default to hygiene at concurrency 2 and reject unknown flags", () => {
  assert.deepEqual(parseScriptTestArgs([]), { suite: "hygiene", concurrency: 2 });
  assert.deepEqual(parseScriptTestArgs(["--suite=native-windows", "--test-concurrency=1"]), {
    suite: "native-windows",
    concurrency: 1,
  });
  assert.throws(() => parseScriptTestArgs(["--bogus"]), /Unexpected argument/);
  assert.throws(() => parseScriptTestArgs(["--test-concurrency=0"]), /Unexpected argument/);
});
