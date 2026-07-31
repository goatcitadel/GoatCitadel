import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayChatFaultArtifact,
  buildGatewayChatFaultNotes,
  createGatewayChatFaultExecutionConfig,
  GATEWAY_CHAT_FAULT_GATEWAY_MODE,
  GATEWAY_CHAT_FAULT_RESTART_PREFIX,
  GATEWAY_CHAT_FAULT_SCENARIO_ID,
  parseGatewayChatSse,
  runGatewayChatFaultRecoveryLane,
} from "./gateway-chat-fault-recovery-lane.mjs";

const POSTGRES_GATEWAY_ENV = Object.freeze({
  GOATCITADEL_DATABASE_DRIVER: "postgres",
  GOATCITADEL_POSTGRES_MODE: "managed",
  GOATCITADEL_POSTGRES_HOST: "127.0.0.1",
  GOATCITADEL_POSTGRES_PORT: "55432",
  GOATCITADEL_POSTGRES_DATABASE: "goatcitadel",
  GOATCITADEL_POSTGRES_USER: "postgres",
  GOATCITADEL_POSTGRES_PASSWORD: "verification-postgres-password",
  GOATCITADEL_POSTGRES_SSL: "disable",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
});

test("Gateway fault recovery owns the built Gateway process directly", () => {
  assert.equal(GATEWAY_CHAT_FAULT_GATEWAY_MODE, "built");
});

test("Gateway fault execution preserves SQLite as the default usability storage", () => {
  const config = createGatewayChatFaultExecutionConfig({ environment: {} });
  const stackOptions = config.buildStackOptions("C:/runtime", "sqlite-default");

  assert.equal(config.storage, "sqlite");
  assert.equal(Object.hasOwn(stackOptions.gatewayEnv, "GOATCITADEL_DATABASE_DRIVER"), false);
  assert.equal(Object.hasOwn(stackOptions.gatewayEnv, "GOATCITADEL_POSTGRES_PASSWORD"), false);
  assert.match(buildGatewayChatFaultNotes(config.storage)[0], /isolated SQLite/u);
});

test("Gateway fault execution propagates the same managed PostgreSQL environment to initial and restarted stacks", () => {
  const config = createGatewayChatFaultExecutionConfig({
    storage: "postgres",
    gatewayEnv: POSTGRES_GATEWAY_ENV,
    environment: { NODE_OPTIONS: "--enable-source-maps" },
    secretEnvKeys: ["GOATCITADEL_TEST_POSTGRES_URL", "GOATCITADEL_POSTGRES_PASSWORD"],
    sensitiveValues: [POSTGRES_GATEWAY_ENV.GOATCITADEL_POSTGRES_PASSWORD],
  });
  const initial = config.buildStackOptions("C:/runtime", "initial");
  const restarted = config.buildStackOptions("C:/runtime", "restarted");

  assert.equal(config.storage, "postgres");
  assert.equal(initial.gatewayMode, "built");
  assert.equal(restarted.gatewayMode, "built");
  assert.deepEqual(initial.gatewayEnv, restarted.gatewayEnv);
  assert.deepEqual(initial.gatewayEnvOmit, restarted.gatewayEnvOmit);
  assert.match(initial.gatewayEnv.NODE_OPTIONS, /gateway-chat-fault-clock-preload\.mjs/u);
  assert.deepEqual(initial.gatewayEnv, {
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_STREAM_COALESCE_OFF: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
    GOATCITADEL_DEV_DIAGNOSTICS_BUFFER_SIZE: "5000",
    GOATCITADEL_VERIFY_FAULT_CLOCK_MARKER: "GC_USAB_NEAR_EXPIRY_4551",
    GOATCITADEL_VERIFY_FAULT_CLOCK_ADVANCE_MS: "85449",
    GOATCITADEL_VERIFY_FAULT_CLOCK_TARGET_PATH: "/v1/responses",
    NODE_OPTIONS: initial.gatewayEnv.NODE_OPTIONS,
    GOATCITADEL_VERIFY_STUB_LLM_KEY: "verification-fixture-key",
    ...POSTGRES_GATEWAY_ENV,
  });
  assert.equal(Object.hasOwn(initial.gatewayEnv, "GOATCITADEL_POSTGRES_CONNECTION_STRING"), false);
});

test("Gateway fault evidence records dynamic storage and redacts supplied database secrets", () => {
  const password = "artifact-postgres-password";
  const url = `postgresql://postgres:${password}@127.0.0.1:55432/goatcitadel`;
  const artifact = buildGatewayChatFaultArtifact({
    baseSha: "a".repeat(40),
    generatedAt: "2026-07-30T00:00:00.000Z",
    gatewayDiagnostics: [],
    providerId: "openai",
    modelId: "gpt-5-verification",
    providerDispatches: [{ requestId: "provider-1" }],
    faultTargetDispatches: [{ requestId: "provider-1" }],
    sensitiveValues: [url, password],
    steps: [{ status: "failed", storage: "postgres", actualResult: `connection failed for ${url}` }],
    storage: "postgres",
    terminalError: new Error(`database password ${password} was rejected`),
  });
  const serialized = JSON.stringify(artifact);

  assert.equal(artifact.storage, "postgres");
  assert.equal(artifact.steps[0].storage, "postgres");
  assert.match(artifact.steps[0].actualResult, /REDACTED_VERIFICATION_SECRET/u);
  assert.match(artifact.error, /REDACTED_VERIFICATION_SECRET/u);
  assert.doesNotMatch(serialized, /artifact-postgres-password|postgresql:\/\//u);
  assert.match(buildGatewayChatFaultNotes("postgres")[0], /managed PostgreSQL/u);
  assert.match(buildGatewayChatFaultNotes("sqlite")[0], /isolated SQLite/u);
});

test("Gateway fault PostgreSQL evidence fails closed on unsafe runtime configuration", () => {
  assert.throws(
    () =>
      createGatewayChatFaultExecutionConfig({
        storage: "postgres",
        gatewayEnv: { ...POSTGRES_GATEWAY_ENV, GOATCITADEL_POSTGRES_HOST: "db.example.test" },
      }),
    /exact loopback database host/u,
  );
  assert.throws(
    () =>
      createGatewayChatFaultExecutionConfig({
        storage: "postgres",
        gatewayEnv: {
          ...POSTGRES_GATEWAY_ENV,
          GOATCITADEL_POSTGRES_CONNECTION_STRING: "postgresql://must-not-reach-child",
        },
      }),
    /must not pass the source URL/u,
  );
});

test("streaming restart fixture crosses the public secret-projector delimiter boundary", () => {
  assert.equal(GATEWAY_CHAT_FAULT_RESTART_PREFIX.trim(), "STREAMING_BEFORE_RESTART");
  assert.match(GATEWAY_CHAT_FAULT_RESTART_PREFIX, /\s$/u);
});

test("parseGatewayChatSse ignores comments and DONE while preserving ordered JSON chunks", () => {
  const chunks = parseGatewayChatSse(
    [
      ": connected",
      "",
      "id: event-1",
      'data: {"type":"delta","eventId":"event-1","delta":"hello"}',
      "",
      'data: {"type":"done","eventId":"event-2"}',
      "",
      "data: [DONE]",
      "",
    ].join("\r\n"),
  );
  assert.deepEqual(chunks, [
    { type: "delta", eventId: "event-1", delta: "hello" },
    { type: "done", eventId: "event-2" },
  ]);
});

test("parseGatewayChatSse fails closed on malformed data frames", () => {
  assert.throws(() => parseGatewayChatSse("data: {not-json}\n\n"), /malformed JSON/u);
  assert.throws(() => parseGatewayChatSse(null), /must be a string/u);
});

test("runGatewayChatFaultRecoveryLane registers the exact usability scenario contract", async () => {
  const calls = [];
  const expectedResult = { status: "passed" };
  const result = await runGatewayChatFaultRecoveryLane(
    { runId: "unit", artifactRoot: "C:/unit" },
    { baseSha: "abc123" },
    {
      runScenario: async (context, metadata, execute) => {
        calls.push({ context, metadata });
        assert.equal(typeof execute, "function");
        return expectedResult;
      },
    },
  );
  assert.equal(result, expectedResult);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].metadata, {
    id: GATEWAY_CHAT_FAULT_SCENARIO_ID,
    lane: "usability",
    title: "Gateway Chat SSE transient-failure, deadline, and next-turn recovery proof",
    subsystem: "gateway-chat-reliability",
  });
});
