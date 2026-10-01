import assert from "node:assert/strict";
import test from "node:test";
import { clickClassicOwnerNavigation } from "./classic-owner-navigation.mjs";

for (const posture of ["desktop", "mobile", "collapsed"]) {
  test(`waits for lazy classic chrome before ${posture} navigation`, async () => {
    let hydrated = false, visible = false, toggles = 0, clicked = false;
    const topbar = {
      waitFor: async () => { hydrated = true; visible = posture === "desktop"; },
      getByRole(role, { name }) {
        assert.equal(role, "button");
        const actualName = posture === "mobile" ? "Open navigation" : "Expand sidebar";
        assert.ok(name.test(actualName));
        return { click: async () => { assert.ok(hydrated); toggles++; visible = true; } };
      },
    };
    const page = { locator: selector => {
      assert.equal(selector, ".mc-next-shell .mc-next-topbar");
      return topbar;
    } };
    const target = {
      isVisible: async () => { assert.ok(hydrated, "Visibility was checked before chrome mounted."); return visible; },
      waitFor: async () => assert.ok(visible),
      click: async () => { assert.ok(visible); clicked = true; },
    };
    await clickClassicOwnerNavigation(page, target);
    assert.equal(clicked, true);
    assert.equal(toggles, posture === "desktop" ? 0 : 1);
  });
}

test("a failed classic mount cannot trigger a guessed drawer click", async () => {
  let inspected = false;
  await assert.rejects(clickClassicOwnerNavigation({ locator: () => ({ waitFor: async () => { throw new Error("classic mount failed"); } }) }, {
    isVisible: async () => { inspected = true; return false; },
  }), /classic mount failed/u);
  assert.equal(inspected, false);
});
