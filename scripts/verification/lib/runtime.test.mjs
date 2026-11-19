import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { setImmediate } from "node:timers";
import { test } from "node:test";

import {
  buildVerificationGatewayCommand,
  buildVerificationGatewayEnv,
  buildVerificationProcessEnv,
  buildVerificationProcessLogName,
  buildVerificationUiCommand,
  buildVerificationWorkspaceRefreshCommands,
  requestJson,
  startProcess,
  stopProcess,
  stopVerificationStack,
  waitForHttp,
  withVerificationUiOrigin,
} from "./runtime.mjs";

test("verification readiness times out when a server accepts a connection without sending headers", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      waitForHttp(`http://127.0.0.1:${server.address().port}/health`, "Stalled fixture", 150),
      /did not become ready in time/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("verification readiness interrupts a stalled request when its child exits", { timeout: 4_000 }, async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-runtime-"));
  const handle = await startProcess({ artifactRoot }, "fixture", [
    process.execPath,
    "-e",
    'process.stderr.write("diagnostic"); setInterval(() => {}, 1000)',
  ]);
  const server = createServer(() => handle.child.kill("SIGTERM"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      waitForHttp(`http://127.0.0.1:${server.address().port}/health`, "Exited fixture", 15_000, handle),
      /Exited fixture process exited before becoming ready/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await stopProcess(handle);
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification readiness releases both healthy and unhealthy probe responses", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async () => {
    const status = bodies.length === 0 ? 503 : 200;
    bodies.push({ status, cancelled: false });
    const probe = bodies.at(-1);
    return new Response(
      new ReadableStream({
        cancel: () => {
          probe.cancelled = true;
        },
      }),
      { status },
    );
  });
  await waitForHttp("http://127.0.0.1:12345/health", "Probe fixture", 2_500);
  assert.deepEqual(bodies, [
    { status: 503, cancelled: true },
    { status: 200, cancelled: true },
  ]);
});

test("verification cleanup observes a signalled child and flushes both diagnostics", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-runtime-"));
  const handle = await startProcess({ artifactRoot }, "fixture", [
    process.execPath,
    "-e",
    'process.stderr.write("diagnostic"); process.stdout.write("ready"); setInterval(() => {}, 1000)',
  ]);
  try {
    await once(handle.child.stdout, "data");
    const exited = once(handle.child, "exit");
    handle.child.kill("SIGTERM");
    await exited;
    await stopProcess(handle);
    assert.equal(await fs.readFile(handle.stdoutPath, "utf8"), "ready");
    assert.equal(await fs.readFile(handle.stderrPath, "utf8"), "diagnostic");
  } finally {
    await stopProcess(handle);
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification diagnostics keep draining the child when one log cannot be opened", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-runtime-"));
  await fs.mkdir(path.join(artifactRoot, "diagnostics", "fixture.stdout.log"), { recursive: true });
  const handle = await startProcess({ artifactRoot }, "fixture", [
    process.execPath,
    "-e",
    'process.stdout.write("x".repeat(1024 * 1024)); process.stderr.write("remaining diagnostic")',
  ]);
  try {
    const [code] = await once(handle.child, "exit");
    await handle.logsFlushed;
    assert.equal(code, 0);
    assert.equal(await fs.readFile(handle.stderrPath, "utf8"), "remaining diagnostic");
  } finally {
    await stopProcess(handle);
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("verification JSON requests preserve primitive bodies and omit undefined", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(init.body);
    return new Response(null, { status: 204 });
  });
  for (const body of [false, 0, "", null, undefined]) {
    await requestJson("http://127.0.0.1", "/fixture", { method: "POST", body });
  }
  assert.deepEqual(bodies, ["false", "0", '""', "null", undefined]);
});

test("verification process environments remove inherited secrets while allowing explicit fixtures", () => {
  const env = buildVerificationProcessEnv(
    {
      PATH: "safe-path",
      OPENAI_API_KEY: "personal-secret",
      GITHUB_TOKEN: "personal-token",
    },
    {
      OPENAI_API_KEY: "deterministic-fixture-key",
      GOATCITADEL_ROOT_DIR: "isolated-root",
    },
    ["OPENAI_API_KEY", "GITHUB_TOKEN"],
  );

  assert.equal(env.PATH, "safe-path");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, "deterministic-fixture-key");
  assert.equal(env.GOATCITADEL_ROOT_DIR, "isolated-root");
});

test("verification process log names preserve defaults and isolate prefixed stacks", () => {
  assert.equal(buildVerificationProcessLogName("gateway", undefined), "gateway");
  assert.equal(buildVerificationProcessLogName("ui", ""), "ui");
  assert.equal(buildVerificationProcessLogName("gateway", "External Sources #2"), "external-sources-2-gateway");
  assert.equal(
    buildVerificationProcessLogName("ui-build-package", "External Sources #2"),
    "external-sources-2-ui-build-package",
  );
});

test("verification startup force-refreshes the threaded Chat surface before Chromium", () => {
  const commands = buildVerificationWorkspaceRefreshCommands();
  assert.deepEqual(commands.gateway.slice(-3), ["--filter", "@goatcitadel/gateway...", "build"]);
  assert.deepEqual(commands.threadedSurfaceCore.slice(2), [
    "--filter",
    "@goatcitadel/threaded-surface-core",
    "exec",
    "tsc",
    "-b",
    "tsconfig.json",
    "--force",
  ]);
});

test("verification stacks name their UI origin for a Gateway that does not trust arbitrary loopback ports", () => {
  const uiOrigin = "http://127.0.0.1:37407";
  // Auth "none" no longer trusts any loopback port, so the UI's own origin joins the Gateway's defaults.
  assert.deepEqual(withVerificationUiOrigin({ GOATCITADEL_AUTH_MODE: "none" }, uiOrigin, {}), {
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_ALLOWED_ORIGINS: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      "http://127.0.0.1:8787",
      uiOrigin,
    ].join(","),
  });
  // A lane's own list, or the inherited one, is kept rather than replaced by the defaults.
  assert.equal(
    withVerificationUiOrigin({ GOATCITADEL_ALLOWED_ORIGINS: " https://ops.example.com , " }, uiOrigin, {})
      .GOATCITADEL_ALLOWED_ORIGINS,
    `https://ops.example.com,${uiOrigin}`,
  );
  assert.equal(
    withVerificationUiOrigin({}, uiOrigin, { GOATCITADEL_ALLOWED_ORIGINS: uiOrigin }).GOATCITADEL_ALLOWED_ORIGINS,
    uiOrigin,
  );
  // An inherited list the lane omits (the test bench scrubs every GOATCITADEL_* variable) is not brought back.
  const scrubbed = buildVerificationProcessEnv({ GOATCITADEL_ALLOWED_ORIGINS: "https://citadel.example.com" }, {}, [
    "GOATCITADEL_ALLOWED_ORIGINS",
  ]);
  assert.doesNotMatch(
    withVerificationUiOrigin({}, uiOrigin, scrubbed).GOATCITADEL_ALLOWED_ORIGINS,
    /citadel\.example\.com/u,
  );
  // A Gateway-only stack changes nothing.
  const gatewayOnly = { GOATCITADEL_AUTH_MODE: "none" };
  assert.equal(withVerificationUiOrigin(gatewayOnly, undefined, {}), gatewayOnly);
});

test("a verification Gateway launches without an inherited origin list its lane omits", () => {
  const uiUrl = "http://127.0.0.1:37407";
  const inherited = { PATH: "safe-path", GOATCITADEL_ALLOWED_ORIGINS: "https://citadel.example.com" };
  const launchEnv = (gatewayEnvOmit) =>
    // What startProcess hands the Gateway process.
    buildVerificationProcessEnv(
      inherited,
      buildVerificationGatewayEnv(
        { runtimeRoot: "isolated-root", gatewayPort: 41000, uiUrl, gatewayEnvOmit },
        inherited,
      ),
      gatewayEnvOmit,
    );

  const omitted = launchEnv(["GOATCITADEL_ALLOWED_ORIGINS"]);
  assert.doesNotMatch(omitted.GOATCITADEL_ALLOWED_ORIGINS, /citadel\.example\.com/u);
  assert.match(omitted.GOATCITADEL_ALLOWED_ORIGINS, /(^|,)http:\/\/127\.0\.0\.1:37407$/u);
  assert.equal(omitted.GOATCITADEL_AUTH_MODE, "none");
  assert.equal(omitted.GATEWAY_PORT, "41000");
  assert.equal(omitted.PATH, "safe-path");
  assert.equal(launchEnv([]).GOATCITADEL_ALLOWED_ORIGINS, `https://citadel.example.com,${uiUrl}`);
});

test("verification Gateway launch directly owns the runtime process", () => {
  const command = buildVerificationGatewayCommand();
  assert.equal(command[0], process.execPath);
  assert.match(command[1].replaceAll("\\", "/"), /node_modules\/tsx\/dist\/cli\.mjs$/u);
  assert.match(command[2].replaceAll("\\", "/"), /apps\/gateway\/src\/main\.ts$/u);
});

test("verification stack cleanup never throws; failures are reported and returned", async () => {
  // Nearly every caller runs cleanup inside `finally`: a throw there would
  // replace the scenario's real failure or redden a passing lane. An invalid
  // runtime root makes fs.rm fail with a non-transient error, which must be
  // captured and returned rather than thrown.
  const errors = await stopVerificationStack({ runtimeRoot: "\0invalid-root" });
  assert.equal(errors.length, 1);

  // A clean or absent stack reports no failures.
  assert.deepEqual(await stopVerificationStack(undefined), []);
  assert.deepEqual(await stopVerificationStack({}), []);
});

test("verification dev UI invalidates Vite dependency prebundles while preview stays immutable", () => {
  const devCommand = buildVerificationUiCommand("@goatcitadel/mission-control-next", 5173, undefined);
  const previewCommand = buildVerificationUiCommand("@goatcitadel/mission-control-next", 4173, "preview");
  assert.equal(devCommand[0], process.execPath);
  assert.match(devCommand[1].replaceAll("\\", "/"), /apps\/mission-control-next\/node_modules\/vite\/bin\/vite\.js$/u);
  assert.deepEqual(devCommand.slice(2), ["--force", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  assert.equal(previewCommand[0], process.execPath);
  assert.match(
    previewCommand[1].replaceAll("\\", "/"),
    /apps\/mission-control-next\/node_modules\/vite\/bin\/vite\.js$/u,
  );
  assert.deepEqual(previewCommand.slice(2), ["preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"]);
});

for (const code of ["EACCES", "EPERM"]) {
  test(`verification HTTP readiness fails fast for permission-denied ${code} probes`, async (t) => {
    const cause = Object.assign(new Error("permission denied"), { code });
    const failure = new TypeError("fetch failed", { cause });
    const probe = t.mock.method(globalThis, "fetch", async () => {
      throw failure;
    });
    await assert.rejects(waitForHttp("http://127.0.0.1:12345/health", "Gateway health", 2_000), (error) => {
      assert.match(error.message, new RegExp(`${code}.*loopback`, "u"));
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(probe.mock.callCount(), 1);
  });
}

test("verification HTTP readiness includes the last HTTP status when a service stays degraded", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"status":"degraded"}', { status: 503 }));
  await assert.rejects(waitForHttp("http://127.0.0.1:12345/health", "Gateway health", 100), /last HTTP status: 503/u);
});

test("verification HTTP readiness still retries connection refusal during startup", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1)
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("starting"), { code: "ECONNREFUSED" }) });
    return new Response(null, { status: 204 });
  });
  await waitForHttp("http://127.0.0.1:12345/health", "Gateway health", 5_000);
  assert.equal(calls, 2);
});

for (const variant of ["omitted", "null", "live-child"]) {
  test(`verification HTTP readiness accepts an in-process server with ${variant} handle`, async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/health`;
      if (variant === "omitted") await waitForHttp(url, "In-process fixture", 2_000);
      else
        await waitForHttp(
          url,
          "In-process fixture",
          2_000,
          variant === "null" ? null : { child: { exitCode: null, signalCode: null } },
        );
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

test("verification HTTP readiness still rejects owned-child failures before any request", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(204).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/health`;
    for (const [label, child] of [
      ["Exited fixture", { exitCode: 7 }],
      ["Signalled fixture", { exitCode: null, signalCode: "SIGTERM" }],
    ]) {
      const { promise: logsFlushed, resolve: releaseLogs } = Promise.withResolvers();
      let settled = false;
      const rejection = assert.rejects(
        waitForHttp(url, label, 2_000, { child, logsFlushed }).finally(() => {
          settled = true;
        }),
        new RegExp(`${label} process exited before becoming ready`, "u"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      const settledBeforeLogs = settled;
      releaseLogs();
      await rejection;
      assert.equal(settledBeforeLogs, false);
    }
    const spawnError = Object.assign(new Error("Synthetic fixture spawn failure"), { code: "ENOENT" });
    await assert.rejects(
      waitForHttp(url, "Unstarted fixture", 2_000, {
        spawnError,
        logsFlushed: Promise.resolve(),
      }),
      (error) => error === spawnError,
    );
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
