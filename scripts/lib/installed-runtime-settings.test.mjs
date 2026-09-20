import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readInstalledRuntimeSettings } from "./installed-runtime-settings.mjs";

test("managed install ports persist independently and reject invalid collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readInstalledRuntimeSettings(root), { gatewayPort: 8787, uiPort: 5173 });
  fs.mkdirSync(path.join(root, "runtime"));
  const file = path.join(root, "runtime", "launcher-settings.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, gatewayPort: 8788, uiPort: 5175 }));
  assert.deepEqual(readInstalledRuntimeSettings(root), { gatewayPort: 8788, uiPort: 5175 });
  for (const invalid of [
    { schemaVersion: 1, gatewayPort: 5175, uiPort: 5175 },
    { schemaVersion: 1, gatewayPort: "8788", uiPort: 5175 },
    { schemaVersion: 1, gatewayPort: 70000, uiPort: 5175 },
    { schemaVersion: 2, gatewayPort: 8788, uiPort: 5175 },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => readInstalledRuntimeSettings(root), /Invalid launcher-settings/);
  }
});
