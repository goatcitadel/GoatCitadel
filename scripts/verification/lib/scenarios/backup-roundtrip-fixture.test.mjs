import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareBackupRoundtripFixture } from "./backup-roundtrip-fixture.mjs";
import { buildVerificationProcessEnv } from "../runtime.mjs";
import { buildVerificationCommandEnv } from "../shared.mjs";

test("roundtrip fixture never imports checkout config/workspaces and pins every launch and restore path", async t => {
  const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), "backup-fixture-test-"));
  t.after(() => fs.rm(tempParent, { recursive: true, force: true }));
  const inherited = { HOME: "operator-home", USERPROFILE: "operator-profile", GOAT_PRIVATE: "private", VITE_GATEWAY_URL: "private", VITE_THEME: "private", OPENAI_API_KEY: "synthetic", GOATCITADEL_LOCAL_ENV_FILE: "private", GOATCITADEL_CODE_MODE_ARTIFACT_ROOT: "private", GOATCITADEL_CODE_MODE_TEMP_ROOT: "private" };
  const fixture = await prepareBackupRoundtripFixture("unit", "http://127.0.0.1:1/v1", { tempParent, env: inherited });
  const { runtimeRoot, gatewayEnv, gatewayEnvOmit } = fixture;
  for (const key of Object.keys(inherited).filter(key => key !== "HOME" && key !== "USERPROFILE")) assert(gatewayEnvOmit.includes(key));
  for (const builder of [buildVerificationProcessEnv, buildVerificationCommandEnv]) {
    const launched = builder(inherited, gatewayEnv, gatewayEnvOmit);
    for (const key of ["GOAT_PRIVATE", "VITE_GATEWAY_URL", "VITE_THEME", "OPENAI_API_KEY"]) assert.equal(launched[key], undefined);
    for (const key of ["HOME", "USERPROFILE", "GOATCITADEL_HOME", "GOATCITADEL_ROOT_DIR", "GOATCITADEL_BACKUP_DIR", "GOATCITADEL_LOCAL_ENV_FILE", "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT", "GOATCITADEL_CODE_MODE_TEMP_ROOT"]) assert(launched[key].startsWith(runtimeRoot), key);
  }
  const provider = JSON.parse(await fs.readFile(path.join(runtimeRoot, "config", "llm-providers.json"), "utf8"));
  assert.equal(provider.providers.length, 1); assert.equal(provider.providers[0].providerId, "verification-stub");
  assert.equal(provider.providers[0].baseUrl, "http://127.0.0.1:1/v1");
  assert.equal((await fs.readdir(runtimeRoot)).includes("workspaces"), false);
  await assert.rejects(fs.stat(gatewayEnv.GOATCITADEL_LOCAL_ENV_FILE), { code: "ENOENT" });
});
