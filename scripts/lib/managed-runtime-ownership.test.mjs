import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessLauncherEndpointOwnership,
  assessManagedStopSafety,
  buildEndpointOwnershipDiagnostic,
  formatManagedEndpointCollision,
  parseManagedProcessMetadata,
  resolveLauncherEndpoint,
} from "./managed-runtime-ownership.mjs";
import { queryProcessCreationIdentity } from "./managed-runtime-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcherPath = path.join(repoRoot, "bin", "goatcitadel.mjs");
const PID_STATES = ["missing", "invalid", "running", "stale", "reused", "unverified"];

test("managed process metadata rejects legacy PID files and validates the complete identity", () => {
  const metadata = {
    pid: 4242,
    processIdentity: "windows:123456789",
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    service: "gateway",
    startedAt: "2026-07-29T20:00:00.000Z",
  };
  assert.deepEqual(
    parseManagedProcessMetadata(JSON.stringify(metadata), {
      expectedService: "gateway",
      isProcessAlive: (pid) => pid === 4242,
    }),
    { ...metadata, state: "running" },
  );
  assert.deepEqual(
    parseManagedProcessMetadata(JSON.stringify(metadata), {
      expectedService: "gateway",
      isProcessAlive: () => false,
    }),
    { ...metadata, state: "stale" },
  );
  assert.deepEqual(parseManagedProcessMetadata("4242", { expectedService: "gateway", isProcessAlive: () => true }), {
    state: "invalid",
    reason: "legacy_integer",
  });
  assert.deepEqual(
    parseManagedProcessMetadata(JSON.stringify({ ...metadata, service: "mission-control" }), {
      expectedService: "gateway",
      isProcessAlive: () => true,
    }),
    { state: "invalid", reason: "service_mismatch" },
  );
  assert.deepEqual(
    parseManagedProcessMetadata("fixture-secret", { expectedService: "gateway", isProcessAlive: () => true }),
    { state: "invalid", reason: "invalid_json" },
  );
});

test("managed endpoint readiness requires live metadata and the exact health identity", () => {
  const exactReady = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "running",
    endpointResponded: true,
    endpointHealthy: true,
    identityMatched: true,
  });
  assert.equal(exactReady.readinessAccepted, true);
  assert.equal(exactReady.launchAction, "attach");

  const exactDegraded = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "running",
    endpointResponded: true,
    endpointHealthy: false,
    identityMatched: true,
  });
  assert.equal(exactDegraded.readinessAccepted, false);
  assert.equal(exactDegraded.collision, false);
  assert.equal(exactDegraded.launchAction, "wait_managed");

  const starting = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "running",
    endpointResponded: false,
    endpointHealthy: false,
    identityMatched: false,
  });
  assert.equal(starting.readinessAccepted, false);
  assert.equal(starting.collision, false);
  assert.equal(starting.launchAction, "wait_managed");

  for (const pidState of ["missing", "invalid", "stale"]) {
    const occupied = assessLauncherEndpointOwnership({
      attachmentMode: "managed",
      pidState,
      endpointResponded: true,
      endpointHealthy: true,
      identityMatched: false,
    });
    assert.equal(occupied.readinessAccepted, false, pidState);
    assert.equal(occupied.collision, true, pidState);
    assert.equal(occupied.launchAction, "reject_collision", pidState);

    const available = assessLauncherEndpointOwnership({
      attachmentMode: "managed",
      pidState,
      endpointResponded: false,
      endpointHealthy: false,
      identityMatched: false,
    });
    assert.equal(available.collision, false, pidState);
    assert.equal(available.launchAction, "spawn", pidState);
  }

  const reused = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "reused",
    endpointResponded: false,
    endpointHealthy: false,
    identityMatched: false,
  });
  assert.equal(reused.launchAction, "spawn");
  assert.equal(reused.readinessAccepted, false);

  const unverified = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "unverified",
    endpointResponded: false,
    endpointHealthy: false,
    identityMatched: false,
  });
  assert.equal(unverified.launchAction, "wait_managed");
  assert.equal(unverified.readinessAccepted, false);
});

test("a reused live PID with an unrelated listener cannot authorize attach or stop", () => {
  const assessment = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "running",
    endpointResponded: true,
    endpointHealthy: true,
    identityMatched: false,
  });
  assert.equal(assessment.readinessAccepted, false);
  assert.equal(assessment.collision, true);
  assert.equal(assessment.reason, "managed_identity_mismatch");
  assert.deepEqual(
    assessManagedStopSafety({
      attachmentMode: "managed",
      pidState: "running",
      identityMatched: false,
    }),
    { allowed: false, reason: "identity_unverified" },
  );
  assert.deepEqual(
    assessManagedStopSafety({
      attachmentMode: "managed",
      pidState: "reused",
      identityMatched: false,
    }),
    { allowed: false, reason: "metadata_reused" },
  );
  assert.deepEqual(
    assessManagedStopSafety({
      attachmentMode: "managed",
      pidState: "running",
      identityMatched: true,
    }),
    { allowed: true, reason: "managed_identity_verified" },
  );
});

test("explicit endpoint overrides remain external attachments and never authorize managed stop", () => {
  for (const pidState of PID_STATES) {
    for (const endpointHealthy of [false, true]) {
      const assessment = assessLauncherEndpointOwnership({
        attachmentMode: "external_override",
        pidState,
        endpointResponded: endpointHealthy,
        endpointHealthy,
        identityMatched: false,
      });
      assert.equal(assessment.readinessAccepted, endpointHealthy, `${pidState}/${endpointHealthy}`);
      assert.equal(assessment.collision, false);
      assert.equal(assessment.launchAction, endpointHealthy ? "attach" : "wait_external");
      assert.equal(
        assessManagedStopSafety({ attachmentMode: "external_override", pidState, identityMatched: false }).allowed,
        false,
      );
    }
  }

  assert.deepEqual(resolveLauncherEndpoint({ defaultUrl: "http://127.0.0.1:8787", overrideValue: "  " }), {
    url: "http://127.0.0.1:8787",
    attachmentMode: "managed",
    explicitOverride: false,
  });
  assert.deepEqual(
    resolveLauncherEndpoint({
      defaultUrl: "http://127.0.0.1:8787",
      overrideValue: " http://127.0.0.1:8787/ ",
    }),
    {
      url: "http://127.0.0.1:8787",
      attachmentMode: "external_override",
      explicitOverride: true,
    },
  );
});

test("ownership diagnostics and collision copy expose only bounded decision fields", () => {
  const assessment = assessLauncherEndpointOwnership({
    attachmentMode: "managed",
    pidState: "invalid",
    endpointResponded: true,
    endpointHealthy: true,
    identityMatched: false,
  });
  assert.deepEqual(buildEndpointOwnershipDiagnostic(assessment), {
    attachmentMode: "managed",
    pidState: "invalid",
    endpointResponded: true,
    endpointHealthy: true,
    identityVerified: false,
    readinessAccepted: false,
    conflict: true,
    launchAction: "reject_collision",
    reason: "managed_endpoint_collision",
  });
  const message = formatManagedEndpointCollision({
    serviceLabel: "Gateway",
    defaultUrl: "http://operator:secret@127.0.0.1:8787/private?token=secret",
    overrideEnvKey: "GOATCITADEL_GATEWAY_URL",
    assessment,
  });
  assert.match(message, /Gateway default endpoint http:\/\/127\.0\.0\.1:8787 is reachable/);
  assert.match(message, /managed process metadata is invalid/);
  assert.match(message, /GOATCITADEL_GATEWAY_URL/);
  assert.doesNotMatch(message, /operator|secret|private|token/);
});

test("packaged launch intentionally attaches to explicit external endpoints without managed metadata", async (t) => {
  const gatewayRequests = [];
  const uiRequests = [];
  const gateway = createLauncherFixtureServer(gatewayRequests);
  const ui = createLauncherFixtureServer(uiRequests);
  await Promise.all([listen(gateway), listen(ui)]);
  t.after(async () => Promise.all([close(gateway), close(ui)]));

  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-launcher-ownership-"));
  t.after(() => removeOwnedTestRoot(installRoot));
  materializePackagedFixture(installRoot);
  const runtimeDir = path.join(installRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const invalidMetadataSecret = "fixture-secret-that-must-not-be-rendered";
  fs.writeFileSync(path.join(runtimeDir, "gateway.pid"), invalidMetadataSecret, "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ui.pid"), invalidMetadataSecret, "utf8");

  const result = await runLauncher(["launch", "--json", "--no-open"], {
    ...process.env,
    GOATCITADEL_HOME: installRoot,
    GOATCITADEL_GATEWAY_URL: serverUrl(gateway),
    GOATCITADEL_MISSION_CONTROL_URL: serverUrl(ui),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(invalidMetadataSecret));
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "ready");
  assert.deepEqual(payload.readiness, { gateway: true, ui: true });
  assert.equal(payload.pids.gateway.state, "invalid");
  assert.equal(payload.pids.ui.state, "invalid");
  assert.equal(payload.endpointOwnership.gateway.attachmentMode, "external_override");
  assert.equal(payload.endpointOwnership.ui.attachmentMode, "external_override");
  assert.equal(payload.endpointOwnership.gateway.metadataReason, "invalid_json");
  assert.equal(payload.endpointOwnership.ui.metadataReason, "invalid_json");
  assert.equal(payload.endpointOwnership.gateway.conflict, false);
  assert.equal(payload.endpointOwnership.ui.conflict, false);
  assert.ok(gatewayRequests.includes("GET:/health"));
  assert.ok(uiRequests.includes("GET:/health"));
});

test("real concurrent packaged launches serialize and start one process per managed service", async (t) => {
  const [gatewayPort, uiPort] = await reservePorts(2);
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-launcher-ownership-"));
  const codeRoot = path.join(installRoot, "launcher-code");
  const startLogPath = path.join(installRoot, "managed-starts.ndjson");
  const ownedIdentities = new Map();
  materializeManagedPackagedFixture(installRoot);
  const fixtureLauncher = materializeLauncherCodeFixture(codeRoot, gatewayPort, uiPort);
  const launcherEnv = {
    ...process.env,
    GOATCITADEL_HOME: installRoot,
    GC_TEST_MANAGED_START_LOG: startLogPath,
    GC_TEST_MANAGED_START_DELAY_MS: "250",
  };
  t.after(async () => {
    await runLauncher(["stop", "--json"], launcherEnv, fixtureLauncher).catch(() => undefined);
    for (const [pid, identity] of ownedIdentities) {
      const current = queryProcessCreationIdentity(pid);
      if (current.status === "running" && current.identity === identity) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The owned fixture process already exited.
        }
      }
    }
    removeOwnedTestRoot(installRoot);
  });

  const [first, second] = await Promise.all([
    runLauncher(["launch", "--json", "--no-open"], launcherEnv, fixtureLauncher),
    runLauncher(["launch", "--json", "--no-open"], launcherEnv, fixtureLauncher),
  ]);
  const statusProbe = await runLauncher(["status", "--json"], launcherEnv, fixtureLauncher);
  const launchDiagnostics = JSON.stringify({
    first,
    second,
    statusProbe,
    gatewayMetadata: fs.readFileSync(path.join(installRoot, "runtime", "gateway.pid"), "utf8"),
    uiMetadata: fs.readFileSync(path.join(installRoot, "runtime", "ui.pid"), "utf8"),
    starts: fs.readFileSync(startLogPath, "utf8"),
    gatewayStdout: fs.readFileSync(path.join(installRoot, "runtime", "logs", "gateway.stdout.log"), "utf8"),
    gatewayStderr: fs.readFileSync(path.join(installRoot, "runtime", "logs", "gateway.stderr.log"), "utf8"),
    uiStdout: fs.readFileSync(path.join(installRoot, "runtime", "logs", "mission-control.stdout.log"), "utf8"),
    uiStderr: fs.readFileSync(path.join(installRoot, "runtime", "logs", "mission-control.stderr.log"), "utf8"),
  });
  assert.equal(first.status, 0, launchDiagnostics);
  assert.equal(second.status, 0, launchDiagnostics);
  assert.equal(statusProbe.status, 0, launchDiagnostics);
  assert.equal(JSON.parse(first.stdout).status, "ready");
  assert.equal(JSON.parse(second.stdout).status, "ready");
  assert.equal(JSON.parse(statusProbe.stdout).status, "ready");

  const starts = fs
    .readFileSync(startLogPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(starts.filter((entry) => entry.service === "gateway").length, 1);
  assert.equal(starts.filter((entry) => entry.service === "mission-control").length, 1);
  for (const entry of starts) {
    const identity = queryProcessCreationIdentity(entry.pid);
    assert.equal(identity.status, "running");
    ownedIdentities.set(entry.pid, identity.identity);
  }

  for (const service of ["gateway", "ui"]) {
    const metadata = JSON.parse(fs.readFileSync(path.join(installRoot, "runtime", `${service}.pid`), "utf8"));
    assert.ok(metadata.processIdentity);
    assert.ok(metadata.servingPid);
    assert.ok(metadata.servingProcessIdentity);
  }

  const stop = await runLauncher(["stop", "--json"], launcherEnv, fixtureLauncher);
  assert.equal(stop.status, 0, stop.stderr || stop.stdout);
  assert.equal(JSON.parse(stop.stdout).stopped.length, 2, stop.stderr || stop.stdout);
  assert.equal(fs.existsSync(path.join(installRoot, "runtime", "gateway.pid")), false);
  assert.equal(fs.existsSync(path.join(installRoot, "runtime", "ui.pid")), false);
});

test("health deadline remains active when a listener stalls after sending headers", async (t) => {
  const sockets = new Set();
  const stalled = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":"ok"');
  });
  stalled.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(stalled);
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(stalled);
  });

  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-launcher-ownership-"));
  t.after(() => removeOwnedTestRoot(installRoot));
  materializePackagedFixture(installRoot);
  const startedAt = Date.now();
  const result = await runLauncher(["status", "--json"], {
    ...process.env,
    GOATCITADEL_HOME: installRoot,
    GOATCITADEL_GATEWAY_URL: serverUrl(stalled),
    GOATCITADEL_MISSION_CONTROL_URL: serverUrl(stalled),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(elapsedMs >= 1_500, `stalled body returned before the health deadline (${elapsedMs}ms)`);
  assert.ok(elapsedMs < 6_000, `stalled body plus child startup consumed ${elapsedMs}ms`);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.readiness, { gateway: false, ui: false });
  assert.equal(payload.endpointOwnership.gateway.endpointHealthy, false);
  assert.equal(payload.endpointOwnership.ui.endpointHealthy, false);
});

test("stop leaves identity-unproven live processes and metadata untouched", async (t) => {
  const requests = [];
  const external = createLauncherFixtureServer(requests);
  await listen(external);
  t.after(() => close(external));

  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    sentinel.once("spawn", resolve);
    sentinel.once("error", reject);
  });
  t.after(() => stopOwnedChild(sentinel));
  assert.ok(sentinel.pid);
  const sentinelIdentity = queryProcessCreationIdentity(sentinel.pid);
  assert.equal(sentinelIdentity.status, "running");

  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-launcher-ownership-"));
  t.after(() => removeOwnedTestRoot(installRoot));
  materializePackagedFixture(installRoot);
  const runtimeDir = path.join(installRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const gatewayMetadataPath = path.join(runtimeDir, "gateway.pid");
  const uiMetadataPath = path.join(runtimeDir, "ui.pid");
  fs.writeFileSync(
    gatewayMetadataPath,
    JSON.stringify({
      pid: sentinel.pid,
      processIdentity: sentinelIdentity.identity,
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      service: "gateway",
      startedAt,
    }),
    "utf8",
  );
  fs.writeFileSync(
    uiMetadataPath,
    JSON.stringify({
      pid: sentinel.pid,
      processIdentity: sentinelIdentity.identity,
      instanceId: "223e4567-e89b-42d3-a456-426614174000",
      service: "mission-control",
      startedAt,
    }),
    "utf8",
  );

  const launcherEnv = {
    ...process.env,
    GOATCITADEL_HOME: installRoot,
    GOATCITADEL_GATEWAY_URL: serverUrl(external),
    GOATCITADEL_MISSION_CONTROL_URL: serverUrl(external),
  };
  const result = await runLauncher(["stop", "--json"], launcherEnv);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.stopped, []);
  assert.equal(payload.notStopped.length, 2);
  assert.ok(payload.notStopped.every((item) => item.reason === "external_override"));
  assert.ok(isProcessAlive(sentinel.pid));
  assert.equal(fs.existsSync(gatewayMetadataPath), true);
  assert.equal(fs.existsSync(uiMetadataPath), true);

  const textResult = await runLauncher(["stop"], launcherEnv);
  assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
  assert.match(textResult.stdout, /Not stopped: ui \(external_override; managed identity verified: no\)\./u);
  assert.match(textResult.stdout, /Not stopped: gateway \(external_override; managed identity verified: no\)\./u);
  assert.ok(isProcessAlive(sentinel.pid));
});

function createLauncherFixtureServer(requests) {
  return http.createServer((request, response) => {
    requests.push(`${request.method}:${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/api/v1/onboarding/startup") {
      response.end(JSON.stringify({ completed: true }));
      return;
    }
    if (request.url === "/api/v1/auth/sse-token") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "not needed" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
}

function materializePackagedFixture(installRoot) {
  const appRoot = path.join(installRoot, "app");
  fs.mkdirSync(path.join(appRoot, "gateway", "dist"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "mission-control", "dist"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "release-manifest.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(appRoot, "gateway", "dist", "main.js"), "\n", "utf8");
  fs.writeFileSync(path.join(appRoot, "mission-control", "dist", "index.html"), "\n", "utf8");
  fs.writeFileSync(path.join(appRoot, "runtime", "ui-static-server.mjs"), "\n", "utf8");
}

function materializeManagedPackagedFixture(installRoot) {
  materializePackagedFixture(installRoot);
  const fixtureServerSource = [
    'import fs from "node:fs";',
    'import http from "node:http";',
    "const service = process.env.GOATCITADEL_MANAGED_SERVICE;",
    'const port = Number(service === "gateway" ? process.env.GATEWAY_PORT : process.env.GOATCITADEL_UI_PORT);',
    'const host = service === "gateway" ? process.env.GATEWAY_HOST : process.env.GOATCITADEL_UI_HOST;',
    'fs.appendFileSync(process.env.GC_TEST_MANAGED_START_LOG, JSON.stringify({ service, pid: process.pid }) + "\\n");',
    "const server = http.createServer((request, response) => {",
    '  response.setHeader("content-type", "application/json");',
    '  if (request.url === "/health") {',
    '    response.end(JSON.stringify({ status: "ok", service, managedInstanceId: process.env.GOATCITADEL_MANAGED_INSTANCE_ID, managedProcessId: process.pid }));',
    "    return;",
    "  }",
    '  if (request.url === "/livez") { response.end(JSON.stringify({ status: "ok" })); return; }',
    '  if (request.url === "/api/v1/onboarding/startup") { response.end(JSON.stringify({ completed: true })); return; }',
    '  if (request.url === "/api/v1/auth/sse-token") { response.statusCode = 400; response.end(JSON.stringify({ error: "not needed" })); return; }',
    "  response.statusCode = 404;",
    '  response.end(JSON.stringify({ error: "not found" }));',
    "});",
    "setTimeout(() => server.listen(port, host), Number(process.env.GC_TEST_MANAGED_START_DELAY_MS || 0));",
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  fs.writeFileSync(path.join(installRoot, "app", "gateway", "package.json"), '{"type":"module"}\n', "utf8");
  fs.writeFileSync(path.join(installRoot, "app", "gateway", "dist", "main.js"), fixtureServerSource, "utf8");
  fs.writeFileSync(path.join(installRoot, "app", "runtime", "ui-static-server.mjs"), fixtureServerSource, "utf8");
}

function materializeLauncherCodeFixture(codeRoot, gatewayPort, uiPort) {
  const launcherDir = path.join(codeRoot, "bin");
  const helperDir = path.join(codeRoot, "scripts", "lib");
  fs.mkdirSync(launcherDir, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  const source = fs
    .readFileSync(launcherPath, "utf8")
    .replace(
      'const defaultGatewayUrl = "http://127.0.0.1:8787";',
      `const defaultGatewayUrl = "http://127.0.0.1:${gatewayPort}";`,
    )
    .replace('const defaultUiUrl = "http://127.0.0.1:5173";', `const defaultUiUrl = "http://127.0.0.1:${uiPort}";`);
  const fixtureLauncher = path.join(launcherDir, "goatcitadel.mjs");
  fs.writeFileSync(fixtureLauncher, source, "utf8");
  for (const helper of ["managed-runtime-lifecycle.mjs", "managed-runtime-ownership.mjs", "ui-target.mjs"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", "lib", helper), path.join(helperDir, helper));
  }
  return fixtureLauncher;
}

function runLauncher(args, env, entry = launcherPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

async function reservePorts(count) {
  const servers = Array.from({ length: count }, () => http.createServer());
  await Promise.all(servers.map((server) => listen(server)));
  const ports = servers.map((server) => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  });
  await Promise.all(servers.map((server) => close(server)));
  return ports;
}

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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

function removeOwnedTestRoot(root) {
  const resolvedRoot = path.resolve(root);
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}goatcitadel-launcher-ownership-`;
  assert.ok(resolvedRoot.startsWith(expectedPrefix));
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
