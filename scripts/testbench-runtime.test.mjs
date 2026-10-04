import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  DETERMINISTIC_LLM_PROVIDER_ID,
} from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

const SENTINEL = "TESTBENCH-SENTINEL-DO-NOT-COPY";

/** Operator-owned files the sandbox must never see, none of which the fixture rewrites. */
const UNTRACKED_OPERATOR_FILES = [
  ["workspaces", "private", "AGENTS.md"],
  ["skills", "workspace", "private", "SKILL.md"],
  [".env"],
  ["data", "secrets", "token.txt"],
  ["config", ".generations", "g1.json"],
];

function makeSourceRoot(t, { git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.example.json"),
    JSON.stringify({ assistant: {}, toolPolicy: {}, budgets: {} }),
  );
  fs.writeFileSync(path.join(root, "config", "goatcitadel.json"), JSON.stringify({ secret: SENTINEL }));
  for (const segments of UNTRACKED_OPERATOR_FILES) {
    fs.mkdirSync(path.join(root, ...segments.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...segments), SENTINEL);
  }
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "# Demo skill\n");
  if (git) {
    // ls-files reads the index, so staging the shipped skill is enough: no commit or identity needed.
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "skills/demo/SKILL.md"], { cwd: root });
  }
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
  for (const segments of UNTRACKED_OPERATOR_FILES) {
    assert.equal(fs.existsSync(path.join(runtimeRoot, ...segments)), false, `${segments.join("/")} leaked`);
  }
  assert.equal(fs.existsSync(path.join(runtimeRoot, "workspaces")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills", "demo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills", "workspace")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "home")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "backups")), true);
  const providers = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "config", "llm-providers.json"), "utf8"));
  assert.deepEqual(
    providers.providers.map((provider) => provider.providerId),
    [DETERMINISTIC_LLM_PROVIDER_ID],
  );
});

test("prepareTestbenchRuntime refuses to copy skills without git tracking info and leaves nothing behind", async (t) => {
  const sourceRoot = makeSourceRoot(t, { git: false });
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-parent-"));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  await assert.rejects(
    prepareTestbenchRuntime({ runId: "unit", stubBaseUrl: "http://127.0.0.1:1/v1", sourceRoot, tempParent }),
    /git/i,
  );
  assert.deepEqual(fs.readdirSync(tempParent), []);
});

test("buildTestbenchGatewayEnv keeps home and backups inside the runtime root and turns Code Mode on", () => {
  const runtimeRoot = path.join(os.tmpdir(), "goatcitadel-usability-unit");
  const env = buildTestbenchGatewayEnv(runtimeRoot);
  for (const key of [
    "GOATCITADEL_HOME",
    "GOATCITADEL_BACKUP_DIR",
    "GOATCITADEL_LOCAL_ENV_FILE",
    "GOATCITADEL_CODE_MODE_ARTIFACT_ROOT",
    "GOATCITADEL_CODE_MODE_TEMP_ROOT",
  ]) {
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
