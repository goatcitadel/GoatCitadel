import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildExternalSourcesProcessOptions,
  retainExternalSourcesFailureEvidence,
  resolveExternalSourcesBrowserFlowSecretEnvKeys,
} from "./external-sources-browser-flow.mjs";
import { createExternalSourcesStandaloneIsolation } from "./external-sources-environment.mjs";

test("external-sources stack scrubs gateway and UI processes and carries its log prefix", () => {
  const options = buildExternalSourcesProcessOptions({
    secretEnvKeys: ["OPENAI_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", ""],
    processLogPrefix: " external-sources ",
  });

  assert.deepEqual(options.gatewayEnvOmit, ["OPENAI_API_KEY", "GITHUB_TOKEN"]);
  assert.deepEqual(options.uiEnvOmit, ["OPENAI_API_KEY", "GITHUB_TOKEN"]);
  assert.equal(options.processLogPrefix, "external-sources");
});

test("direct external-sources browser flow resolves the default scrub list instead of using an empty list", async () => {
  const inheritedEnv = {
    PATH: "fixture-path",
    OPENAI_API_KEY: "inherited-provider-secret",
    DATABASE_URL: "postgresql://personal-runtime.example.invalid/database",
  };
  const calls = [];
  const keys = await resolveExternalSourcesBrowserFlowSecretEnvKeys(
    undefined,
    { configRoot: "fixture/config", env: inheritedEnv },
    {
      async collectVerificationSecretEnvKeys(configRoot, env) {
        calls.push({ configRoot, env });
        return ["OPENAI_API_KEY", "DATABASE_URL"];
      },
    },
  );

  assert.deepEqual(calls, [{ configRoot: "fixture/config", env: inheritedEnv }]);
  assert.deepEqual(keys, ["OPENAI_API_KEY", "DATABASE_URL"]);
});

test("direct external-sources browser flow preserves an explicit scrub list", async () => {
  const keys = await resolveExternalSourcesBrowserFlowSecretEnvKeys(
    ["GITHUB_TOKEN", "GITHUB_TOKEN", ""],
    { configRoot: "unused", env: {} },
    {
      async collectVerificationSecretEnvKeys() {
        throw new Error("collector must not replace an explicit list");
      },
    },
  );

  assert.deepEqual(keys, ["GITHUB_TOKEN"]);
});

test("standalone external-sources proof scrubs inherited credentials and only re-adds its hermetic Postgres URL", async () => {
  const inheritedEnv = {
    PATH: "fixture-path",
    SAFE_SETTING: "retained",
    OPENAI_API_KEY: "inherited-provider-secret",
    DATABASE_URL: "postgresql://personal-runtime.example.invalid/database",
    GOATCITADEL_TEST_POSTGRES_URL: "postgresql://personal-runtime.example.invalid/tests",
  };
  const calls = [];
  const isolation = await createExternalSourcesStandaloneIsolation(
    { configRoot: "fixture/config", baseEnv: inheritedEnv },
    {
      async collectVerificationSecretEnvKeys(configRoot, env) {
        calls.push({ configRoot, env });
        return ["OPENAI_API_KEY", "DATABASE_URL", "GOATCITADEL_TEST_POSTGRES_URL"];
      },
    },
  );

  const childEnv = isolation.buildChildEnv({ SAFE_OVERRIDE: "fixture" });
  assert.deepEqual(calls, [{ configRoot: "fixture/config", env: inheritedEnv }]);
  assert.equal(childEnv.PATH, "fixture-path");
  assert.equal(childEnv.SAFE_SETTING, "retained");
  assert.equal(childEnv.SAFE_OVERRIDE, "fixture");
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.DATABASE_URL, undefined);
  assert.equal(childEnv.GOATCITADEL_TEST_POSTGRES_URL, undefined);
  assert.throws(
    () => isolation.buildChildEnv({ DATABASE_URL: "postgresql://should-not-return.example.invalid/database" }),
    /cannot reintroduce scrubbed inherited keys: DATABASE_URL/u,
  );

  const postgresEnv = isolation.buildHermeticPostgresChildEnv("postgresql://gcproof@127.0.0.1:55432/postgres");
  assert.equal(postgresEnv.OPENAI_API_KEY, undefined);
  assert.equal(postgresEnv.DATABASE_URL, undefined);
  assert.equal(postgresEnv.GOATCITADEL_TEST_POSTGRES_URL, "postgresql://gcproof@127.0.0.1:55432/postgres");
  assert.throws(
    () => isolation.buildHermeticPostgresChildEnv("postgresql://personal-runtime.example.invalid/database"),
    /harness-created loopback PostgreSQL URL/u,
  );
});

test("external-sources failures retain the correlated diagnostic bundle and trace", async () => {
  const captures = [];
  const trace = {
    async retain() {
      return "playwright/external-sources-flow-mobile-dark-failure-trace.zip";
    },
  };
  const result = await retainExternalSourcesFailureEvidence(
    { artifactRoot: "artifact-root" },
    {
      page: {},
      browserLog: {},
      gatewayUrl: "http://127.0.0.1:8787",
      correlationId: "external-sources-mobile-dark-correlation",
      logCursor: { consoleMessages: 0, pageErrors: 0 },
      slug: "external-sources-flow-mobile-dark-failure",
      trace,
    },
    {
      async captureBrowserArtifacts(context, input) {
        captures.push({ context, input });
        return {
          diagnostics: ["diagnostics/browser.json", "diagnostics/gateway.json"],
          screenshots: ["screenshots/failure.png"],
          traces: [],
          logs: ["playwright/console.json"],
          perf: [],
          playwright: ["playwright/console.json"],
        };
      },
      appendTraceArtifact(artifacts, traceArtifact) {
        return {
          ...artifacts,
          traces: [...artifacts.traces, traceArtifact],
          playwright: [...artifacts.playwright, traceArtifact],
        };
      },
    },
  );

  assert.equal(captures.length, 1);
  assert.equal(captures[0].input.correlationId, "external-sources-mobile-dark-correlation");
  assert.deepEqual(result.artifacts.diagnostics, ["diagnostics/browser.json", "diagnostics/gateway.json"]);
  assert.deepEqual(result.artifacts.traces, ["playwright/external-sources-flow-mobile-dark-failure-trace.zip"]);
  assert.deepEqual(result.artifacts.playwright, [
    "playwright/console.json",
    "playwright/external-sources-flow-mobile-dark-failure-trace.zip",
  ]);
  assert.equal(result.captureError, undefined);
});

test("external-sources failure evidence reports capture errors without losing the retained trace", async () => {
  const result = await retainExternalSourcesFailureEvidence(
    { artifactRoot: "artifact-root" },
    { trace: { retain: async () => "playwright/failure-trace.zip" } },
    {
      async captureBrowserArtifacts() {
        throw new Error("diagnostics unavailable");
      },
      appendTraceArtifact(artifacts, traceArtifact) {
        return { ...artifacts, traces: [traceArtifact], playwright: [traceArtifact] };
      },
    },
  );

  assert.match(result.captureError, /diagnostics unavailable/u);
  assert.deepEqual(result.artifacts.traces, ["playwright/failure-trace.zip"]);
});
