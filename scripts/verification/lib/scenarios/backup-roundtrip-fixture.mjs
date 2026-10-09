import path from "node:path";
import { prepareTestbenchRuntime, buildTestbenchGatewayEnv, buildTestbenchEnvOmit } from "../../../testbench-runtime.mjs";
import { collectVerificationSecretEnvKeys } from "./usability-coverage.mjs";

/** One pinned, scrubbed launch contract reused by every restart AND offline restore. */
export async function prepareBackupRoundtripFixture(runId, stubBaseUrl, options = {}) {
  const runtimeRoot = await prepareTestbenchRuntime({ runId, stubBaseUrl, ...options });
  const inherited = options.env ?? process.env;
  const gatewayEnvOmit = [...new Set([
    ...buildTestbenchEnvOmit(await collectVerificationSecretEnvKeys(path.join(runtimeRoot, "config"), inherited), inherited),
    ...Object.keys(inherited).filter(key => /^(?:GOAT|VITE_)/iu.test(key)),
  ])];
  const gatewayEnv = {
    ...buildTestbenchGatewayEnv(runtimeRoot),
    GOATCITADEL_ROOT_DIR: runtimeRoot,
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
    HOME: runtimeRoot,
    USERPROFILE: runtimeRoot,
  };
  return { runtimeRoot, gatewayEnv, gatewayEnvOmit, backupRoot: gatewayEnv.GOATCITADEL_BACKUP_DIR };
}
