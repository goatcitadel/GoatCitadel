import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedPostgresGatewayEnv,
  parseLoopbackPostgresVerificationUrl,
  POSTGRES_RECOVERY_LANE,
  POSTGRES_RECOVERY_URL_ENV,
  runUsabilityPostgresRecoveryVerification,
} from "./usability-postgres-recovery.mjs";

const PASSWORD = "postgres-proof-password-123456";
const LOOPBACK_URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:55432/goatcitadel`;
const SOURCE_STATE = Object.freeze({
  mode: "final",
  baseSha: "a".repeat(40),
  sourceModified: false,
  diffSha256: "b".repeat(64),
  changedPathCount: 0,
});

test("live PostgreSQL recovery URL parsing accepts only explicit loopback database targets", () => {
  assert.deepEqual(parseLoopbackPostgresVerificationUrl(LOOPBACK_URL), {
    host: "127.0.0.1",
    port: "55432",
    database: "goatcitadel",
    user: "postgres",
    password: PASSWORD,
    sensitiveValues: [LOOPBACK_URL, PASSWORD],
  });
  assert.deepEqual(
    parseLoopbackPostgresVerificationUrl(`postgres://postgres:${PASSWORD}@[::1]:55433/goatcitadel?sslmode=disable`)
      .host,
    "::1",
  );
});

test("live PostgreSQL recovery URL parsing rejects missing, remote, implicit-port, and weak targets", () => {
  assert.throws(() => parseLoopbackPostgresVerificationUrl(undefined), /is required/u);
  assert.throws(
    () => parseLoopbackPostgresVerificationUrl(`postgresql://postgres:${PASSWORD}@db.example.test:55432/db`),
    /exact loopback host/u,
  );
  assert.throws(
    () => parseLoopbackPostgresVerificationUrl(`postgresql://postgres:${PASSWORD}@127.0.0.1/db`),
    /explicit loopback port/u,
  );
  assert.throws(
    () => parseLoopbackPostgresVerificationUrl("postgresql://postgres:short@127.0.0.1:55432/db"),
    /at least 16 characters/u,
  );
  assert.throws(
    () => parseLoopbackPostgresVerificationUrl(`${LOOPBACK_URL}?options=-csearch_path%3Dpublic`),
    /unsupported query option/u,
  );
});

test("managed PostgreSQL Gateway environment is decomposed and contains no connection URL", () => {
  const parsed = parseLoopbackPostgresVerificationUrl(LOOPBACK_URL);
  const gatewayEnv = buildManagedPostgresGatewayEnv(parsed);

  assert.deepEqual(gatewayEnv, {
    GOATCITADEL_DATABASE_DRIVER: "postgres",
    GOATCITADEL_POSTGRES_MODE: "managed",
    GOATCITADEL_POSTGRES_HOST: "127.0.0.1",
    GOATCITADEL_POSTGRES_PORT: "55432",
    GOATCITADEL_POSTGRES_DATABASE: "goatcitadel",
    GOATCITADEL_POSTGRES_USER: "postgres",
    GOATCITADEL_POSTGRES_PASSWORD: PASSWORD,
    GOATCITADEL_POSTGRES_SSL: "disable",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  });
  assert.equal(Object.hasOwn(gatewayEnv, "GOATCITADEL_POSTGRES_CONNECTION_STRING"), false);
  assert.equal(Object.values(gatewayEnv).includes(LOOPBACK_URL), false);
});

test("standalone PostgreSQL recovery proof propagates guarded options and scans its exact artifact root", async () => {
  const calls = [];
  const context = {
    lane: POSTGRES_RECOVERY_LANE,
    runId: "postgres-recovery-unit",
    repoRoot: "C:/repo",
    artifactRoot: "C:/artifacts/exact-postgres-run",
    manifest: { scenarios: [] },
  };
  const result = await runUsabilityPostgresRecoveryVerification(
    {
      environment: {
        [POSTGRES_RECOVERY_URL_ENV]: LOOPBACK_URL,
        GOATCITADEL_USABILITY_SOURCE_MODE: "final",
      },
    },
    {
      repoRoot: "C:/repo",
      beginUsabilitySourceGuard: (sourceRepoRoot, mode) => {
        calls.push(["source-start", sourceRepoRoot, mode]);
        return SOURCE_STATE;
      },
      createRunContext: async (lane, options) => {
        calls.push(["create", lane, options]);
        return context;
      },
      collectVerificationSecretEnvKeys: async () => ["OPENAI_API_KEY"],
      runScenario: async () => {
        throw new Error("the fake lane owns scenario recording");
      },
      runGatewayChatFaultRecoveryLane: async (receivedContext, options, laneDeps) => {
        calls.push(["lane", receivedContext, options, laneDeps]);
        assert.equal(receivedContext, context);
        assert.equal(options.baseSha, SOURCE_STATE.baseSha);
        assert.equal(options.storage, "postgres");
        assert.equal(options.gatewayEnv.GOATCITADEL_DATABASE_DRIVER, "postgres");
        assert.equal(options.gatewayEnv.GOATCITADEL_POSTGRES_MODE, "managed");
        assert.equal(options.gatewayEnv.GOATCITADEL_BUNDLED_POSTGRES_ENABLED, "false");
        assert.equal(options.gatewayEnv.GOATCITADEL_POSTGRES_PASSWORD, PASSWORD);
        assert.equal(options.gatewayEnv.GOATCITADEL_POSTGRES_CONNECTION_STRING, undefined);
        assert.ok(options.secretEnvKeys.includes(POSTGRES_RECOVERY_URL_ENV));
        assert.ok(options.secretEnvKeys.includes("GOATCITADEL_POSTGRES_PASSWORD"));
        assert.ok(options.secretEnvKeys.includes("OPENAI_API_KEY"));
        assert.deepEqual(options.sensitiveValues, [LOOPBACK_URL, PASSWORD]);
        assert.equal(typeof laneDeps.runScenario, "function");
        return { status: "passed" };
      },
      finalizeRunContext: async (receivedContext, status) => {
        calls.push(["finalize", receivedContext, status]);
        return { status: status ?? "passed" };
      },
      completeUsabilityFinalIntegrity: async (receivedContext, sourceState, integrityDeps) => {
        calls.push(["integrity", receivedContext, sourceState, integrityDeps]);
        assert.equal(receivedContext.artifactRoot, "C:/artifacts/exact-postgres-run");
        assert.equal(sourceState, SOURCE_STATE);
        assert.deepEqual(integrityDeps, { repoRoot: "C:/repo" });
      },
    },
  );

  assert.equal(result.context, context);
  assert.deepEqual(result.manifest, { status: "passed" });
  const persistedInputs = JSON.stringify(
    calls.filter(([kind]) => kind === "create" || kind === "finalize" || kind === "integrity"),
  );
  assert.doesNotMatch(persistedInputs, /postgres-proof-password|postgresql:\/\//u);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["source-start", "create", "lane", "finalize", "integrity"],
  );
});

test("standalone PostgreSQL recovery proof rejects unavailable or skipped PostgreSQL execution", async () => {
  const context = {
    lane: POSTGRES_RECOVERY_LANE,
    runId: "postgres-recovery-unavailable",
    repoRoot: "C:/repo",
    artifactRoot: "C:/artifacts/postgres-unavailable",
    manifest: { scenarios: [] },
  };
  const finalizeStatuses = [];

  await assert.rejects(
    runUsabilityPostgresRecoveryVerification(
      { environment: { [POSTGRES_RECOVERY_URL_ENV]: LOOPBACK_URL } },
      {
        repoRoot: "C:/repo",
        beginUsabilitySourceGuard: () => SOURCE_STATE,
        createRunContext: async () => context,
        collectVerificationSecretEnvKeys: async () => [],
        runGatewayChatFaultRecoveryLane: async () => ({ status: "skipped", error: "PostgreSQL unavailable" }),
        finalizeRunContext: async (_context, status) => {
          finalizeStatuses.push(status);
          return { status: status ?? "passed" };
        },
        completeUsabilityFinalIntegrity: async () => undefined,
      },
    ),
    /scenario failed: PostgreSQL unavailable/u,
  );
  assert.deepEqual(finalizeStatuses, ["failed"]);
});

test("standalone PostgreSQL recovery proof finalizes and integrity-scans a failed post-context preflight", async () => {
  const context = {
    lane: POSTGRES_RECOVERY_LANE,
    runId: "postgres-recovery-preflight-failure",
    repoRoot: "C:/repo",
    artifactRoot: "C:/artifacts/postgres-preflight-failure",
    manifest: { scenarios: [] },
  };
  const calls = [];

  await assert.rejects(
    runUsabilityPostgresRecoveryVerification(
      { environment: { [POSTGRES_RECOVERY_URL_ENV]: LOOPBACK_URL } },
      {
        repoRoot: "C:/repo",
        beginUsabilitySourceGuard: () => SOURCE_STATE,
        createRunContext: async () => context,
        collectVerificationSecretEnvKeys: async () => {
          throw new Error(`secret discovery failed for ${PASSWORD}`);
        },
        runGatewayChatFaultRecoveryLane: async () => {
          throw new Error("the live lane must not start after a failed preflight");
        },
        finalizeRunContext: async (receivedContext, status) => {
          calls.push(["finalize", receivedContext, status]);
          return { status: status ?? "passed" };
        },
        completeUsabilityFinalIntegrity: async (receivedContext, sourceState, integrityDeps) => {
          calls.push(["integrity", receivedContext, sourceState, integrityDeps]);
        },
      },
    ),
    (error) => {
      assert.match(error.message, /secret discovery failed/u);
      assert.doesNotMatch(error.message, /postgres-proof-password/u);
      return true;
    },
  );

  assert.deepEqual(calls, [
    ["finalize", context, "failed"],
    ["integrity", context, SOURCE_STATE, { repoRoot: "C:/repo" }],
  ]);
});
