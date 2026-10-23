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
  CLAUDE_CODE_CLI_MODEL,
  TESTBENCH_INHERITED_PATH_ENV_KEYS,
  TESTBENCH_STUB_KEY,
  buildTestbenchEnvOmit,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  parseClaudeAuthStatus,
  readClaudeCodeCliAuthStatus,
  parseTestbenchArgs,
  prepareTestbenchRuntime,
  writeClaudeCodeCliProviderConfig,
} from "./testbench-runtime.mjs";
import { buildVerificationProcessEnv } from "./verification/lib/runtime.mjs";

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

test("prepareTestbenchRuntime removes the runtime root when copying a tracked skill fails", async (t) => {
  const sourceRoot = makeSourceRoot(t);
  // The tracked skill file is now a directory in the working tree, so copying it fails with an error other than ENOENT.
  const trackedSkill = path.join(sourceRoot, "skills", "demo", "SKILL.md");
  fs.rmSync(trackedSkill);
  fs.mkdirSync(trackedSkill);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-parent-"));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  await assert.rejects(
    prepareTestbenchRuntime({ runId: "unit", stubBaseUrl: "http://127.0.0.1:1/v1", sourceRoot, tempParent }),
    (error) => error?.code !== "ENOENT",
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
  // The platform runner is on, but the sandbox stays required, so a machine without isolation still fails closed.
  assert.equal(env.GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED, "true");
  assert.equal(env.GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED, "true");
  assert.equal(env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED, "true");
  assert.equal(env.GOATCITADEL_BUNDLED_POSTGRES_ENABLED, "false");
  assert.equal(env.GOATCITADEL_LLAMACPP_ENABLED, "false");
  assert.equal(env.GOATCITADEL_NPU_ENABLED, "false");
  assert.equal(env[DETERMINISTIC_LLM_KEY_ENV], TESTBENCH_STUB_KEY);
});

test("path overrides the operator shell may set are omitted from the sandbox, never pinned", () => {
  assert.ok(TESTBENCH_INHERITED_PATH_ENV_KEYS.length > 0);
  const pinned = Object.keys(buildTestbenchGatewayEnv(path.join(os.tmpdir(), "goatcitadel-usability-unit")));
  for (const key of TESTBENCH_INHERITED_PATH_ENV_KEYS) {
    assert.match(key, /^GOATCITADEL_[A-Z_]+$/);
    assert.equal(pinned.includes(key), false, `${key} is both pinned and omitted`);
  }
});

const OPERATOR_ENV = {
  PATH: "x",
  GOATCITADEL_SESSION_CONTROL_SECRET_DIR: "C:/secret",
  GOATCITADEL_APP_DIR: "C:/app",
  goatcitadel_lower_case: "y",
  VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
  VITE_OTHER: "z",
};

test("buildTestbenchEnvOmit lists the secrets, every GoatCitadel setting in the shell, and the known path keys", () => {
  const omit = buildTestbenchEnvOmit(["OPENAI_API_KEY"], OPERATOR_ENV);
  assert.equal(omit[0], "OPENAI_API_KEY");
  for (const key of [
    "OPENAI_API_KEY",
    "GOATCITADEL_SESSION_CONTROL_SECRET_DIR",
    "GOATCITADEL_APP_DIR",
    "goatcitadel_lower_case",
    "VITE_GOATCITADEL_VISUAL_REGRESSION_MODE",
    ...TESTBENCH_INHERITED_PATH_ENV_KEYS,
  ]) {
    assert.ok(omit.includes(key), `${key} is not omitted`);
  }
  for (const key of ["PATH", "VITE_OTHER"]) {
    assert.equal(omit.includes(key), false, `${key} must stay inherited`);
  }
  assert.deepEqual(buildTestbenchEnvOmit([], {}), [...TESTBENCH_INHERITED_PATH_ENV_KEYS]);
});

test("buildTestbenchEnvOmit lists each key once when the shell sets a known path key or a secret", () => {
  const env = { GOATCITADEL_PROMPT_PACK_PATH: "C:/pack.md", OPENAI_API_KEY: "sk-test" };
  const omit = buildTestbenchEnvOmit(["OPENAI_API_KEY", "OPENAI_API_KEY"], env);
  assert.equal(new Set(omit).size, omit.length);
  assert.equal(omit.filter((key) => key === "GOATCITADEL_PROMPT_PACK_PATH").length, 1);
  assert.equal(omit.filter((key) => key === "OPENAI_API_KEY").length, 1);
});

test("the sandbox children inherit no GoatCitadel setting from the shell, but keep the launcher's own settings", () => {
  const runtimeRoot = path.join(os.tmpdir(), "goatcitadel-usability-unit");
  const operatorEnv = {
    ...OPERATOR_ENV,
    OPENAI_API_KEY: "sk-test",
    GOATCITADEL_HOME: "C:/operator-home",
    GOATCITADEL_BACKUP_DIR: "C:/operator-backups",
    GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "false",
    NODE_ENV: "production",
  };
  const omit = buildTestbenchEnvOmit(["OPENAI_API_KEY"], operatorEnv);

  const gateway = buildVerificationProcessEnv(operatorEnv, buildTestbenchGatewayEnv(runtimeRoot), omit);
  // In production the gateway would reject the test bench's Vite origin.
  assert.equal(gateway.NODE_ENV, "development");
  assert.equal(gateway.GOATCITADEL_HOME, path.join(runtimeRoot, "home"));
  assert.equal(gateway.GOATCITADEL_BACKUP_DIR, path.join(runtimeRoot, "backups"));
  assert.equal(gateway.GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED, "true");
  for (const key of ["GOATCITADEL_SESSION_CONTROL_SECRET_DIR", "GOATCITADEL_APP_DIR", "goatcitadel_lower_case"]) {
    assert.equal(gateway[key], undefined, `${key} leaked into the gateway`);
  }
  assert.equal(gateway.OPENAI_API_KEY, undefined);
  assert.equal(gateway.PATH, "x");

  const ui = buildVerificationProcessEnv(
    operatorEnv,
    buildTestbenchUiEnv({ gatewayUrl: "http://127.0.0.1:41873", runtimeRoot }),
    omit,
  );
  assert.equal(ui.NODE_ENV, "development");
  assert.equal(ui.VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN, "http://127.0.0.1:41873");
  assert.equal(ui.VITE_GOATCITADEL_VISUAL_REGRESSION_MODE, undefined);
  assert.equal(ui.VITE_OTHER, "z");
});

test("buildTestbenchUiEnv runs Vite in development and hands the page the sandbox origin, root, and real origin", () => {
  assert.deepEqual(buildTestbenchUiEnv({ gatewayUrl: "http://127.0.0.1:41873", runtimeRoot: "/tmp/root" }), {
    NODE_ENV: "development",
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: "http://127.0.0.1:41873",
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: "/tmp/root",
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: "http://127.0.0.1:8787",
  });
});

test("buildTestbenchUrl points at the sandbox target", () => {
  assert.equal(buildTestbenchUrl("http://127.0.0.1:5199/"), "http://127.0.0.1:5199/testbench.html?target=sandbox");
});

test("parseTestbenchArgs defaults to the stub and accepts both provider spellings", () => {
  assert.deepEqual(parseTestbenchArgs([]), { provider: "stub" });
  assert.deepEqual(parseTestbenchArgs(["--provider", "claude-code-cli"]), { provider: "claude-code-cli" });
  assert.deepEqual(parseTestbenchArgs(["--provider=claude-code-cli"]), { provider: "claude-code-cli" });
  assert.throws(() => parseTestbenchArgs(["--provider", "openai"]), /stub, claude-code-cli/);
  assert.throws(() => parseTestbenchArgs(["--provider"]), /stub, claude-code-cli/);
  assert.throws(() => parseTestbenchArgs(["--nope"]), /Unknown test bench option/);
});

test("parseClaudeAuthStatus accepts only a first-party subscription login", () => {
  const ok = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.test" });
  assert.deepEqual(parseClaudeAuthStatus(ok), { ready: true, reason: "ready", accountEmail: "a@b.test" });
  assert.deepEqual(parseClaudeAuthStatus(`warning: update available\n${ok}\n`).ready, true);
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false })).reason, "not_logged_in");
  assert.equal(
    parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" })).reason,
    "not_subscription_login",
  );
  assert.equal(
    parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, apiProvider: "bedrock" })).reason,
    "not_subscription_login",
  );
  assert.deepEqual(parseClaudeAuthStatus("warning: x"), { ready: false, reason: "unparseable" });
});

test("writeClaudeCodeCliProviderConfig makes the CLI the only active provider in both config files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-cli-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.json"),
    JSON.stringify({ assistant: { keep: true }, llm: {}, generation: {} }),
  );
  await writeClaudeCodeCliProviderConfig(root);
  const unified = JSON.parse(fs.readFileSync(path.join(root, "config", "goatcitadel.json"), "utf8"));
  const providers = JSON.parse(fs.readFileSync(path.join(root, "config", "llm-providers.json"), "utf8"));
  const expected = {
    providerId: "claude-code-cli",
    label: "Claude Code CLI (local login)",
    baseUrl: "https://api.anthropic.com/v1",
    apiStyle: "claude-code-cli",
    defaultModel: CLAUDE_CODE_CLI_MODEL,
    authMode: "claude-code-cli-login",
  };
  for (const llm of [unified.llm, providers]) {
    assert.equal(llm.activeProviderId, "claude-code-cli");
    assert.equal(llm.activeModel, "claude-sonnet-5-5");
    assert.deepEqual(llm.providers, [expected]);
  }
  assert.equal("generation" in unified, false);
  assert.deepEqual(unified.assistant, { keep: true });
});

test("buildTestbenchGatewayEnv copies the CLI path only for the CLI provider", () => {
  const env = { GOATCITADEL_CLAUDE_CLI_PATH: "/opt/claude" };
  assert.equal(
    buildTestbenchGatewayEnv("/r", { provider: "claude-code-cli", env }).GOATCITADEL_CLAUDE_CLI_PATH,
    "/opt/claude",
  );
  assert.equal(buildTestbenchGatewayEnv("/r", { provider: "stub", env }).GOATCITADEL_CLAUDE_CLI_PATH, undefined);
  assert.equal(buildTestbenchGatewayEnv("/r").GOATCITADEL_CLAUDE_CLI_PATH, undefined);
});

test("readClaudeCodeCliAuthStatus runs `auth status --json` and reports an unavailable CLI", () => {
  const calls = [];
  const ok = readClaudeCodeCliAuthStatus({
    env: { GOATCITADEL_CLAUDE_CLI_PATH: " /opt/claude " },
    spawn: (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout });
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    },
  });
  assert.deepEqual(ok, { ready: true, reason: "ready" });
  assert.deepEqual(calls, [{ command: "/opt/claude", args: ["auth", "status", "--json"], timeout: 15_000 }]);
  const missing = readClaudeCodeCliAuthStatus({ env: {}, spawn: () => ({ error: new Error("ENOENT") }) });
  assert.deepEqual(missing, { ready: false, reason: "cli_unavailable" });
});

test("readClaudeCodeCliAuthStatus runs a Windows npm shim through its cli.js, as the gateway does", () => {
  const shimDir = path.win32.join("C:", "npm");
  const cliJs = path.win32.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const nodeExe = path.win32.join("C:", "node", "node.exe");
  const ok = JSON.stringify({ loggedIn: true });
  for (const shim of ["claude.cmd", "claude.bat", "claude.ps1"]) {
    const calls = [];
    const status = readClaudeCodeCliAuthStatus({
      env: { GOATCITADEL_CLAUDE_CLI_PATH: path.win32.join(shimDir, shim) },
      platform: "win32",
      execPath: nodeExe,
      fileExists: (file) => file === cliJs,
      spawn: (command, args, options) => {
        calls.push({ command, args, shell: options?.shell });
        return { stdout: ok };
      },
    });
    assert.equal(status.ready, true, shim);
    assert.deepEqual(calls, [{ command: nodeExe, args: [cliJs, "auth", "status", "--json"], shell: undefined }]);
  }
  const missing = readClaudeCodeCliAuthStatus({
    env: { GOATCITADEL_CLAUDE_CLI_PATH: path.win32.join(shimDir, "claude.cmd") },
    platform: "win32",
    fileExists: () => false,
    spawn: () => assert.fail("must not spawn an unsupported shim"),
  });
  assert.deepEqual(missing, { ready: false, reason: "cli_unsupported_shim" });
});

test("readClaudeCodeCliAuthStatus uses a shell only for a bare command on Windows", () => {
  const seen = [];
  const spawn = (command, args, options) => {
    seen.push({ command, args, shell: (Array.isArray(args) ? options : args)?.shell === true });
    return { stdout: JSON.stringify({ loggedIn: true }) };
  };
  readClaudeCodeCliAuthStatus({ env: {}, platform: "win32", spawn });
  readClaudeCodeCliAuthStatus({ env: {}, platform: "linux", spawn });
  const nativeExe = path.win32.join("C:", "bin", "claude.exe");
  readClaudeCodeCliAuthStatus({ env: { GOATCITADEL_CLAUDE_CLI_PATH: nativeExe }, platform: "win32", spawn });
  assert.deepEqual(
    seen.map((call) => [call.command, call.shell]),
    [
      ['"claude" auth status --json', true],
      ["claude", false],
      [nativeExe, false],
    ],
  );
});
