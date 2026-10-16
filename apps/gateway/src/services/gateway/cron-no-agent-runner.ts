import { spawn } from "node:child_process";

/** Applied when a job does not set `timeoutMs`. */
export const NO_AGENT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Ceiling for any configured or requested timeout. */
export const NO_AGENT_MAX_TIMEOUT_MS = 60 * 60 * 1000;
/** Per-stream capture ceiling; the tail is kept when output is longer. */
export const NO_AGENT_MAX_OUTPUT_CHARS = 1024 * 1024;

export interface NoAgentRunInput {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the default timeout used when `timeoutMs` is absent. */
  defaultTimeoutMs?: number;
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

function appendTail(current: string, chunk: string): { value: string; truncated: boolean } {
  const combined = current + chunk;
  return combined.length > NO_AGENT_MAX_OUTPUT_CHARS
    ? { value: combined.slice(combined.length - NO_AGENT_MAX_OUTPUT_CHARS), truncated: true }
    : { value: combined, truncated: false };
}

export async function runNoAgentCommand(input: NoAgentRunInput): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.workdir,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let spawnErrorCode: string | undefined;

    const timeoutId = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      resolveNoAgentTimeoutMs(input.timeoutMs, input.defaultTimeoutMs),
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendTail(stdout, chunk.toString("utf8"));
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendTail(stderr, chunk.toString("utf8"));
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        ...(stdoutTruncated ? { stdoutTruncated } : {}),
        ...(stderrTruncated ? { stderrTruncated } : {}),
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code ?? error.name;
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}
