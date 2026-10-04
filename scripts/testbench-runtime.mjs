import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { prepareUsabilityRuntime } from "./verification/lib/scenarios/usability-runtime-fixture.mjs";
import { repoRoot } from "./verification/lib/shared.mjs";

export const TESTBENCH_STUB_KEY = "verification-stub-key";
export const DEFAULT_REAL_GATEWAY_ORIGIN = "http://127.0.0.1:8787";

/** Lists git-tracked files under `skills/`, relative to `sourceRoot`. Throws if git cannot answer. */
function listTrackedSkillFiles(sourceRoot) {
  const result = spawnSync("git", ["-C", sourceRoot, "ls-files", "-z", "--", "skills"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`;
    throw new Error(
      `Test bench cannot tell which skills are tracked: "git ls-files" failed in ${sourceRoot} (${reason}). ` +
        "Refusing to copy an unfiltered skills tree into the sandbox.",
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

/** Replaces the fixture's whole-directory skills copy with the tracked files only. */
async function copyTrackedSkills(sourceRoot, runtimeRoot, trackedFiles) {
  await fs.rm(path.join(runtimeRoot, "skills"), { recursive: true, force: true });
  for (const relativeFile of trackedFiles) {
    const source = path.join(sourceRoot, relativeFile);
    const target = path.join(runtimeRoot, relativeFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.copyFile(source, target);
    } catch (error) {
      // A file that is tracked but deleted from the working tree has nothing to ship.
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Builds the sandbox runtime root from shipped defaults only: the tracked example config,
 * the deterministic stub as the only provider, and the git-tracked skills. Operator config,
 * secrets, untracked workspace skills, and workspace guidance are never read.
 */
export async function prepareTestbenchRuntime({ runId, stubBaseUrl, sourceRoot = repoRoot, tempParent }) {
  // Ask git first so a failure leaves no half-built runtime root behind.
  const trackedSkillFiles = listTrackedSkillFiles(sourceRoot);
  const runtimeRoot = await prepareUsabilityRuntime(runId, stubBaseUrl, { sourceRoot, tempParent });
  try {
    await copyTrackedSkills(sourceRoot, runtimeRoot, trackedSkillFiles);
    await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, "backups"), { recursive: true });
  } catch (error) {
    // The caller learns the root only when this resolves, so a failure here must remove it.
    await fs.rm(runtimeRoot, { recursive: true, force: true }).catch((cleanupError) => {
      process.stderr.write(
        `[testbench] Could not remove the partial sandbox root ${runtimeRoot}: ${cleanupError.message}\n`,
      );
    });
    throw error;
  }
  return runtimeRoot;
}

/**
 * Path-relocating variables the gateway reads that the test bench does not pin. They are always omitted, even when
 * the operator shell does not export them, so the gateway falls back to its defaults inside the runtime root.
 * `buildTestbenchEnvOmit` also omits every other GoatCitadel setting the shell exports.
 */
export const TESTBENCH_INHERITED_PATH_ENV_KEYS = Object.freeze([
  "GOATCITADEL_CAPABILITY_CANDIDATE_ROOT",
  "GOATCITADEL_LLM_MODEL_METADATA_PATH",
  "GOATCITADEL_LLM_MODEL_CATALOG_CACHE_PATH",
  "GOATCITADEL_PROMPT_PACK_PATH",
]);

/** Matches GoatCitadel gateway and Vite settings; case-insensitive because Windows environment names are. */
const GOATCITADEL_SETTING_NAME = /^(?:VITE_)?GOATCITADEL_/i;

/**
 * The environment keys the launcher removes from the gateway and UI children, de-duplicated: the secret keys, every
 * `GOATCITADEL_*` and `VITE_GOATCITADEL_*` variable in `env`, and the known path overrides. The sandbox therefore
 * inherits no GoatCitadel configuration from the operator shell; only the launcher's explicit settings apply, because
 * `buildVerificationProcessEnv` deletes omitted keys from the inherited environment and then spreads the explicit
 * settings on top (so an explicit setting survives even when its name is omitted).
 */
export function buildTestbenchEnvOmit(secretEnvKeys, env = process.env) {
  const inherited = Object.keys(env).filter((key) => GOATCITADEL_SETTING_NAME.test(key));
  return [...new Set([...secretEnvKeys, ...inherited, ...TESTBENCH_INHERITED_PATH_ENV_KEYS])];
}

/**
 * The children always run in development mode: a shell that exports NODE_ENV=production would otherwise make the
 * gateway reject the test bench's Vite origin (it allows any loopback port only outside production).
 */
const TESTBENCH_NODE_ENV = "development";

/**
 * Gateway environment on top of the verification stack defaults (SQLite, auth none, no secret store).
 * Pinned inside the runtime root: GOATCITADEL_HOME, GOATCITADEL_BACKUP_DIR, GOATCITADEL_LOCAL_ENV_FILE, and the two
 * Code Mode roots (the stack itself also pins GOATCITADEL_ROOT_DIR). Nothing else GoatCitadel-specific comes from
 * the operator shell: the launcher omits every GOATCITADEL_* variable it exports (see `buildTestbenchEnvOmit`).
 */
export function buildTestbenchGatewayEnv(runtimeRoot) {
  return {
    NODE_ENV: TESTBENCH_NODE_ENV,
    GOATCITADEL_HOME: path.join(runtimeRoot, "home"),
    GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
    // Points at a file that does not exist, so no operator .env is read or written.
    GOATCITADEL_LOCAL_ENV_FILE: path.join(runtimeRoot, ".env"),
    GOATCITADEL_CODE_MODE_ARTIFACT_ROOT: path.join(runtimeRoot, "data", "code-mode", "artifacts"),
    GOATCITADEL_CODE_MODE_TEMP_ROOT: path.join(runtimeRoot, "data", "code-mode", "tmp"),
    GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
    GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
    GOATCITADEL_LLAMACPP_AUTOSTART: "false",
    GOATCITADEL_LLAMACPP_ENABLED: "false",
    GOATCITADEL_NPU_AUTOSTART: "false",
    GOATCITADEL_NPU_ENABLED: "false",
    [DETERMINISTIC_LLM_KEY_ENV]: TESTBENCH_STUB_KEY,
  };
}

export function buildTestbenchUiEnv({ gatewayUrl, runtimeRoot, realOrigin = DEFAULT_REAL_GATEWAY_ORIGIN }) {
  return {
    NODE_ENV: TESTBENCH_NODE_ENV,
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: gatewayUrl,
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: runtimeRoot,
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: realOrigin,
  };
}

export function buildTestbenchUrl(uiUrl) {
  return `${uiUrl.replace(/\/+$/, "")}/testbench.html?target=sandbox`;
}
