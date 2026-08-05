"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads must remain CommonJS. */

const fs = require("node:fs");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { isMainThread } = require("node:worker_threads");

const METRICS_PATH_ENV = "GOATCITADEL_ASYNC_GATEWAY_PROOF_METRICS_PATH";
const VIOLATIONS_PATH_ENV = "GOATCITADEL_ASYNC_GATEWAY_PROOF_VIOLATIONS_PATH";
const FORCE_ENV = "GOATCITADEL_ASYNC_GATEWAY_PROOF_FORCE_MAIN";
const gatewayEntrypointPattern = /[\\/]apps[\\/]gateway[\\/]dist[\\/]main\.js$/u;
const forceMain = /^(?:1|true)$/iu.test(String(process.env[FORCE_ENV] ?? ""));
const isGatewayMain = gatewayEntrypointPattern.test(String(process.argv[1] ?? ""));

if (isMainThread && (isGatewayMain || forceMain)) {
  const metricsPath = requireOutputPath(METRICS_PATH_ENV);
  const violationsPath = requireOutputPath(VIOLATIONS_PATH_ENV);
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  fs.mkdirSync(path.dirname(violationsPath), { recursive: true });

  const startedAt = new Date().toISOString();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let atomicsWaitCalls = 0;

  const writeMetrics = () => {
    writeJson(metricsPath, {
      schemaVersion: 1,
      pid: process.pid,
      mainThread: true,
      guardActive: true,
      startedAt,
      updatedAt: new Date().toISOString(),
      uptimeMs: Math.round(process.uptime() * 1_000),
      eventLoop: {
        p99Ms: nanosecondsToMilliseconds(histogram.percentile(99)),
        maxMs: nanosecondsToMilliseconds(histogram.max),
        meanMs: nanosecondsToMilliseconds(histogram.mean),
        minMs: nanosecondsToMilliseconds(histogram.min),
        exceeds250ms: histogram.exceeds,
      },
      atomicsWaitCalls,
    });
  };

  const originalWait = Atomics.wait;
  Object.defineProperty(Atomics, "wait", {
    configurable: false,
    enumerable: false,
    writable: false,
    value() {
      atomicsWaitCalls += 1;
      const violation = {
        schemaVersion: 1,
        pid: process.pid,
        mainThread: true,
        detectedAt: new Date().toISOString(),
        atomicsWaitCalls,
        message: "Atomics.wait was invoked on the Gateway main thread during async-storage verification.",
        stack: new Error("Gateway main-thread Atomics.wait violation").stack,
      };
      writeJson(violationsPath, violation);
      writeMetrics();
      throw new Error(violation.message);
    },
  });

  // Preserve an inspectable reference without exposing it through the public
  // Atomics object. This is useful only to make the preload's intent explicit:
  // worker threads retain their native implementation because this block is
  // gated by isMainThread.
  void originalWait;

  writeMetrics();
  const timer = setInterval(writeMetrics, 200);
  timer.unref();
  process.once("beforeExit", writeMetrics);
  process.once("exit", writeMetrics);
}

function requireOutputPath(envName) {
  const value = String(process.env[envName] ?? "").trim();
  if (!value) throw new Error(`${envName} is required by the async Gateway proof preload`);
  return path.resolve(value);
}

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? Math.round((value / 1e6) * 1_000) / 1_000 : null;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
