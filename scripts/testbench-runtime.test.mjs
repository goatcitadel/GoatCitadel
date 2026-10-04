import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

const SENTINEL = "TESTBENCH-SENTINEL-DO-NOT-COPY";

function makeSourceRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.example.json"),
    JSON.stringify({ assistant: {}, toolPolicy: {}, budgets: {} }),
  );
  fs.writeFileSync(path.join(root, "config", "goatcitadel.json"), JSON.stringify({ secret: SENTINEL }));
  fs.mkdirSync(path.join(root, "workspaces", "private"), { recursive: true });
  fs.writeFileSync(path.join(root, "workspaces", "private", "AGENTS.md"), SENTINEL);
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "# Demo skill\n");
  return root;
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("prepareTestbenchRuntime copies shipped defaults and skills, never operator config or workspaces", async (t) => {
  const sourceRoot = makeSourceRoot(t);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-parent-"));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  const runtimeRoot = await prepareTestbenchRuntime({
    runId: "unit",
    stubBaseUrl: "http://127.0.0.1:1/v1",
    sourceRoot,
    tempParent,
  });
  for (const file of listFiles(runtimeRoot)) {
    assert.equal(fs.readFileSync(file, "utf8").includes(SENTINEL), false, `${file} leaked operator data`);
  }
  assert.equal(fs.existsSync(path.join(runtimeRoot, "workspaces")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills", "demo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "home")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "backups")), true);
});

test("buildTestbenchGatewayEnv keeps home and backups inside the runtime root and turns Code Mode on", () => {
  const runtimeRoot = path.join(os.tmpdir(), "goatcitadel-usability-unit");
  const env = buildTestbenchGatewayEnv(runtimeRoot);
  for (const key of ["GOATCITADEL_HOME", "GOATCITADEL_BACKUP_DIR"]) {
    const relative = path.relative(runtimeRoot, env[key]);
    assert.ok(
      relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
      `${key} escapes the runtime root`,
    );
  }
  assert.equal(env.GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED, "true");
  assert.equal(env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED, "true");
  assert.equal(env.GOATCITADEL_BUNDLED_POSTGRES_ENABLED, "false");
  assert.equal(env.GOATCITADEL_LLAMACPP_ENABLED, "false");
  assert.equal(env.GOATCITADEL_NPU_ENABLED, "false");
  assert.equal(env[DETERMINISTIC_LLM_KEY_ENV], TESTBENCH_STUB_KEY);
});

test("buildTestbenchUiEnv hands the page the sandbox origin, root, and real origin", () => {
  assert.deepEqual(buildTestbenchUiEnv({ gatewayUrl: "http://127.0.0.1:41873", runtimeRoot: "/tmp/root" }), {
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: "http://127.0.0.1:41873",
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: "/tmp/root",
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: "http://127.0.0.1:8787",
  });
});

test("buildTestbenchUrl points at the sandbox target", () => {
  assert.equal(buildTestbenchUrl("http://127.0.0.1:5199/"), "http://127.0.0.1:5199/testbench.html?target=sandbox");
});
