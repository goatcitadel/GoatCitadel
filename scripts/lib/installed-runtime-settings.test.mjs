import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeInstalledRuntimeSettings, readInstalledRuntimeSettings } from "./installed-runtime-settings.mjs";

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

test("fresh launches choose a free managed UI port without attaching to the default listener", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-fresh-ports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existing = createServer();
  const listening = await new Promise((resolve, reject) => {
    existing.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    existing.listen({ host: "127.0.0.1", port: 5173, exclusive: true }, () => resolve(true));
  });
  if (listening) t.after(() => new Promise((resolve) => existing.close(resolve)));

  await Promise.all([initializeInstalledRuntimeSettings(root), initializeInstalledRuntimeSettings(root)]);
  const ports = readInstalledRuntimeSettings(root);
  assert.notEqual(ports.uiPort, 5173);
  assert.notEqual(ports.uiPort, ports.gatewayPort);
  if (listening) assert.ok(existing.listening);
  await initializeInstalledRuntimeSettings(root);
  assert.deepEqual(readInstalledRuntimeSettings(root), ports);
});

test("first-launch port selection leaves existing profiles and their configured ports alone", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-existing-ports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "runtime-root", "data"), { recursive: true });
  await initializeInstalledRuntimeSettings(root);
  assert.equal(fs.existsSync(path.join(root, "runtime", "launcher-settings.json")), false);
  assert.deepEqual(readInstalledRuntimeSettings(root), { gatewayPort: 8787, uiPort: 5173 });
});
