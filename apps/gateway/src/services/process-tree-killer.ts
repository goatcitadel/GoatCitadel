import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessTreeKillLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface TerminateProcessTreeOptions {
  child: ChildProcess;
  label: string;
  context?: Record<string, unknown>;
  logger?: ProcessTreeKillLogger;
  platform?: NodeJS.Platform;
  graceMs?: number;
  posixProcessGroup?: boolean;
}

const DEFAULT_GRACE_MS = 3000;

export function terminateProcessTree(options: TerminateProcessTreeOptions): void {
  const pid = options.child.pid;
  if (typeof pid !== "number" || options.child.exitCode !== null || options.child.signalCode !== null) {
    return;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    terminateWindowsChildTree(options.child, options, pid);
    return;
  }

  sendPosixSignal(options.child, options, pid, "SIGTERM");
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
  let killTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    killTimer = undefined;
    if (options.child.exitCode === null && options.child.signalCode === null) {
      sendPosixSignal(options.child, options, pid, "SIGKILL");
    }
  }, graceMs);
  killTimer.unref?.();

  options.child.once("exit", () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  });
}

function sendPosixSignal(
  child: ChildProcess,
  options: TerminateProcessTreeOptions,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    if (options.posixProcessGroup) {
      process.kill(-pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    options.logger?.warn(`${options.label} signal failed`, {
      ...options.context,
      pid,
      signal,
      err: (error as Error).message,
    });
    if (options.posixProcessGroup) {
      try {
        child.kill(signal);
      } catch {
        // Best effort; the child may already be gone.
      }
    }
  }
}

function terminateWindowsChildTree(child: ChildProcess, options: TerminateProcessTreeOptions, pid: number): void {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let fallbackUsed = false;
    const fallbackToChildKill = (message: string, context: Record<string, unknown>) => {
      if (fallbackUsed) {
        return;
      }
      fallbackUsed = true;
      options.logger?.warn(message, context);
      killChildBestEffort(child);
    };
    killer.on("error", (error) => {
      fallbackToChildKill(`${options.label} taskkill failed; falling back to child.kill`, {
        ...options.context,
        pid,
        err: error.message,
      });
    });
    killer.on("close", (code, signal) => {
      if ((typeof code === "number" && code !== 0) || signal) {
        fallbackToChildKill(
          `${options.label} taskkill exited before terminating process tree; falling back to child.kill`,
          {
            ...options.context,
            pid,
            exitCode: code,
            signal,
          },
        );
      }
    });
  } catch (error) {
    options.logger?.warn(`${options.label} taskkill could not be spawned; falling back to child.kill`, {
      ...options.context,
      pid,
      err: (error as Error).message,
    });
    killChildBestEffort(child);
  }
}

function killChildBestEffort(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Best effort; the child may already be gone.
  }
}
