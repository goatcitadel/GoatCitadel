// Target resolution for the head-to-head benchmark.
//
// Precedence (highest first):
//   1. Environment variables (BENCH_* — listed below)
//   2. benchmark/targets.json (gitignored, user-provided)
//   3. benchmark/targets.example.json (committed defaults, used for a dry self-run)
//
// A "configured" competitor target requires either a `command` (binary to spawn)
// or a `baseUrl` (already-running instance). GoatCitadel is special: it is always
// runnable for the in-process scenarios because they import the shipped dist/
// logic directly, so it is reported configured whenever its dist is built.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const benchmarkRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(benchmarkRoot, "..");

const TARGETS_JSON = path.join(benchmarkRoot, "targets.json");
const TARGETS_EXAMPLE = path.join(benchmarkRoot, "targets.example.json");

/**
 * Environment variable names honored as overrides. Documented here AND in
 * benchmark/README.md so the "drop-it-here" contract is greppable.
 */
export const ENV_OVERRIDES = Object.freeze({
  goatcitadelBaseUrl: "BENCH_GOATCITADEL_BASE_URL",
  goatcitadelAuthMode: "BENCH_GOATCITADEL_AUTH_MODE",
  goatcitadelToken: "BENCH_GOATCITADEL_TOKEN",
  openclawCommand: "BENCH_OPENCLAW_COMMAND",
  openclawBaseUrl: "BENCH_OPENCLAW_BASE_URL",
  openclawToken: "BENCH_OPENCLAW_TOKEN",
  hermesCommand: "BENCH_HERMES_COMMAND",
  hermesBaseUrl: "BENCH_HERMES_BASE_URL",
  hermesToken: "BENCH_HERMES_TOKEN",
});

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const text = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function trimmedEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAuth(rawAuth) {
  const auth = rawAuth && typeof rawAuth === "object" ? rawAuth : {};
  const mode = typeof auth.mode === "string" ? auth.mode : "none";
  const token = typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token.trim() : null;
  return { mode, token };
}

function normalizeCompetitor(id, raw, env) {
  const base = raw && typeof raw === "object" ? raw : {};
  const command = trimmedEnv(env.command) ?? (typeof base.command === "string" ? base.command : null);
  const baseUrl = trimmedEnv(env.baseUrl) ?? (typeof base.baseUrl === "string" ? base.baseUrl : null);
  const args = Array.isArray(base.args) ? base.args.filter((a) => typeof a === "string") : [];
  const auth = normalizeAuth(base.auth);
  if (env.token) {
    const token = trimmedEnv(env.token);
    if (token) {
      auth.token = token;
      if (auth.mode === "none") auth.mode = "token";
    }
  }
  const configured = Boolean(command) || Boolean(baseUrl);
  return {
    id,
    kind: "competitor",
    command,
    args,
    baseUrl,
    auth,
    configured,
    skipReason: configured ? null : `${id} not configured (set ${env.command} / ${env.baseUrl} or fill targets.json)`,
  };
}

/**
 * Whether the GoatCitadel dist needed by the in-process scenarios is built.
 * The scenarios import from apps/gateway/dist and packages/contracts/dist.
 */
export function goatcitadelDistReady() {
  const required = [
    path.join(repoRoot, "apps", "gateway", "dist", "services", "dry-run-commit-service.js"),
    path.join(repoRoot, "apps", "gateway", "dist", "services", "durable-run-service.js"),
    path.join(repoRoot, "apps", "gateway", "dist", "services", "process-tree-killer.js"),
    path.join(repoRoot, "packages", "contracts", "dist", "citadel-wards.js"),
    path.join(repoRoot, "packages", "contracts", "dist", "channel-access.js"),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  return { ready: missing.length === 0, missing };
}

function normalizeGoatCitadel(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const baseUrl = trimmedEnv(ENV_OVERRIDES.goatcitadelBaseUrl) ?? (typeof base.baseUrl === "string" ? base.baseUrl : null);
  const auth = normalizeAuth(base.auth);
  const envMode = trimmedEnv(ENV_OVERRIDES.goatcitadelAuthMode);
  if (envMode) auth.mode = envMode;
  const envToken = trimmedEnv(ENV_OVERRIDES.goatcitadelToken);
  if (envToken) {
    auth.token = envToken;
    if (auth.mode === "none") auth.mode = "token";
  }
  const dist = goatcitadelDistReady();
  return {
    id: "goatcitadel",
    kind: "primary",
    baseUrl,
    auth,
    // In-process scenarios are always available once dist is built; HTTP scenarios
    // additionally need a baseUrl (or --spin). `configured` reflects the in-process floor.
    configured: dist.ready,
    distReady: dist.ready,
    distMissing: dist.missing,
    skipReason: dist.ready
      ? null
      : "goatcitadel dist not built — run `pnpm --filter @goatcitadel/gateway... build` so dry-run/Ward/channel logic is importable",
  };
}

/**
 * Load and normalize all targets. `source` reports which file backed the load so
 * the scorecard can note whether real wiring or example defaults were used.
 */
export function loadTargets() {
  const userConfig = readJsonIfExists(TARGETS_JSON);
  const exampleConfig = readJsonIfExists(TARGETS_EXAMPLE);
  const config = userConfig ?? exampleConfig ?? {};
  const source = userConfig ? "targets.json" : exampleConfig ? "targets.example.json (defaults)" : "built-in defaults";

  return {
    source,
    usingExampleDefaults: !userConfig,
    goatcitadel: normalizeGoatCitadel(config.goatcitadel),
    openclaw: normalizeCompetitor("openclaw", config.openclaw, {
      command: ENV_OVERRIDES.openclawCommand,
      baseUrl: ENV_OVERRIDES.openclawBaseUrl,
      token: ENV_OVERRIDES.openclawToken,
    }),
    hermes: normalizeCompetitor("hermes", config.hermes, {
      command: ENV_OVERRIDES.hermesCommand,
      baseUrl: ENV_OVERRIDES.hermesBaseUrl,
      token: ENV_OVERRIDES.hermesToken,
    }),
  };
}

/** Ordered list of all targets (primary first). */
export function allTargets(targets) {
  return [targets.goatcitadel, targets.openclaw, targets.hermes];
}

/** Build the Authorization header (if any) for a target's HTTP calls. */
export function authHeaders(target) {
  if (target?.auth?.mode === "token" && target.auth.token) {
    return { Authorization: `Bearer ${target.auth.token}` };
  }
  return {};
}
