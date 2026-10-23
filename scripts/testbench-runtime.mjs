import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { prepareUsabilityRuntime } from "./verification/lib/scenarios/usability-runtime-fixture.mjs";
import { repoRoot } from "./verification/lib/shared.mjs";

export const TESTBENCH_STUB_KEY = "verification-stub-key";
export const DEFAULT_REAL_GATEWAY_ORIGIN = "http://127.0.0.1:8787";
export const TESTBENCH_PROVIDERS = Object.freeze(["stub", "claude-code-cli"]);
export const CLAUDE_CODE_CLI_MODEL = "claude-sonnet-5-5";
/** The gateway reads the operator's CLI location from this variable (see claude-code-cli-process.ts). */
export const CLAUDE_CLI_PATH_ENV = "GOATCITADEL_CLAUDE_CLI_PATH";

/** Same entry as the built-in `claude-code-cli` provider in apps/gateway/src/config.ts. */
const CLAUDE_CODE_CLI_PROVIDER = Object.freeze({
  providerId: "claude-code-cli",
  label: "Claude Code CLI (local login)",
  baseUrl: "https://api.anthropic.com/v1",
  apiStyle: "claude-code-cli",
  authMode: "claude-code-cli-login",
});

/** Parses the launcher's own options: only `--provider <id>` / `--provider=<id>`, defaulting to the stub. */
export function parseTestbenchArgs(argv) {
  let provider = "stub";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value;
    if (arg === "--provider") {
      value = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--provider=")) {
      value = arg.slice("--provider=".length);
    } else {
      throw new Error(
        `Unknown test bench option "${arg}". The only option is --provider <${TESTBENCH_PROVIDERS.join("|")}>.`,
      );
    }
    if (!TESTBENCH_PROVIDERS.includes(value)) {
      throw new Error(`Unknown test bench provider "${value ?? ""}". Use one of: ${TESTBENCH_PROVIDERS.join(", ")}.`);
    }
    provider = value;
  }
  return { provider };
}

/**
 * Makes the built-in Claude Code CLI provider the only, active provider of a sandbox runtime root, in both the unified
 * config and the compatibility provider file (the same two files live-provider-preqa rewrites).
 */
export async function writeClaudeCodeCliProviderConfig(runtimeRoot, model = CLAUDE_CODE_CLI_MODEL) {
  const llm = {
    activeProviderId: CLAUDE_CODE_CLI_PROVIDER.providerId,
    activeModel: model,
    providers: [
      {
        providerId: CLAUDE_CODE_CLI_PROVIDER.providerId,
        label: CLAUDE_CODE_CLI_PROVIDER.label,
        baseUrl: CLAUDE_CODE_CLI_PROVIDER.baseUrl,
        apiStyle: CLAUDE_CODE_CLI_PROVIDER.apiStyle,
        defaultModel: model,
        authMode: CLAUDE_CODE_CLI_PROVIDER.authMode,
      },
    ],
  };
  const unifiedPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  const unified = JSON.parse(await fs.readFile(unifiedPath, "utf8"));
  const { generation: _generation, ...rest } = unified;
  await fs.writeFile(unifiedPath, `${JSON.stringify({ ...rest, llm }, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(runtimeRoot, "config", "llm-providers.json"),
    `${JSON.stringify(llm, null, 2)}\n`,
    "utf8",
  );
  return llm;
}

/**
 * Reads `claude auth status --json` with the gateway's own readiness rule (claude-code-cli-readiness.ts): ready only
 * for a first-party subscription login. `accountEmail` exists so evidence can be scanned for it; never log it.
 */
export function parseClaudeAuthStatus(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object") return { ready: false, reason: "unparseable" };
  const accountEmail = typeof parsed.email === "string" ? { accountEmail: parsed.email } : {};
  if (parsed.loggedIn !== true) return { ready: false, reason: "not_logged_in", ...accountEmail };
  const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : "";
  const apiProvider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : "firstParty";
  if (apiProvider !== "firstParty" || /api[_\s-]?key|apikey|console/i.test(authMethod)) {
    return { ready: false, reason: "not_subscription_login", ...accountEmail };
  }
  return { ready: true, reason: "ready", ...accountEmail };
}

const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 15_000;
const WINDOWS_CLI_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Runs `claude auth status --json` (honouring GOATCITADEL_CLAUDE_CLI_PATH) and parses it. Its output names the
 * signed-in account, so callers print only `ready` and `reason`.
 */
export function readClaudeCodeCliAuthStatus({
  env = process.env,
  spawn = spawnSync,
  platform = process.platform,
  fileExists = existsSync,
  execPath = process.execPath,
} = {}) {
  const command = env[CLAUDE_CLI_PATH_ENV]?.trim() || "claude";
  const args = ["auth", "status", "--json"];
  const options = { encoding: "utf8", timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS };
  let result;
  if (platform === "win32" && !path.win32.isAbsolute(command)) {
    // A bare "claude" on Windows is a .cmd shim that only a shell resolves; the shell gets one fixed command string.
    result = spawn(`"${command}" ${args.join(" ")}`, { ...options, shell: true });
  } else if (platform === "win32" && WINDOWS_CLI_SHIM_EXTENSIONS.has(path.win32.extname(command).toLowerCase())) {
    // Same rule as the gateway's resolveClaudeCliInvocation: an npm shim runs as `node <its cli.js>`.
    const cliJs = path.win32.join(
      path.win32.dirname(command),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    if (!fileExists(cliJs)) return { ready: false, reason: "cli_unsupported_shim" };
    result = spawn(execPath, [cliJs, ...args], options);
  } else {
    result = spawn(command, args, options);
  }
  if (result?.error) {
    // Only a missing executable is "unavailable"; any other start failure keeps just its code, never CLI output.
    const code = result.error.code;
    return { ready: false, reason: code === "ENOENT" ? "cli_unavailable" : `cli_start_failed:${code ?? "unknown"}` };
  }
  return parseClaudeAuthStatus(result?.stdout);
}

const SIGN_IN_REASONS = new Set(["not_logged_in", "not_subscription_login", "unparseable"]);

/** One message for every not-ready reason; only sign-in problems get sign-in guidance. */
export function claudeCliNotReadyMessage(reason) {
  let guidance;
  if (SIGN_IN_REASONS.has(reason)) guidance = "Run `claude` and sign in with your Claude subscription.";
  else if (reason === "cli_unavailable") {
    guidance = `Install the Claude Code CLI, or set ${CLAUDE_CLI_PATH_ENV} to its executable.`;
  } else if (reason === "cli_unsupported_shim") {
    guidance = `${CLAUDE_CLI_PATH_ENV} points at an npm shim without its cli.js; point it at claude.exe or a full npm install.`;
  } else
    guidance = `The Claude Code CLI could not start; check its install and file permissions, or ${CLAUDE_CLI_PATH_ENV}.`;
  return `Claude Code CLI is not ready (${reason}). ${guidance}`;
}

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
  const runtimeRoot = await prepareUsabilityRuntime(runId, stubBaseUrl, { sourceRoot, tempParent, copySkills: false });
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
export function buildTestbenchGatewayEnv(runtimeRoot, { provider = "stub", env = process.env } = {}) {
  // buildTestbenchEnvOmit strips every GOATCITADEL_* variable, so an operator's CLI location must be copied explicitly.
  const cliPath = provider === "claude-code-cli" ? env[CLAUDE_CLI_PATH_ENV]?.trim() : undefined;
  return {
    ...(cliPath ? { [CLAUDE_CLI_PATH_ENV]: cliPath } : {}),
    NODE_ENV: TESTBENCH_NODE_ENV,
    GOATCITADEL_HOME: path.join(runtimeRoot, "home"),
    GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
    // Points at a file that does not exist, so no operator .env is read or written.
    GOATCITADEL_LOCAL_ENV_FILE: path.join(runtimeRoot, ".env"),
    GOATCITADEL_CODE_MODE_ARTIFACT_ROOT: path.join(runtimeRoot, "data", "code-mode", "artifacts"),
    GOATCITADEL_CODE_MODE_TEMP_ROOT: path.join(runtimeRoot, "data", "code-mode", "tmp"),
    GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
    // The shipped example config disables the platform runner, so every Code Mode run would fail closed. Enable it
    // as the repo's Code Mode verification lanes do, and keep the sandbox required: where the platform's isolation
    // adapter is unavailable the run still fails closed, and the host check reports that as blocked.
    GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "true",
    GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED: "true",
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
