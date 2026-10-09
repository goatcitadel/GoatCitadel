import path from "node:path";
import {
  buildTestbenchEnvOmit,
  buildTestbenchGatewayEnv,
  prepareTestbenchRuntime,
} from "../../../testbench-runtime.mjs";
import { collectVerificationSecretEnvKeys } from "./usability-coverage.mjs";

/**
 * Testbench settings the UI parity lane takes: the paths pinned inside the disposable root and the local services kept
 * off. Feature flags (Code Mode, memory administration, rate limits) are left to the lane so its parity view is the
 * one it already asserts.
 */
const UI_PARITY_TESTBENCH_KEYS = Object.freeze([
  "NODE_ENV",
  "GOATCITADEL_HOME",
  "GOATCITADEL_BACKUP_DIR",
  "GOATCITADEL_LOCAL_ENV_FILE",
  "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT",
  "GOATCITADEL_CODE_MODE_TEMP_ROOT",
  "GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART",
  "GOATCITADEL_BUNDLED_POSTGRES_ENABLED",
  "GOATCITADEL_LLAMACPP_AUTOSTART",
  "GOATCITADEL_LLAMACPP_ENABLED",
  "GOATCITADEL_NPU_AUTOSTART",
  "GOATCITADEL_NPU_ENABLED",
]);

/**
 * A fresh runtime for the UI parity lane built from shipped defaults only (the tracked example config and tracked
 * skills; never checkout config, workspaces, schedules or credentials), with the Gateway environment pins and the
 * list of inherited settings to scrub from both the Gateway and UI children. The lane makes no provider calls, so
 * the deterministic stub address is never contacted.
 */
export async function prepareUiParityRuntime(context, env = process.env) {
  const runtimeRoot = await prepareTestbenchRuntime({
    runId: `${context.runId}-ui-parity`,
    stubBaseUrl: "http://127.0.0.1:1/v1",
  });
  const testbenchEnv = buildTestbenchGatewayEnv(runtimeRoot);
  const gatewayEnv = Object.fromEntries(UI_PARITY_TESTBENCH_KEYS.map((key) => [key, testbenchEnv[key]]));
  const omitEnv = buildTestbenchEnvOmit(
    await collectVerificationSecretEnvKeys(path.join(runtimeRoot, "config"), env),
    env,
  );
  return { runtimeRoot, gatewayEnv, omitEnv };
}
