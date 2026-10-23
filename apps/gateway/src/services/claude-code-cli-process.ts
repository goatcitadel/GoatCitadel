import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { redactSecretText } from "@goatcitadel/contracts";
import { startClaudeCliSession } from "./claude-code-cli-session.js";

/**
 * Process plumbing for the `claude-code-cli` provider. The Gateway runs the
 * operator's own Claude Code CLI as a pure text model: no shell, no user text
 * in argv, every CLI tool surface disabled, and a scrubbed environment so the
 * CLI can only use the operator's own `claude` login.
 */

export const CLAUDE_CLI_REASON_CODES = [
  "claude_cli_missing",
  "claude_cli_logged_out",
  "claude_cli_usage_limited",
  "claude_cli_incompatible",
  "claude_cli_model_unavailable",
  "claude_cli_tool_use_blocked",
  "claude_cli_timeout",
  "claude_cli_failed",
  "claude_cli_tools_unsupported",
  "claude_cli_not_subscription_login",
  "claude_cli_unsupported_shim",
  "claude_cli_cancelled",
  "claude_cli_hook_blocked",
  "claude_cli_managed_hooks_active",
  "claude_cli_bridge_unavailable",
  "claude_cli_bridge_mismatch",
] as const;

export type ClaudeCliReasonCode = (typeof CLAUDE_CLI_REASON_CODES)[number];

export function isClaudeCliReasonCode(value: string): value is ClaudeCliReasonCode {
  return (CLAUDE_CLI_REASON_CODES as readonly string[]).includes(value);
}

export class ClaudeCliError extends Error {
  public readonly reasonCode: ClaudeCliReasonCode;
  public readonly exitCode?: number | null;
  public readonly stderrTail?: string;

  public constructor(
    reasonCode: ClaudeCliReasonCode,
    message: string,
    details: { exitCode?: number | null; stderrTail?: string; cause?: unknown } = {},
  ) {
    super(`${message} (${reasonCode})`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ClaudeCliError";
    this.reasonCode = reasonCode;
    this.exitCode = details.exitCode;
    // Errors are logged with their own properties; never carry raw CLI stderr (it can echo secrets).
    this.stderrTail = details.stderrTail === undefined ? undefined : redactSecretText(details.stderrTail).value;
  }
}

export type ClaudeCliSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeCliInvocation {
  command: string;
  /** Arguments placed before the CLI flags, e.g. the npm package `cli.js` when run through node. */
  prefixArgs: string[];
}

export interface ClaudeCliExit {
  exitCode: number | null;
  stderrTail: string;
}

export const CLAUDE_CLI_PATH_ENV = "GOATCITADEL_CLAUDE_CLI_PATH";
export const CLAUDE_CLI_MAX_LINE_BYTES = 1024 * 1024;
export const CLAUDE_CLI_STDERR_TAIL_BYTES = 16 * 1024;
const CLAUDE_CLI_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);
// autoMemoryEnabled: false keeps Claude Code's per-project auto-memory (MEMORY.md) out of the model's
// context; `--setting-sources ""` does not, and a run dir inside a git repo maps to that repo's memory.
const CLAUDE_CLI_ISOLATION_SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false });
/** How long cleanup waits for a killed CLI tree to close, so callers can remove its cwd afterwards. */
export const CLAUDE_CLI_KILL_CLOSE_WAIT_MS = 5000;

export function resolveClaudeCliInvocation(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  candidates: readonly string[];
  fileExists: (filePath: string) => boolean;
  execPath?: string;
}): ClaudeCliInvocation | { error: "claude_cli_missing" | "claude_cli_unsupported_shim" } {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const execPath = input.execPath ?? process.execPath;
  const override = input.env[CLAUDE_CLI_PATH_ENV]?.trim();
  const candidates = override
    ? input.fileExists(override)
      ? [override]
      : []
    : input.candidates.map((candidate) => candidate.trim()).filter(Boolean);
  if (candidates.length === 0) return { error: "claude_cli_missing" };

  const extensionOf = (candidate: string) => pathApi.extname(candidate).toLowerCase();
  if (platform === "win32") {
    const native = candidates.find((candidate) => extensionOf(candidate) === ".exe");
    if (native) return { command: native, prefixArgs: [] };
    for (const shim of candidates.filter((candidate) => SHIM_EXTENSIONS.has(extensionOf(candidate)))) {
      const cliJs = pathApi.join(pathApi.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (input.fileExists(cliJs)) return { command: execPath, prefixArgs: [cliJs] };
    }
    return { error: "claude_cli_unsupported_shim" };
  }
  return { command: candidates[0] as string, prefixArgs: [] };
}

export function buildClaudeCliArgs(input: {
  model: string;
  systemPromptFile?: string;
  /** Tool-bridge step: the CLI gets the inert MCP stub; its `mcp__goatcitadel` tools are allowed, nothing else. */
  bridge?: { mcpConfigPath: string };
}): string[] {
  const model = input.model.trim();
  if (!CLAUDE_CLI_MODEL_PATTERN.test(model)) {
    throw new ClaudeCliError("claude_cli_model_unavailable", "The selected model id is not a valid Claude model id");
  }
  return [
    "-p",
    ...(input.bridge ? ["--mcp-config", input.bridge.mcpConfigPath] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Surfaces any hook that still runs (e.g. organization-managed hooks, which no user
    // flag can disable) so the stream mapper can fail the turn closed.
    "--include-hook-events",
    "--model",
    model,
    ...(input.systemPromptFile ? ["--system-prompt-file", input.systemPromptFile] : []),
    "--tools",
    "",
    "--strict-mcp-config",
    ...(input.bridge ? [] : ["--safe-mode"]),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    // Defense in depth beside --safe-mode: load no user/project/local settings files
    // (their env, apiKeyHelper or hooks) and disable hooks outright.
    "--setting-sources",
    "",
    "--settings",
    CLAUDE_CLI_ISOLATION_SETTINGS,
    ...(input.bridge ? ["--allowedTools", "mcp__goatcitadel", "--permission-prompts", "none"] : []),
  ];
}

const CLAUDE_CLI_ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ].map((key) => key.toUpperCase()),
);

/** Only allowlisted keys reach the child; Anthropic credentials and Gateway secrets never do. */
export function buildClaudeCliEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CLAUDE_CLI_ENV_ALLOWLIST.has(key.toUpperCase())) scrubbed[key] = value;
  }
  return scrubbed;
}

export function killClaudeCliProcessTree(
  pid: number,
  options: { platform?: NodeJS.Platform; spawn?: ClaudeCliSpawn } = {},
): void {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawn ?? (nodeSpawn as ClaudeCliSpawn);
  if (platform === "win32") {
    const killer = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    return;
  }
  // The child is spawned detached on POSIX, so -pid signals its whole process group.
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      try {
        process.kill(pid, name);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signal("SIGTERM")) return;
  const escalate = setTimeout(() => {
    signal("SIGKILL");
  }, 3000);
  escalate.unref();
}

export interface RunClaudeCliInput {
  invocation: ClaudeCliInvocation;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdinPayload: string;
  signal?: AbortSignal;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
  spawn?: ClaudeCliSpawn;
  killTree?: (pid: number) => void;
}

/** Runs the CLI once and yields complete stdout lines; the return value carries the exit code and stderr tail. */
export async function* runClaudeCli(input: RunClaudeCliInput): AsyncGenerator<string, ClaudeCliExit> {
  if (input.signal?.aborted) {
    throw new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was cancelled before it started");
  }
  // A single segment that never parks: closing it early kills the tree and waits (bounded) for it to close.
  return yield* startClaudeCliSession(input).segment(input);
}
