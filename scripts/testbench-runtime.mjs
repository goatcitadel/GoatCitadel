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
  await copyTrackedSkills(sourceRoot, runtimeRoot, trackedSkillFiles);
  await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "backups"), { recursive: true });
  return runtimeRoot;
}

/**
 * Gateway environment on top of the verification stack defaults (SQLite, auth none, no secret store).
 * Every path-relocating variable is pinned inside the runtime root so nothing resolves to operator state.
 */
export function buildTestbenchGatewayEnv(runtimeRoot) {
  return {
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
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: gatewayUrl,
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: runtimeRoot,
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: realOrigin,
  };
}

export function buildTestbenchUrl(uiUrl) {
  return `${uiUrl.replace(/\/+$/, "")}/testbench.html?target=sandbox`;
}
