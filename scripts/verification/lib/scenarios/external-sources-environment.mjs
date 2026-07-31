import path from "node:path";

import { buildVerificationProcessEnv } from "../runtime.mjs";
import { repoRoot } from "../shared.mjs";
import { collectVerificationSecretEnvKeys } from "./usability-coverage.mjs";

const TEST_POSTGRES_ENV_KEY = "GOATCITADEL_TEST_POSTGRES_URL";

export async function resolveExternalSourcesSecretEnvKeys(
  { secretEnvKeys, configRoot = path.join(repoRoot, "config"), env = process.env } = {},
  deps = { collectVerificationSecretEnvKeys },
) {
  if (secretEnvKeys !== undefined) {
    return normalizeSecretEnvKeys(secretEnvKeys);
  }
  return normalizeSecretEnvKeys(await deps.collectVerificationSecretEnvKeys(configRoot, env));
}

export async function createExternalSourcesStandaloneIsolation(
  { secretEnvKeys, configRoot = path.join(repoRoot, "config"), baseEnv = process.env } = {},
  deps = { collectVerificationSecretEnvKeys },
) {
  const scrubbedSecretEnvKeys = await resolveExternalSourcesSecretEnvKeys(
    { secretEnvKeys, configRoot, env: baseEnv },
    deps,
  );
  const scrubbedSecretEnvKeySet = new Set(scrubbedSecretEnvKeys);

  return {
    scrubbedSecretEnvKeys,
    buildChildEnv(extraEnv = {}) {
      const forbiddenOverrides = Object.keys(extraEnv).filter((key) => scrubbedSecretEnvKeySet.has(key));
      if (forbiddenOverrides.length > 0) {
        throw new Error(
          `external-sources child env cannot reintroduce scrubbed inherited keys: ${forbiddenOverrides.join(", ")}`,
        );
      }
      return buildVerificationProcessEnv(baseEnv, extraEnv, scrubbedSecretEnvKeys);
    },
    buildHermeticPostgresChildEnv(postgresUrl) {
      assertHermeticPostgresUrl(postgresUrl);
      return buildVerificationProcessEnv(baseEnv, { [TEST_POSTGRES_ENV_KEY]: postgresUrl }, scrubbedSecretEnvKeys);
    },
  };
}

function normalizeSecretEnvKeys(secretEnvKeys) {
  if (!Array.isArray(secretEnvKeys)) {
    throw new TypeError("external-sources secretEnvKeys must be an array when explicitly provided");
  }
  return [...new Set(secretEnvKeys.filter((key) => typeof key === "string" && key.length > 0))];
}

function assertHermeticPostgresUrl(postgresUrl) {
  let parsed;
  try {
    parsed = new URL(postgresUrl);
  } catch {
    throw new Error("external-sources hermetic PostgreSQL URL must be a valid URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("external-sources may only reintroduce a harness-created loopback PostgreSQL URL");
  }
}
