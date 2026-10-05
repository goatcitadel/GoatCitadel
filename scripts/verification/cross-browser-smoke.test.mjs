import assert from "node:assert/strict";
import test from "node:test";
import { SMOKE_ROUTES, parseSmokeArgs, smokeRoute, smokeUrl } from "./cross-browser-smoke.mjs";
import { cockpitVisualDataSettled } from "./lib/scenarios/cockpit-visual-readiness.mjs";

const SMOKE_PATHS = SMOKE_ROUTES.map((route) => route?.href);

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

test("gives every area a ready check of its own", () => {
  for (const [index, route] of SMOKE_ROUTES.entries()) {
    assert.ok(route?.readySelector || route?.readyText, `smoke route ${index} has no area ready check`);
  }
});

// Stands in for a Playwright browser. The area stays on its loading placeholder unless `settles`.
function fakeBrowser({ settles }) {
  const calls = [];
  let current = "";
  const waitFor = (step) => ({ first: () => ({ waitFor: async () => calls.push(step) }) });
  const page = {
    on: () => undefined,
    context: () => ({ addInitScript: async () => calls.push("theme") }),
    goto: async (url) => {
      current = url;
      calls.push("goto");
    },
    url: () => current,
    waitForFunction: async (fn) => {
      calls.push(fn.name);
      if (fn === cockpitVisualDataSettled && !settles)
        throw new Error("page.waitForFunction: Timeout 30000ms exceeded.\nCall log: waiting for function");
    },
    locator: (selector) => waitFor(selector),
    getByRole: (role, { name }) => waitFor(`${role} ${name}`),
    waitForTimeout: async () => calls.push("settle"),
    screenshot: async () => calls.push("screenshot"),
    close: async () => calls.push("close"),
  };
  return { calls, browser: { newPage: async () => page } };
}

const work = SMOKE_ROUTES.find((route) => route?.href === "/work");

test("waits for the area itself, not just the shell, before calling a route ok", async () => {
  const { browser, calls } = fakeBrowser({ settles: true });
  const result = await smokeRoute(browser, "webkit", "http://127.0.0.1:5173", work, "screenshots");
  assert.deepEqual(result, { engine: "webkit", path: "/work", problems: [] });
  assert.deepEqual(calls, [
    "theme",
    "goto",
    "cockpitVisualShellReady",
    work.readySelector,
    "heading Work",
    "cockpitVisualDataSettled",
    "settle",
    "screenshot",
    "close",
  ]);
});

test("fails an area still on its loading placeholder and keeps the screenshot", async () => {
  const { browser, calls } = fakeBrowser({ settles: false });
  const result = await smokeRoute(browser, "firefox", "http://127.0.0.1:5173", work, "screenshots");
  assert.deepEqual(result.problems, ["load failed: page.waitForFunction: Timeout 30000ms exceeded."]);
  assert.ok(calls.includes("screenshot"));
});
