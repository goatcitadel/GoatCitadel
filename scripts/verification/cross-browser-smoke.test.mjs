import assert from "node:assert/strict";
import test from "node:test";
import { SMOKE_PATHS, parseSmokeArgs, smokeUrl } from "./cross-browser-smoke.mjs";

test("parses the cockpit origin and the engines", () => {
  assert.deepEqual(parseSmokeArgs(["--ui", "http://127.0.0.1:5173/chat?x=1"]), {
    ui: "http://127.0.0.1:5173",
    engines: ["firefox", "webkit"],
  });
  assert.deepEqual(parseSmokeArgs(["--ui", "http://127.0.0.1:5173", "--engines", "webkit"]).engines, ["webkit"]);
  assert.deepEqual(parseSmokeArgs(["--ui", "http://127.0.0.1:5173", "--engines", "firefox, chromium"]).engines, [
    "firefox",
    "chromium",
  ]);
});

test("rejects unknown engines, unknown flags and non-http URLs", () => {
  assert.throws(() => parseSmokeArgs(["--ui", "http://127.0.0.1:5173", "--engines", "edge"]), /Unknown engine/);
  assert.throws(() => parseSmokeArgs(["--port", "5173"]), /Unknown or incomplete argument/);
  assert.throws(() => parseSmokeArgs(["--ui", "file:///tmp/cockpit.html"]), /http/);
});

test("does not mistake inherited object keys for engines", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    assert.throws(() => parseSmokeArgs(["--ui", "http://127.0.0.1:5173", "--engines", name]), /Unknown engine/);
  }
});

test("refuses a run that would check nothing", () => {
  assert.throws(() => parseSmokeArgs([]), /--ui/);
  assert.throws(() => parseSmokeArgs(["--ui", "http://127.0.0.1:5173", "--engines", ","]), /at least one engine/);
});

test("opens every area in the cockpit shell", () => {
  for (const routePath of SMOKE_PATHS) {
    assert.equal(new URL(smokeUrl("http://127.0.0.1:5173", routePath)).searchParams.get("shell"), "cockpit");
  }
});

test("covers each cockpit area once", () => {
  assert.equal(new Set(SMOKE_PATHS).size, SMOKE_PATHS.length);
  for (const area of ["chat", "inbox", "work", "library", "system", "settings"]) {
    assert.ok(
      SMOKE_PATHS.some((routePath) => routePath.split("/")[1] === area),
      `no smoke path opens ${area}`,
    );
  }
});
