import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import {
  CLAUDE_CLI_KILL_CLOSE_WAIT_MS,
  CLAUDE_CLI_MAX_LINE_BYTES,
  CLAUDE_CLI_STDERR_TAIL_BYTES,
  ClaudeCliError,
  killClaudeCliProcessTree,
  type ClaudeCliExit,
  type ClaudeCliSpawn,
  type RunClaudeCliInput,
} from "./claude-code-cli-process.js";

/**
 * One live `claude -p` process that can outlive the consumer that started it.
 * A segment is one consumer of its stdout lines and owns the timers and the abort
 * listener. Closing a segment kills the tree, unless the session was parked first:
 * then a drain vets every later line until the next segment resumes reading.
 *
 * Calling segment() ends the park at once: later lines queue for the new segment.
 * Its timers start at its first next(). Lines queued before park() but not yet read
 * stay queued for the next segment; the drain sees only lines that arrive while
 * parked, and drops them.
 */

export interface ClaudeCliSegmentOptions {
  signal?: AbortSignal;
  overallTimeoutMs: number;
  idleTimeoutMs: number;
}

export type ClaudeCliParkDrain = (line: string) => "ok" | "fault";

export interface ClaudeCliSession {
  readonly pid: number | undefined;
  readonly exited: Promise<ClaudeCliExit>;
  /** One consumer at a time. Closing it kills the tree, unless park() was called first. */
  segment(options: ClaudeCliSegmentOptions): AsyncGenerator<string, ClaudeCliExit>;
  /**
   * Stops the segment's timers and routes later lines to drain. "fault" kills the tree and
   * reports onFault("line"); an exit while parked reports onFault("exit"), with nothing left to kill.
   */
  park(drain: ClaudeCliParkDrain, onFault: (reason: "line" | "exit") => void): void;
  /** Tree kill plus the bounded close wait (CLAUDE_CLI_KILL_CLOSE_WAIT_MS). Idempotent. */
  kill(): Promise<void>;
}

type QueueItem =
  | { kind: "line"; line: string }
  | { kind: "done"; exit: ClaudeCliExit }
  | { kind: "error"; error: Error };

interface Parking {
  drain: ClaudeCliParkDrain;
  onFault: (reason: "line" | "exit") => void;
}

/** The running segment's timers; the stdout handler re-arms the idle timer through it. */
interface SegmentTimers {
  touch(): void;
  stop(): void;
}

const QUEUE_HIGH_WATER = 256;
const QUEUE_LOW_WATER = 32;

/** Spawns the CLI and writes the payload to stdin; read its stdout through segment(). */
export function startClaudeCliSession(input: RunClaudeCliInput): ClaudeCliSession {
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
  let segmentActive = false;
  let timers: SegmentTimers | undefined;
  let parking: Parking | undefined;
  let stdoutBuffer = "";
  let stderrTail = "";
  let markClosed: () => void = () => undefined;
  const childClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  let markExited: (exit: ClaudeCliExit) => void = () => undefined;
  const exited = new Promise<ClaudeCliExit>((resolve) => {
    markExited = resolve;
  });

  const push = (item: QueueItem) => {
    if (settled) return;
    if (item.kind !== "line") settled = true;
    queue.push(item);
    if (queue.length >= QUEUE_HIGH_WATER) child.stdout?.pause();
    wake?.();
  };
  const killTreeOnce = () => {
    if (killed || closed || child.pid === undefined) return;
    killed = true;
    killTree(child.pid);
  };
  const terminate = (error: Error) => {
    if (settled) return;
    push({ kind: "error", error });
    killTreeOnce();
  };
  /** Ends the park once; a drain fault kills the tree and fails any later segment. */
  const faultParked = (reason: "line" | "exit") => {
    const parked = parking;
    if (!parked) return;
    parking = undefined;
    if (reason === "line") {
      terminate(
        new ClaudeCliError("claude_cli_bridge_mismatch", "The parked Claude Code CLI emitted unexpected output"),
      );
      killTreeOnce();
    }
    parked.onFault(reason);
  };
  const deliver = (line: string) => {
    if (!parking) {
      push({ kind: "line", line });
      return;
    }
    let verdict: "ok" | "fault";
    try {
      verdict = parking.drain(line);
    } catch {
      verdict = "fault";
    }
    if (verdict === "fault") faultParked("line");
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    timers?.touch();
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) deliver(line);
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
    markClosed();
    const tail = stdoutBuffer.replace(/\r$/, "");
    stdoutBuffer = "";
    if (tail.trim()) deliver(tail);
    const exit = { exitCode: code, stderrTail };
    markExited(exit);
    push({ kind: "done", exit });
    faultParked("exit");
  });

  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", (error) =>
    terminate(new ClaudeCliError("claude_cli_failed", "The Claude Code CLI output stream failed", { cause: error })),
  );
  child.stderr?.on("error", () => undefined);
  child.stdin?.end(Buffer.from(input.stdinPayload, "utf8"));

  /** Kills the tree, then waits (bounded) for it to close so callers can remove its cwd afterwards. */
  const killAndWait = async () => {
    killTreeOnce();
    // Windows taskkill is fire-and-forget: wait (bounded) for the tree to close so the
    // caller's cwd cleanup does not race the dying CLI and its stub children.
    if (killed && !closed) await waitBounded(childClosed, CLAUDE_CLI_KILL_CLOSE_WAIT_MS);
  };

  const startTimers = (options: ClaudeCliSegmentOptions): SegmentTimers => {
    let stopped = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (stopped || settled) return;
      idleTimer = setTimeout(
        () => terminate(new ClaudeCliError("claude_cli_timeout", "The Claude Code CLI stopped producing output")),
        options.idleTimeoutMs,
      );
    };
    const overallTimer = setTimeout(
      () => terminate(new ClaudeCliError("claude_cli_timeout", "The Claude Code CLI run exceeded its time limit")),
      options.overallTimeoutMs,
    );
    const onAbort = () =>
      terminate(new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    armIdle();
    if (options.signal?.aborted) onAbort();
    return {
      touch: armIdle,
      stop: () => {
        stopped = true;
        clearTimeout(overallTimer);
        if (idleTimer) clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", onAbort);
      },
    };
  };

  async function* runSegment(options: ClaudeCliSegmentOptions): AsyncGenerator<string, ClaudeCliExit> {
    assertNoActiveSegment();
    segmentActive = true;
    const segmentTimers = startTimers(options);
    timers = segmentTimers;
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
      segmentTimers.stop();
      if (timers === segmentTimers) timers = undefined;
      segmentActive = false;
      // A consumer that stops early (or fails mid-stream) must not leave the CLI running,
      // unless it parked the session for a later segment. A park that already faulted
      // (or a kill()) cleared `parking`, and the tree is already dying then.
      if (parking === undefined) {
        if (!killed && !closed && child.pid !== undefined) {
          // Any later segment fails instead of waiting on a queue that will never fill.
          push({
            kind: "error",
            error: new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was closed"),
          });
        }
        await killAndWait();
      }
    }
  }

  function assertNoActiveSegment(): void {
    if (segmentActive) throw new Error("A Claude Code CLI session allows one segment at a time");
  }

  return {
    get pid() {
      return child.pid;
    },
    exited,
    segment(options) {
      // Checked here so a second call throws at once, and again when the body starts,
      // because a generator created earlier may start only now.
      assertNoActiveSegment();
      // The owner has decided to resume: detach the drain now, so a line arriving
      // before the first next() queues for this segment instead of being drained.
      parking = undefined;
      return runSegment(options);
    },
    park(drain, onFault) {
      if (!segmentActive || parking) throw new Error("Only an active, unparked Claude Code CLI segment can park");
      timers?.stop();
      timers = undefined;
      parking = { drain, onFault };
      // Lines already queued stay queued for the next segment; only later lines reach the
      // drain. A paused stdout resumes so the drain sees every heartbeat and an exit can close.
      if (child.stdout?.isPaused()) child.stdout.resume();
      if (closed) queueMicrotask(() => faultParked("exit"));
    },
    async kill() {
      // A kill the caller asked for is not a fault.
      parking = undefined;
      if (!killed && !closed && child.pid !== undefined) {
        push({
          kind: "error",
          error: new ClaudeCliError("claude_cli_cancelled", "The Claude Code CLI run was killed"),
        });
      }
      await killAndWait();
    },
  };
}

/** Resolves when promise settles or after ms, whichever comes first; never rejects. */
async function waitBounded(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([promise.catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}
