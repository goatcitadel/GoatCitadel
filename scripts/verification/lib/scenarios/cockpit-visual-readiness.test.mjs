import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  cockpitVisualDataSettled, cockpitVisualShellReady, installCockpitVisualPreferences, waitForCockpitVisualRouteReady,
} from "./cockpit-visual-readiness.mjs";

const run = (fn, input, scope) => vm.runInNewContext(`(${fn.toString()})(input)`, { ...scope, input });
function shell(overrides = {}) {
  const state = { shell: "cockpit", theme: "light", pathname: "/settings/safety", main: true, nav: true, classic: false, auth: false, firstRun: false, ...overrides };
  return {
    location: { pathname: state.pathname },
    document: {
      documentElement: { dataset: { shell: state.shell, theme: state.theme } },
      querySelector(selector) {
        if (selector.includes("data-cockpit-ready")) return state.main ? {} : null;
        if (selector === ".mc-next-shell") return state.classic ? {} : null;
        if (selector === ".gateway-access-shell") return state.auth ? {} : null;
        if (selector.includes("First-run setup")) return state.firstRun ? {} : null;
        return state.nav ? {} : null;
      },
    },
  };
}
const expected = { pathname: "/settings/safety", theme: "light", fullscreen: false };
test("native readiness rejects premature marker, wrong shell, route, theme and access gate", () => {
  assert.equal(run(cockpitVisualShellReady, expected, shell()), true);
  for (const mismatch of [{ shell: "classic" }, { theme: "dark" }, { pathname: "/settings/general" }, { main: false }, { nav: false }, { classic: true }, { auth: true }]) {
    assert.equal(run(cockpitVisualShellReady, expected, shell(mismatch)), false, JSON.stringify(mismatch));
  }
  assert.equal(run(cockpitVisualShellReady, { ...expected, fullscreen: true }, shell({ nav: false })), false);
  assert.equal(run(cockpitVisualShellReady, { ...expected, fullscreen: true }, shell({ nav: false, firstRun: true })), true);
});

test("settlement withholds visible loading/busy content without rejecting terminal unknown status", () => {
  const status = (textContent, visible = true, busy = false) => ({
    textContent, getClientRects: () => visible ? [{}] : [], getAttribute: () => busy ? "true" : null,
  });
  const settled = items => run(cockpitVisualDataSettled, undefined, { document: { querySelector: () => ({ querySelectorAll: () => items }) } });
  assert.equal(settled([status("Loading current provider…")]), false);
  assert.equal(settled([status("Checking setup state…")]), false);
  assert.equal(settled([status("Work", true, true)]), false);
  assert.equal(settled([status("Loading hidden owner", false)]), true);
  assert.equal(settled([status("Availability unknown")]), true);
  assert.equal(run(cockpitVisualDataSettled, undefined, { document: { querySelector: () => null } }), false);
});

test("native theme preference is applied before mount only for explicit cockpit navigation", async () => {
  let callback, input;
  await installCockpitVisualPreferences({ addInitScript: async (fn, args) => { callback = fn; input = args; } }, { colorScheme: "light" });
  for (const [query, count] of [["?shell=cockpit", 1], ["?shell=classic", 0], ["", 0]]) {
    const writes = [];
    run(callback, input, { URL, window: { location: { href: `http://test.invalid/settings/general${query}` }, localStorage: { setItem: (...args) => writes.push(args) } } });
    assert.equal(writes.length, count);
    if (count) assert.deepEqual(writes[0], ["goatcitadel.ui.theme.v1", "light"]);
  }
});

test("native route wait requires exact active page selector and heading before data settlement", async () => {
  const calls = [];
  const page = {
    url: () => "http://test.invalid/settings/safety?theme=light&shell=cockpit",
    waitForFunction: async (fn, args, options) => { calls.push({ fn, args, options }); },
    locator: selector => ({ first: () => ({ waitFor: async () => calls.push({ selector }) }) }),
    getByRole: (role, options) => ({ first: () => ({ waitFor: async () => calls.push({ role, options }) }) }),
  };
  await waitForCockpitVisualRouteReady(page, { href: "/settings/safety", readySelector: 'section[aria-label="Safety"]', readyText: "Settings" }, 100);
  assert.equal(calls[0].fn, cockpitVisualShellReady);
  assert.deepEqual(calls[0].args, expected);
  assert.equal(calls[1].selector, 'section[aria-label="Safety"]');
  assert.deepEqual(calls[2], { role: "heading", options: { name: "Settings", exact: true } });
  assert.equal(calls[3].fn, cockpitVisualDataSettled);
});

test("gallery capture waits for the actual component gallery and its visible heading", async () => {
  const calls = [];
  const page = {
    url: () => "http://test.invalid/__gallery?theme=dark&shell=cockpit",
    waitForFunction: async (fn, args) => calls.push({ fn, args }),
    locator: selector => ({ first: () => ({ waitFor: async () => calls.push({ selector }) }) }),
    getByRole: (role, options) => ({ first: () => ({ waitFor: async () => calls.push({ role, options }) }) }),
  };
  await waitForCockpitVisualRouteReady(page, { href: "/__gallery", readySelector: '[data-cockpit-gallery="true"]', readyText: "Cockpit components" }, 100);
  assert.deepEqual(calls[0].args, { pathname: "/__gallery", theme: "dark", fullscreen: false });
  assert.equal(calls[1].selector, '[data-cockpit-gallery="true"]');
  assert.deepEqual(calls[2], { role: "heading", options: { name: "Cockpit components", exact: true } });
  assert.equal(calls[3].fn, cockpitVisualDataSettled);
});
