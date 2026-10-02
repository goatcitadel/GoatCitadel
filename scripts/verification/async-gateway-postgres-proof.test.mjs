import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EVENT_LOOP_MAX_LIMIT_MS,
  EVENT_LOOP_P99_LIMIT_MS,
  buildAsyncGatewayProofEnv,
  buildGuardNodeOptions,
  buildDispatchPlan,
  buildScopedPostgresConnectionString,
  createDisposablePostgresSchema,
  evaluateAsyncGatewayMetrics,
  evaluateRuntimeLogs,
  resolveLivePostgresPrerequisite,
  runTurnWithCheckpoint,
  sanitizeAsyncGatewayProofError,
} from "./async-gateway-postgres-proof.mjs";
import { POSTGRES_RECOVERY_URL_ENV } from "./usability-postgres-recovery.mjs";
import { RESEARCH_ARTIFACT_GAP_QUERIES, RESEARCH_ARTIFACT_TASK_COUNT } from "./research-artifact-reliability.mjs";

const PASSWORD = "async-gateway-proof-password";
const LOOPBACK_URL = `postgresql://proof:${PASSWORD}@127.0.0.1:55432/goatcitadel?sslmode=disable`;
const GUARD_PATH = path.resolve("scripts/verification/lib/async-gateway-main-thread-guard.cjs");

test("PostgreSQL research tasks acquire canonical evidence before attempting a deck", () => {
  const plan = buildDispatchPlan();
  const stepsPerTask = RESEARCH_ARTIFACT_GAP_QUERIES.length + 2;
  assert.equal(plan.length, RESEARCH_ARTIFACT_TASK_COUNT * stepsPerTask);
  for (let index = 0; index < RESEARCH_ARTIFACT_TASK_COUNT; index += 1) {
    const task = plan.slice(index * stepsPerTask, (index + 1) * stepsPerTask);
    const searches = task.slice(0, -2);
    assert.deepEqual(searches.map((step) => step.arguments.query), RESEARCH_ARTIFACT_GAP_QUERIES);
    assert.ok(searches.every((step) => step.name === "browser_search" && step.arguments.firecrawlFallbackToNative === false));
    assert.equal(task.at(-2).name, "presentations_create");
    assert.equal(task.at(-1).type, "success");
  }
  assert.equal(plan[stepsPerTask].delayMs, 2_000, "the CHECKPOINT task must remain active at its first provider dispatch");
});

test("live PostgreSQL prerequisite skips only when the explicit URL is absent", () => {
  assert.deepEqual(resolveLivePostgresPrerequisite({}), { configured: false });
  const configured = resolveLivePostgresPrerequisite({ [POSTGRES_RECOVERY_URL_ENV]: LOOPBACK_URL });
  assert.deepEqual(
    {
      configured: configured.configured,
      rawUrl: configured.rawUrl,
      host: configured.host,
      port: configured.port,
      database: configured.database,
    },
    {
      configured: true,
      rawUrl: LOOPBACK_URL,
      host: "127.0.0.1",
      port: "55432",
      database: "goatcitadel",
    },
  );
  assert.ok(configured.sensitiveValues.includes(PASSWORD));
  assert.throws(
    () =>
      resolveLivePostgresPrerequisite({
        [POSTGRES_RECOVERY_URL_ENV]: `postgresql://proof:${PASSWORD}@db.example.test:55432/goatcitadel`,
      }),
    /exact loopback host/u,
  );
});

test("scoped connection string isolates Gateway writes without exposing it in result metadata", () => {
  const scoped = buildScopedPostgresConnectionString(LOOPBACK_URL, "gc_async_gateway_abcdef012345");
  const parsed = new URL(scoped);
  assert.equal(parsed.searchParams.get("sslmode"), "disable");
  assert.equal(parsed.searchParams.get("options"), "-c search_path=gc_async_gateway_abcdef012345");
  assert.equal(decodeURIComponent(parsed.password), PASSWORD);
  assert.throws(
    () => buildScopedPostgresConnectionString(LOOPBACK_URL, "public; DROP SCHEMA public"),
    /unsafe disposable PostgreSQL schema name/u,
  );
});

test("live proof errors redact both the complete URL and decoded password", () => {
  const configured = resolveLivePostgresPrerequisite({ [POSTGRES_RECOVERY_URL_ENV]: LOOPBACK_URL });
  const sanitized = sanitizeAsyncGatewayProofError(
    new Error(`connection failed for ${LOOPBACK_URL} using ${PASSWORD}`),
    configured.sensitiveValues,
  );
  assert.doesNotMatch(sanitized.message, /async-gateway-proof-password|postgresql:\/\//u);
  assert.match(sanitized.message, /\[REDACTED_VERIFICATION_SECRET\]/u);
});

test("disposable schema owner creates, checkpoints, and drops only its generated schema", async () => {
  const queries = [];
  let ended = false;
  const database = await createDisposablePostgresSchema(LOOPBACK_URL, {
    poolFactory: async () => ({
      query: async (sql) => {
        queries.push(sql);
        return { rows: [] };
      },
      end: async () => {
        ended = true;
      },
    }),
  });
  assert.match(database.schemaName, /^gc_async_gateway_[a-f0-9]{32}$/u);
  assert.match(queries[0], /^CREATE SCHEMA "gc_async_gateway_[a-f0-9]{32}"$/u);
  const checkpoint = await database.runCheckpoint();
  assert.equal(queries[1], "CHECKPOINT");
  assert.ok(checkpoint.durationMs >= 0);
  await database.cleanup();
  assert.match(queries[2], /^DROP SCHEMA IF EXISTS "gc_async_gateway_[a-f0-9]{32}" CASCADE$/u);
  assert.equal(ended, true);
});

test("checkpoint starts only after a provider dispatch while the turn remains active", async () => {
  let releaseTurn;
  let turnComplete = false;
  let activityObserved = false;
  const turnPromise = new Promise((resolve) => {
    releaseTurn = () => {
      turnComplete = true;
      resolve({ turnId: "turn-2" });
    };
  });
  const resultPromise = runTurnWithCheckpoint({
    startTurn: () => turnPromise,
    waitForTurnActivity: async () => {
      activityObserved = true;
    },
    runCheckpoint: async () => {
      assert.equal(activityObserved, true);
      assert.equal(turnComplete, false);
      releaseTurn();
      return { durationMs: 12 };
    },
  });
  assert.deepEqual(await resultPromise, { turn: { turnId: "turn-2" }, checkpoint: { durationMs: 12 } });
});

test("idle PostgreSQL errors fail the proof and still close the disposable pool", async () => {
  const pool = new EventEmitter();
  const queries = [];
  let ended = false;
  pool.query = async (sql) => { queries.push(sql); return { rows: [] }; };
  pool.end = async () => { ended = true; };
  const database = await createDisposablePostgresSchema(LOOPBACK_URL, { poolFactory: async () => pool });
  assert.doesNotThrow(() => pool.emit("error", new Error("read ECONNRESET")));
  assert.throws(() => database.assertHealthy(), /idle connection failed: read ECONNRESET/u);
  await assert.rejects(database.runCheckpoint(), /idle connection failed/u);
  await assert.rejects(database.cleanup(), /idle connection failed/u);
  assert.equal(queries.length, 2);
  assert.match(queries[1], /^DROP SCHEMA/u, "cleanup is still attempted after an idle failure");
  assert.equal(ended, true);
});

test("an idle error during schema initialization rejects and closes the pool", async () => {
  const pool = new EventEmitter();
  let ended = false;
  pool.query = async () => { pool.emit("error", new Error("server terminated")); return { rows: [] }; };
  pool.end = async () => { ended = true; };
  await assert.rejects(
    createDisposablePostgresSchema(LOOPBACK_URL, { poolFactory: async () => pool }),
    /idle connection failed: server terminated/u,
  );
  assert.equal(ended, true);
});

test("event-loop acceptance fails closed at thresholds, stale samples, and Atomics.wait", () => {
  const nowMs = Date.now();
  const passing = evaluateAsyncGatewayMetrics(
    {
      guardActive: true,
      mainThread: true,
      updatedAt: new Date(nowMs - 100).toISOString(),
      atomicsWaitCalls: 0,
      eventLoop: { p99Ms: EVENT_LOOP_P99_LIMIT_MS - 1, maxMs: EVENT_LOOP_MAX_LIMIT_MS - 1 },
    },
    { nowMs },
  );
  assert.deepEqual(passing.failures, []);

  const failing = evaluateAsyncGatewayMetrics(
    {
      guardActive: true,
      mainThread: true,
      updatedAt: new Date(nowMs - 10_000).toISOString(),
      atomicsWaitCalls: 1,
      eventLoop: { p99Ms: EVENT_LOOP_P99_LIMIT_MS, maxMs: EVENT_LOOP_MAX_LIMIT_MS },
    },
    { nowMs },
  );
  assert.equal(failing.failures.length, 4);
  assert.match(failing.failures.join("\n"), /Atomics\.wait/u);
  assert.match(failing.failures.join("\n"), /stale/u);
});

test("runtime log evaluator rejects reconnect, repair, timeout, and provider failure notices", () => {
  assert.deepEqual(evaluateRuntimeLogs("Gateway ready\nturn completed").failures, []);
  const result = evaluateRuntimeLogs(
    "Stream interrupted. Reconnecting to turn abc. The provider request failed before repaired completion.",
  );
  assert.ok(result.failures.length > 0);
  assert.ok(result.matches.length >= 3);
});

test("Gateway proof env forces async PostgreSQL and appends the main-thread preload", () => {
  const env = buildAsyncGatewayProofEnv({
    scopedConnectionString: "postgresql://redacted.invalid/test",
    metricsPath: "C:/proof/metrics.json",
    violationsPath: "C:/proof/violations.json",
    guardPath: GUARD_PATH,
    existingNodeOptions: "--enable-source-maps",
  });
  assert.equal(env.GOATCITADEL_DATABASE_DRIVER, "postgres");
  assert.equal(env.GOATCITADEL_POSTGRES_ASYNC_GATEWAY_ENABLED, "true");
  assert.equal(env.GOATCITADEL_BUNDLED_POSTGRES_ENABLED, "false");
  assert.equal(env.GOATCITADEL_DISABLE_RICH_PRESENTATION_VISUALS, "false");
  assert.equal(env.GOATCITADEL_DEBUG_PROMPT_CONTEXT_BUDGET_RECEIPTS, "1");
  assert.match(env.NODE_OPTIONS, /--enable-source-maps/u);
  assert.match(env.NODE_OPTIONS, /--require=/u);
  assert.equal(buildGuardNodeOptions(undefined, GUARD_PATH).includes(JSON.stringify(path.resolve(GUARD_PATH))), true);
});

test("preload records and blocks a main-thread Atomics.wait call", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-async-guard-test-"));
  const metricsPath = path.join(tempRoot, "metrics.json");
  const violationsPath = path.join(tempRoot, "violations.json");
  try {
    const child = spawnSync(
      process.execPath,
      ["-e", "const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(a, 0, 0, 1);"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: buildGuardNodeOptions(process.env.NODE_OPTIONS, GUARD_PATH),
          GOATCITADEL_ASYNC_GATEWAY_PROOF_FORCE_MAIN: "true",
          GOATCITADEL_ASYNC_GATEWAY_PROOF_METRICS_PATH: metricsPath,
          GOATCITADEL_ASYNC_GATEWAY_PROOF_VIOLATIONS_PATH: violationsPath,
        },
      },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Atomics\.wait was invoked on the Gateway main thread/u);
    const violation = JSON.parse(await fs.readFile(violationsPath, "utf8"));
    const metrics = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    assert.equal(violation.atomicsWaitCalls, 1);
    assert.equal(metrics.atomicsWaitCalls, 1);
    assert.equal(metrics.guardActive, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("preload leaves worker-thread Atomics.wait available for isolated compatibility code", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-async-guard-worker-test-"));
  const metricsPath = path.join(tempRoot, "metrics.json");
  const violationsPath = path.join(tempRoot, "violations.json");
  const workerSource = [
    'const { parentPort } = require("node:worker_threads");',
    "const values = new Int32Array(new SharedArrayBuffer(4));",
    "parentPort.postMessage(Atomics.wait(values, 0, 0, 1));",
  ].join(" ");
  const mainSource = [
    'const { Worker } = require("node:worker_threads");',
    `const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true });`,
    'worker.once("message", (value) => process.exit(value === "timed-out" ? 0 : 2));',
    'worker.once("error", (error) => { console.error(error); process.exit(3); });',
  ].join(" ");
  try {
    const child = spawnSync(process.execPath, ["-e", mainSource], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: buildGuardNodeOptions(process.env.NODE_OPTIONS, GUARD_PATH),
        GOATCITADEL_ASYNC_GATEWAY_PROOF_FORCE_MAIN: "true",
        GOATCITADEL_ASYNC_GATEWAY_PROOF_METRICS_PATH: metricsPath,
        GOATCITADEL_ASYNC_GATEWAY_PROOF_VIOLATIONS_PATH: violationsPath,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const metrics = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    assert.equal(metrics.atomicsWaitCalls, 0);
    await assert.rejects(fs.access(violationsPath), (error) => error?.code === "ENOENT");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
