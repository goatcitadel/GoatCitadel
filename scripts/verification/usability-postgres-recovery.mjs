#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runGatewayChatFaultRecoveryLane,
  redactSensitiveEvidence,
} from "./lib/scenarios/gateway-chat-fault-recovery-lane.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import {
  beginUsabilitySourceGuard,
  combineUsabilityPrimaryAndIntegrityErrors,
  completeUsabilityFinalIntegrity,
} from "./lib/scenarios/usability-final-integrity.mjs";
import { createRunContext, finalizeRunContext, repoRoot, runScenario } from "./lib/shared.mjs";

export const POSTGRES_RECOVERY_LANE = "usability-postgres-recovery";
export const POSTGRES_RECOVERY_URL_ENV = "GOATCITADEL_TEST_POSTGRES_URL";
export const POSTGRES_RECOVERY_SCRUBBED_ENV_KEYS = Object.freeze([
  POSTGRES_RECOVERY_URL_ENV,
  "GOATCITADEL_POSTGRES_CONNECTION_STRING",
  "GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV",
  "GOATCITADEL_POSTGRES_PASSWORD",
  "GOATCITADEL_POSTGRES_PASSWORD_ENV",
  "GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART",
  "GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR",
  "GOATCITADEL_BUNDLED_POSTGRES_PORT",
  "PGPASSWORD",
]);

export function parseLoopbackPostgresVerificationUrl(value) {
  const rawUrl = typeof value === "string" ? value.trim() : "";
  if (!rawUrl) {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} is required for the live PostgreSQL recovery proof`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must use the postgres or postgresql protocol`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must use the exact loopback host 127.0.0.1 or ::1`);
  }
  if (!parsed.port || !/^\d+$/u.test(parsed.port)) {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must declare an explicit loopback port`);
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} contains an invalid port`);
  }
  if (parsed.hash) throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must not contain a fragment`);
  for (const [key, queryValue] of parsed.searchParams) {
    if (key !== "sslmode" || queryValue !== "disable") {
      throw new Error(`${POSTGRES_RECOVERY_URL_ENV} contains an unsupported query option`);
    }
  }
  let user;
  let password;
  let database;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  } catch {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} contains invalid percent-encoding`);
  }
  if (!user) throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must include a database user`);
  if (password.length < 16) {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must include a non-placeholder password of at least 16 characters`);
  }
  if (!database || database.includes("/")) {
    throw new Error(`${POSTGRES_RECOVERY_URL_ENV} must identify exactly one database`);
  }

  return {
    host,
    port: String(port),
    database,
    user,
    password,
    sensitiveValues: uniqueStrings([rawUrl, parsed.password, password]),
  };
}

export function buildManagedPostgresGatewayEnv(connection) {
  return {
    GOATCITADEL_DATABASE_DRIVER: "postgres",
    GOATCITADEL_POSTGRES_MODE: "managed",
    GOATCITADEL_POSTGRES_HOST: connection.host,
    GOATCITADEL_POSTGRES_PORT: connection.port,
    GOATCITADEL_POSTGRES_DATABASE: connection.database,
    GOATCITADEL_POSTGRES_USER: connection.user,
    GOATCITADEL_POSTGRES_PASSWORD: connection.password,
    GOATCITADEL_POSTGRES_SSL: "disable",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  };
}

export async function runUsabilityPostgresRecoveryVerification(options = {}, deps = {}) {
  const environment = options.environment ?? process.env;
  const connection = parseLoopbackPostgresVerificationUrl(environment[POSTGRES_RECOVERY_URL_ENV]);
  const sourceRepoRoot = deps.repoRoot ?? repoRoot;
  const beginSourceGuard = deps.beginUsabilitySourceGuard ?? beginUsabilitySourceGuard;
  const sourceState = beginSourceGuard(sourceRepoRoot, environment.GOATCITADEL_USABILITY_SOURCE_MODE);
  const createContext = deps.createRunContext ?? createRunContext;
  const context = await createContext(POSTGRES_RECOVERY_LANE, {
    profile: options.profile ?? environment.GOATCITADEL_VERIFY_PROFILE ?? "local",
  });
  const collectSecretKeys = deps.collectVerificationSecretEnvKeys ?? collectVerificationSecretEnvKeys;
  const runLane = deps.runGatewayChatFaultRecoveryLane ?? runGatewayChatFaultRecoveryLane;
  const runScenarioImpl = deps.runScenario ?? runScenario;
  const finalizeContext = deps.finalizeRunContext ?? finalizeRunContext;
  const completeFinalIntegrity = deps.completeUsabilityFinalIntegrity ?? completeUsabilityFinalIntegrity;
  let manifest;

  try {
    // Once an artifact context exists, every fallible preflight belongs to the
    // same failed-manifest and final-integrity lifecycle as the live journey.
    const secretEnvKeys = uniqueStrings([
      ...(await collectSecretKeys(path.join(sourceRepoRoot, "config"))),
      ...POSTGRES_RECOVERY_SCRUBBED_ENV_KEYS,
    ]);
    const gatewayEnv = buildManagedPostgresGatewayEnv(connection);
    const scenario = await runLane(
      context,
      {
        baseSha: sourceState.baseSha,
        environment,
        gatewayEnv,
        secretEnvKeys,
        sensitiveValues: connection.sensitiveValues,
        storage: "postgres",
      },
      { runScenario: runScenarioImpl },
    );
    if (scenario?.status !== "passed") {
      throw new Error(`live PostgreSQL Gateway recovery scenario failed: ${scenario?.error ?? "unknown failure"}`);
    }
    manifest = await finalizeContext(context);
    if (manifest.status !== "passed") throw new Error("live PostgreSQL Gateway recovery manifest did not pass");
    await completeFinalIntegrity(context, sourceState, { repoRoot: sourceRepoRoot });
  } catch (error) {
    const safePrimaryError = sanitizeVerificationError(error, connection.sensitiveValues);
    manifest = await finalizeContext(context, "failed");
    try {
      await completeFinalIntegrity(context, sourceState, { repoRoot: sourceRepoRoot });
    } catch (integrityError) {
      throw combineUsabilityPrimaryAndIntegrityErrors(safePrimaryError, integrityError);
    }
    throw safePrimaryError;
  }

  return { context, manifest, sourceState };
}

function sanitizeVerificationError(error, sensitiveValues) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSensitiveEvidence(message, sensitiveValues));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runUsabilityPostgresRecoveryVerification();
    console.log(`Live PostgreSQL Gateway recovery proof completed: ${result.context.artifactRoot}`);
    console.log(`Status: ${result.manifest.status}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Live PostgreSQL Gateway recovery proof failed");
    process.exitCode = 1;
  }
}
