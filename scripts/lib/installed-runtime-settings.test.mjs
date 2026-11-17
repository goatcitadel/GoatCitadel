import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeInstalledRuntimeSettings,
  installedRuntimeAllowedOrigins,
  readInstalledRuntimeSettings,
} from "./installed-runtime-settings.mjs";

test("managed install ports persist independently and reject invalid collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readInstalledRuntimeSettings(root), { gatewayPort: 8787, uiPort: 5173 });
  fs.mkdirSync(path.join(root, "runtime"));
  const file = path.join(root, "runtime", "launcher-settings.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, gatewayPort: 8788, uiPort: 5175 }));
  assert.deepEqual(readInstalledRuntimeSettings(root), { gatewayPort: 8788, uiPort: 5175 });
  assert.equal(installedRuntimeAllowedOrigins(root), "http://127.0.0.1:5175");
  assert.equal(installedRuntimeAllowedOrigins(root, "https://operator.example"), "https://operator.example");
  fs.mkdirSync(path.join(root, "runtime-root"));
  fs.writeFileSync(path.join(root, "runtime-root", ".env"), 'GOATCITADEL_ALLOWED_ORIGINS="https://profile.example"\n');
  assert.equal(installedRuntimeAllowedOrigins(root), "https://profile.example");
  assert.equal(installedRuntimeAllowedOrigins(root, "https://operator.example"), "https://operator.example");
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

test("managed origins follow the Gateway's selected env file and process precedence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-selected-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileEnv = path.join(root, "runtime-root", ".env");
  const customEnv = path.join(root, "custom.env");
  fs.mkdirSync(path.dirname(profileEnv), { recursive: true });
  fs.writeFileSync(profileEnv, "GOATCITADEL_ALLOWED_ORIGINS=https://profile.example\n");
  fs.writeFileSync(customEnv, "GOATCITADEL_ALLOWED_ORIGINS=https://custom.example\n");
  for (const selector of [customEnv, "../../custom.env"]) {
    const env = { GOATCITADEL_LOCAL_ENV_FILE: selector };
    assert.equal(installedRuntimeAllowedOrigins(root, undefined, env), "https://custom.example");
    assert.equal(
      installedRuntimeAllowedOrigins(root, undefined, {
        ...env,
        GOATCITADEL_ALLOWED_ORIGINS: "https://process.example",
      }),
      "https://process.example",
    );
  }
  fs.unlinkSync(profileEnv);
  const relocatedApp = path.join(root, "relocated-app");
  fs.mkdirSync(path.join(relocatedApp, "gateway"), { recursive: true });
  fs.writeFileSync(
    path.join(relocatedApp, "gateway", "custom.env"),
    "GOATCITADEL_ALLOWED_ORIGINS=https://relocated.example\n",
  );
  const relativeEnv = { GOATCITADEL_LOCAL_ENV_FILE: "custom.env" };
  assert.equal(
    installedRuntimeAllowedOrigins(root, undefined, relativeEnv, path.join(relocatedApp, "gateway")),
    "https://relocated.example",
  );
  assert.equal(
    installedRuntimeAllowedOrigins(root, undefined, {
      ...relativeEnv,
      GOATCITADEL_APP_DIR: relocatedApp,
    }),
    "https://relocated.example",
  );
  assert.equal(
    installedRuntimeAllowedOrigins(root, undefined, {
      GOATCITADEL_LOCAL_ENV_FILE: customEnv,
    }),
    "https://custom.example",
  );
  assert.equal(
    installedRuntimeAllowedOrigins(root, undefined, {
      GOATCITADEL_LOCAL_ENV_FILE: "missing.env",
    }),
    "http://127.0.0.1:5173",
  );
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

test("fresh installs reserve a database port and materialize matching canonical and split config", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-database-port-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const occupiedPort = listener.address().port;
  const templateDir = path.join(root, "app", "templates", "config");
  fs.mkdirSync(templateDir, { recursive: true });
  const assistant = {
    database: {
      driver: "postgres",
      postgres: { mode: "bundled" },
      bundledPostgres: { enabled: true, port: occupiedPort },
    },
  };
  const template = JSON.parse(
    fs.readFileSync(new URL("../../config/goatcitadel.example.json", import.meta.url), "utf8"),
  );
  template.assistant = assistant;
  fs.writeFileSync(path.join(templateDir, "goatcitadel.example.json"), JSON.stringify(template));
  await initializeInstalledRuntimeSettings(root);
  const configDir = path.join(root, "runtime-root", "config");
  const canonical = JSON.parse(fs.readFileSync(path.join(configDir, "goatcitadel.json")));
  const split = JSON.parse(fs.readFileSync(path.join(configDir, "assistant.config.json")));
  assert.notEqual(canonical.assistant.database.bundledPostgres.port, occupiedPort);
  assert.deepEqual(split, canonical.assistant);
  assert.deepEqual(canonical.llm, template.llm);
  assert.ok(listener.listening);
  await initializeInstalledRuntimeSettings(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, "goatcitadel.json"))), canonical);
});
