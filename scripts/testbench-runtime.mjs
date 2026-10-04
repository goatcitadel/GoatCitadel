import fs from "node:fs/promises";
import path from "node:path";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { prepareUsabilityRuntime } from "./verification/lib/scenarios/usability-runtime-fixture.mjs";

export const TESTBENCH_STUB_KEY = "verification-stub-key";
export const DEFAULT_REAL_GATEWAY_ORIGIN = "http://127.0.0.1:8787";

/**
 * Builds the sandbox runtime root from shipped defaults only: the tracked example config,
 * the deterministic stub as the only provider, and the tracked skills. Operator config,
 * secrets, and workspace guidance are never read.
 */
export async function prepareTestbenchRuntime({ runId, stubBaseUrl, sourceRoot, tempParent }) {
  const runtimeRoot = await prepareUsabilityRuntime(runId, stubBaseUrl, { sourceRoot, tempParent });
  await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "backups"), { recursive: true });
  return runtimeRoot;
}

/** Gateway environment on top of the verification stack defaults (SQLite, auth none, no secret store). */
export function buildTestbenchGatewayEnv(runtimeRoot) {
  return {
    GOATCITADEL_HOME: path.join(runtimeRoot, "home"),
    GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
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
