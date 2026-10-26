import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_DIST_DIR,
  DEFAULT_MOUNT_TIMEOUT_MS,
  describePageError,
  evaluateBootResult,
  parseBootSmokeArgs,
  resolveStaticFile,
  summarizeBootResults,
} from "./mc-next-production-boot-smoke.mjs";

test("parses defaults, --dist and --timeout-ms", () => {
  assert.deepEqual(parseBootSmokeArgs([]), { dist: DEFAULT_DIST_DIR, timeoutMs: DEFAULT_MOUNT_TIMEOUT_MS });
  const parsed = parseBootSmokeArgs(["--dist", "some/dist", "--timeout-ms", "5000"]);
  assert.equal(parsed.dist, path.resolve("some/dist"));
  assert.equal(parsed.timeoutMs, 5000);
});

test("rejects unknown flags, missing values and bad timeouts", () => {
  assert.throws(() => parseBootSmokeArgs(["--port", "1"]), /Unknown or incomplete argument/);
  assert.throws(() => parseBootSmokeArgs(["--dist"]), /Unknown or incomplete argument/);
  assert.throws(() => parseBootSmokeArgs(["--timeout-ms", "0"]), /positive integer/);
  assert.throws(() => parseBootSmokeArgs(["--timeout-ms", "abc"]), /positive integer/);
});

test("static resolution stays inside dist and falls back for unknown paths", () => {
  const dist = path.resolve("/tmp/dist");
  const exists = (file) => file === path.join(dist, "assets", "a.js");
  assert.equal(resolveStaticFile(dist, "/assets/a.js", exists), path.join(dist, "assets", "a.js"));
  assert.equal(resolveStaticFile(dist, "/chat", exists), null);
  assert.equal(
    resolveStaticFile(dist, "/../secret.txt", () => true),
    null,
  );
  assert.equal(
    resolveStaticFile(dist, "/%2e%2e/secret.txt", () => true),
    null,
  );
  assert.equal(
    resolveStaticFile(dist, "/%E0%A4%A", () => true),
    null,
  );
});

test("a mounted root with no page errors passes", () => {
  const result = evaluateBootResult({ route: "/chat", rootChildCount: 1, pageErrors: [] });
  assert.deepEqual(result, { route: "/chat", ok: true, problems: [] });
});

test("an unmounted root, a page error or a navigation failure each fail the route", () => {
  assert.equal(evaluateBootResult({ route: "/", rootChildCount: 0, pageErrors: [] }).ok, false);
  assert.equal(evaluateBootResult({ route: "/", rootChildCount: -1, pageErrors: [] }).ok, false);
  const withError = evaluateBootResult({ route: "/", rootChildCount: 2, pageErrors: ["TypeError: boom"] });
  assert.equal(withError.ok, false);
  assert.deepEqual(withError.problems, ["page error: TypeError: boom"]);
  const nav = evaluateBootResult({ route: "/", rootChildCount: 0, pageErrors: [], navigationError: "net::ERR" });
  assert.match(nav.problems[0], /navigation failed: net::ERR/);
});

test("summary reports every failing route with its problems", () => {
  const pass = evaluateBootResult({ route: "/a", rootChildCount: 1, pageErrors: [] });
  const fail = evaluateBootResult({ route: "/b", rootChildCount: 0, pageErrors: ["TypeError: x\n  at y"] });
  assert.equal(summarizeBootResults([pass]).ok, true);
  const summary = summarizeBootResults([pass, fail]);
  assert.equal(summary.ok, false);
  assert.match(summary.text, /PASS \/a/);
  assert.match(summary.text, /FAIL \/b/);
  assert.match(summary.text, /never mounted/);
  assert.match(summary.text, /TypeError: x/);
});

test("page error description keeps the message and a short stack", () => {
  const text = describePageError({ message: "TypeError: m", stack: "TypeError: m\n at a\n at b\n at c\n at d" });
  assert.match(text, /^TypeError: m\n at a/);
  assert.equal(text.split("\n").length, 4);
  assert.equal(describePageError("plain"), "plain");
});
