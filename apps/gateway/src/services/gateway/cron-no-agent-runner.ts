import { spawn, type ChildProcess } from "node:child_process";

/** Applied when a job does not set `timeoutMs`. */
export const NO_AGENT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Ceiling for any configured or requested timeout. */
export const NO_AGENT_MAX_TIMEOUT_MS = 60 * 60 * 1000;
/**
 * Per-stream capture ceiling in decoded characters (JavaScript string length, UTF-16 code units),
 * not bytes; the tail is kept when output is longer.
 */
export const NO_AGENT_MAX_OUTPUT_CHARS = 1024 * 1024;
/**
 * How long a run waits for its stdio to close after the timeout kill, or after the direct child
 * exits, before it settles anyway. A descendant that inherited stdio can hold the pipes open
 * indefinitely; this bound is what guarantees every run settles.
 */
export const NO_AGENT_SETTLE_GRACE_MS = 2000;

const IS_WINDOWS = process.platform === "win32";

export interface NoAgentRunInput {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the default timeout used when `timeoutMs` is absent. */
  defaultTimeoutMs?: number;
  /** Test seam: replaces the timeout process-tree kill (for example to prove the settle backstop). */
  killProcessTree?: (child: ChildProcess) => void;
}

export interface NoAgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Node spawn error code (for example ENOENT) when the process could not be started. */
  spawnErrorCode?: string;
}

export function resolveNoAgentTimeoutMs(timeoutMs: number | undefined, defaultTimeoutMs?: number): number {
  const requested =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : (defaultTimeoutMs ?? NO_AGENT_DEFAULT_TIMEOUT_MS);
  return Math.min(requested, NO_AGENT_MAX_TIMEOUT_MS);
}

/**
 * Keeps the last `NO_AGENT_MAX_OUTPUT_CHARS` characters of a stream without repeated string
 * concatenation: chunks are appended to an array, whole leading chunks are dropped once they are
 * no longer needed for the tail, and the result is joined once when the run settles.
 */
class TailCapture {
  // Private, append-only buffer: pushing in place keeps each append O(1).
  private readonly chunks: string[] = [];
  /** Index of the first retained chunk; earlier entries are released lazily. */
  private head = 0;
  private length = 0;
  private dropped = false;

  public push(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (
      this.head < this.chunks.length - 1 &&
      this.length - (this.chunks[this.head] ?? "").length >= NO_AGENT_MAX_OUTPUT_CHARS
    ) {
      this.length -= (this.chunks[this.head] ?? "").length;
      this.chunks[this.head] = "";
      this.head += 1;
      this.dropped = true;
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }

  public read(): { value: string; truncated: boolean } {
    const joined = this.chunks.slice(this.head).join("");
    return joined.length > NO_AGENT_MAX_OUTPUT_CHARS
      ? { value: joined.slice(joined.length - NO_AGENT_MAX_OUTPUT_CHARS), truncated: true }
      : { value: joined, truncated: this.dropped };
  }
}

/**
 * Best-effort process-tree kill. Windows: `taskkill /T /F` on the child pid (run with
 * `shell: false`), falling back to killing the direct child. Elsewhere the child is spawned as a
 * process-group leader (`detached: true`), so the whole group is sent SIGKILL. Descendants that
 * left the tree or group (for example by starting their own session) are not reached.
 */
function defaultKillProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (IS_WINDOWS) {
    let fellBack = false;
    const fallback = (): void => {
      if (fellBack) return;
      fellBack = true;
      child.kill("SIGKILL");
    };
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", fallback);
      killer.on("exit", fallback);
    } catch {
      fallback();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runNoAgentCommand(input: NoAgentRunInput): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.workdir,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: make the child a process-group leader so the timeout can kill its whole group.
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const killProcessTree = input.killProcessTree ?? defaultKillProcessTree;

    const stdout = new TailCapture();
    const stderr = new TailCapture();
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let spawnErrorCode: string | undefined;
    let graceId: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const settle = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if (graceId) clearTimeout(graceId);
      const out = stdout.read();
      const err = stderr.read();
      resolve({
        stdout: out.value,
        stderr: err.value,
        exitCode: code,
        timedOut,
        ...(out.truncated ? { stdoutTruncated: true } : {}),
        ...(err.truncated ? { stderrTruncated: true } : {}),
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    };

    // Settle even when a descendant keeps the inherited stdio pipes open (no "close" event).
    const scheduleForcedSettle = (): void => {
      if (settled || graceId) return;
      graceId = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(exitCode);
      }, NO_AGENT_SETTLE_GRACE_MS);
    };

    const timeoutId = setTimeout(
      () => {
        timedOut = true;
        try {
          killProcessTree(child);
        } catch {
          // Fall back to the direct child; the forced settle below still bounds the run.
          child.kill("SIGKILL");
        }
        scheduleForcedSettle();
      },
      resolveNoAgentTimeoutMs(input.timeoutMs, input.defaultTimeoutMs),
    );

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? error.name;
      settle(null);
    });
    child.on("exit", (code) => {
      exitCode = code;
      scheduleForcedSettle();
    });
    child.on("close", (code) => settle(code));
  });
}
