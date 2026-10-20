import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { redactSecretText } from "@goatcitadel/contracts";

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
const CLAUDE_CLI_ISOLATION_SETTINGS = JSON.stringify({ disableAllHooks: true });
const QUEUE_HIGH_WATER = 256;
const QUEUE_LOW_WATER = 32;

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

export function buildClaudeCliArgs(input: { model: string; systemPromptFile?: string }): string[] {
  const model = input.model.trim();
  if (!CLAUDE_CLI_MODEL_PATTERN.test(model)) {
    throw new ClaudeCliError("claude_cli_model_unavailable", "The selected model id is not a valid Claude model id");
  }
  return [
    "-p",
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
    "--safe-mode",
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

type QueueItem =
  | { kind: "line"; line: string }
  | { kind: "done"; exit: ClaudeCliExit }
  | { kind: "error"; error: Error };

/** Runs the CLI once and yields complete stdout lines; the return value carries the exit code and stderr tail. */
export async function* runClaudeCli(input: RunClaudeCliInput): AsyncGenerator<string, ClaudeCliExit> {
  if (input.signal?.aborted) {
    throw new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was cancelled before it started");
  }
  const spawnFn = input.spawn ?? (nodeSpawn as ClaudeCliSpawn);
  const killTree = input.killTree ?? ((pid: number) => killClaudeCliProcessTree(pid));
  const child = spawnFn(input.invocation.command, [...input.invocation.prefixArgs, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    // Own process group on POSIX so cancellation reaches the CLI's children too.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const queue: QueueItem[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let killed = false;
  let closed = false;
  let finished = false;
  let stdoutBuffer = "";
  let stderrTail = "";
  const push = (item: QueueItem) => {
    if (settled) return;
    if (item.kind !== "line") settled = true;
    queue.push(item);
    if (queue.length >= QUEUE_HIGH_WATER) child.stdout?.pause();
    wake?.();
  };
  const terminate = (error: Error) => {
    if (settled) return;
    push({ kind: "error", error });
    if (!killed && !closed && child.pid !== undefined) {
      killed = true;
      killTree(child.pid);
    }
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (finished || settled) return;
    idleTimer = setTimeout(
      () => terminate(new ClaudeCliError("claude_cli_timeout", "The Claude Code CLI stopped producing output")),
      input.idleTimeoutMs,
    );
  };
  const overallTimer = setTimeout(
    () => terminate(new ClaudeCliError("claude_cli_timeout", "The Claude Code CLI run exceeded its time limit")),
    input.overallTimeoutMs,
  );
  const onAbort = () => terminate(new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was cancelled"));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  armIdle();

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    armIdle();
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) push({ kind: "line", line });
      newline = stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(stdoutBuffer, "utf8") > CLAUDE_CLI_MAX_LINE_BYTES) {
      stdoutBuffer = "";
      terminate(new ClaudeCliError("claude_cli_failed", "The Claude Code CLI emitted an oversized output line"));
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-CLAUDE_CLI_STDERR_TAIL_BYTES);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    terminate(
      error.code === "ENOENT"
        ? new ClaudeCliError("claude_cli_missing", "The Claude Code CLI executable was not found", { cause: error })
        : new ClaudeCliError("claude_cli_failed", "The Claude Code CLI could not be started", { cause: error }),
    );
  });
  child.on("close", (code: number | null) => {
    closed = true;
    const tail = stdoutBuffer.replace(/\r$/, "");
    stdoutBuffer = "";
    if (tail.trim()) push({ kind: "line", line: tail });
    push({ kind: "done", exit: { exitCode: code, stderrTail } });
  });

  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", (error) =>
    terminate(new ClaudeCliError("claude_cli_failed", "The Claude Code CLI output stream failed", { cause: error })),
  );
  child.stderr?.on("error", () => undefined);
  child.stdin?.end(Buffer.from(input.stdinPayload, "utf8"));

  try {
    for (;;) {
      const item = queue.shift();
      if (queue.length <= QUEUE_LOW_WATER && child.stdout?.isPaused()) child.stdout.resume();
      if (!item) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      if (item.kind === "line") {
        yield item.line;
        continue;
      }
      if (item.kind === "error") throw item.error;
      return item.exit;
    }
  } finally {
    finished = true;
    clearTimeout(overallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    input.signal?.removeEventListener("abort", onAbort);
    // A consumer that stops early (or fails mid-stream) must not leave the CLI running.
    if (!killed && !closed && child.pid !== undefined) {
      settled = true;
      killed = true;
      killTree(child.pid);
    }
  }
}
