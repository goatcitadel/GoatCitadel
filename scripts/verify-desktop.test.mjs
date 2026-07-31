import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createDesktopVerificationIsolation, runIsolatedLauncherStatus } from "./lib/desktop-verification-isolation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop verification cannot mistake an unrelated authenticated runtime for its lane stack", async (t) => {
  const foreignRequests = [];
  const foreignGateway = http.createServer((request, response) => {
    foreignRequests.push(`gateway:${request.method}:${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/v1/onboarding/startup") {
      response.end(JSON.stringify({ completed: true }));
      return;
    }
    if (request.url === "/api/v1/auth/sse-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const foreignUi = http.createServer((request, response) => {
    foreignRequests.push(`ui:${request.method}:${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await Promise.all([listen(foreignGateway), listen(foreignUi)]);
  t.after(async () => {
    await Promise.all([close(foreignGateway), close(foreignUi)]);
  });

  const ambientHome = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-desktop-ambient-test-"));
  t.after(() => removeTestRoot(ambientHome, "goatcitadel-desktop-ambient-test-"));
  const ambientEnv = {
    ...process.env,
    GOATCITADEL_HOME: ambientHome,
    GOATCITADEL_APP_DIR: repoRoot,
    GOATCITADEL_GATEWAY_URL: serverUrl(foreignGateway),
    GOATCITADEL_MISSION_CONTROL_URL: serverUrl(foreignUi),
  };

  const contaminated = await runIsolatedLauncherStatus(repoRoot, ambientEnv);
  assert.equal(contaminated.status, 0, contaminated.stderr);
  const contaminatedStatus = JSON.parse(contaminated.stdout);
  assert.equal(contaminatedStatus.status, "ready");
  assert.equal(contaminatedStatus.desktopEventStream?.error, "Unauthorized");
  const requestCountBeforeIsolation = foreignRequests.length;

  const isolation = await createDesktopVerificationIsolation();
  t.after(() => isolation.dispose());
  const isolatedEnv = isolation.buildLauncherEnvironment(ambientEnv, repoRoot);
  assert.equal(isolatedEnv.GOATCITADEL_GATEWAY_URL, isolation.gatewayUrl);
  assert.equal(isolatedEnv.GOATCITADEL_MISSION_CONTROL_URL, isolation.uiUrl);
  assert.notEqual(isolatedEnv.GOATCITADEL_HOME, ambientHome);

  const isolated = await runIsolatedLauncherStatus(repoRoot, isolatedEnv);
  assert.equal(isolated.status, 0, isolated.stderr);
  const isolatedStatus = JSON.parse(isolated.stdout);
  assert.equal(isolatedStatus.status, "stopped");
  assert.deepEqual(isolatedStatus.readiness, { gateway: false, ui: false });
  assert.equal(isolatedStatus.pids.gateway.state, "missing");
  assert.equal(isolatedStatus.pids.ui.state, "missing");
  assert.equal(isolatedStatus.desktopEventStream, undefined);
  assert.equal(foreignRequests.length, requestCountBeforeIsolation);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function removeTestRoot(root, prefix) {
  const resolvedRoot = path.resolve(root);
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}${prefix}`;
  assert.ok(resolvedRoot.startsWith(expectedPrefix));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
