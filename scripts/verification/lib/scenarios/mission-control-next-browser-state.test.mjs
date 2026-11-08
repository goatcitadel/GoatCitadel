import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Exercise the actual private fixture owner without importing unrelated runtime lanes.
const source = await fs.readFile(new URL("../scenarios.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function installMissionControlNextBrowserState(");
const end = source.indexOf("\nfunction forceVerificationUiPackage(", start);
assert(start >= 0 && end > start, "the browser-state fixture owner must exist exactly once");
assert.equal(source.indexOf("async function installMissionControlNextBrowserState(", start + 1), -1);
const install = vm.runInNewContext("(" + source.slice(start, end).trim() + ")");

async function state(options) {
  const storage = new Map();
  let scripts = 0;
  const context = {
    async addInitScript(fn, argument) {
      scripts += 1;
      vm.runInNewContext("(" + fn.toString() + ")(" + JSON.stringify(argument) + ")", {
        window: { localStorage: { setItem(key, value) { storage.set(key, String(value)); } } },
      });
    },
  };
  await install(context, "fixture-workspace", "fixture-citadel", options);
  assert.equal(scripts, 1, "one init script must own the complete preference selection");
  assert.equal(storage.get("goatcitadel.ui.workspace_id.v1"), "fixture-workspace");
  assert.equal(storage.get("goatcitadel.ui.citadel_id.v1"), "fixture-citadel");
  assert.equal(storage.get("goatcitadel.ui.mode.v1"), "simple");
  return storage.get("goatcitadel.ui.technical_details.v1");
}

test("default fixture keeps simple mode and technical details off", async () => {
  assert.equal(await state(undefined), "false");
});
test("an explicit technical inspection survives the single browser-state installation", async () => {
  assert.equal(await state({ showTechnicalDetails: true }), "true");
});
test("an explicit false preference keeps technical details off", async () => {
  assert.equal(await state({ showTechnicalDetails: false }), "false");
});
test("truthy strings do not silently enable expert inspection", async () => {
  assert.equal(await state({ showTechnicalDetails: "true" }), "false");
});
