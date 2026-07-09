import type { ChildProcess } from "node:child_process";
import { terminateProcessTree, type ProcessTreeKillLogger } from "../process-tree-killer.js";

/**
 * Default diagnostic sink for hard-kill failures. The policy-engine package has
 * no shared logger, so route best-effort warnings through Node's built-in
 * process warning channel rather than introducing a console dependency.
 */
const processKillLogger: ProcessTreeKillLogger = {
  warn(message, context) {
    process.emitWarning(context ? `${message} ${JSON.stringify(context)}` : message, {
      type: "ShellProcessKillWarning",
    });
  },
};

interface BackgroundProcessEntry {
  pid: number;
  command: string;
  cwd?: string;
  child: ChildProcess;
  startedAt: number;
}

// Module-level registry of detached background shell processes so the session/
// turn lifecycle can terminate orphaned jobs that would otherwise run forever.
const backgroundProcesses = new Map<number, BackgroundProcessEntry>();

export function terminateShellProcessTree(
  child: ChildProcess,
  label: string,
  posixProcessGroup: boolean,
  context?: Record<string, unknown>,
): void {
  terminateProcessTree({
    child,
    label,
    logger: processKillLogger,
    posixProcessGroup,
    context,
  });
}

export function registerBackgroundProcess(child: ChildProcess, command: string, cwd?: string): void {
  const pid = child.pid;
  if (typeof pid !== "number") {
    return;
  }
  backgroundProcesses.set(pid, { pid, command, cwd, child, startedAt: Date.now() });
  // Drop the registry entry once the job exits on its own so the map does
  // not accumulate stale, already-dead pids.
  child.once("exit", () => {
    const entry = backgroundProcesses.get(pid);
    if (entry && entry.child === child) {
      backgroundProcesses.delete(pid);
    }
  });
}

/**
 * Terminates a single registered background shell process and its descendants.
 * Returns true when a matching live registry entry was found. Safe to call with
 * an unknown pid (no-op, returns false).
 */
export function killBackgroundProcess(pid: number): boolean {
  const entry = backgroundProcesses.get(pid);
  if (!entry) {
    return false;
  }
  backgroundProcesses.delete(pid);
  terminateShellProcessTree(entry.child, "shell.exec_background kill", process.platform !== "win32", {
    pid,
    command: entry.command,
    cwd: entry.cwd,
  });
  return true;
}

/**
 * Terminates every registered background shell process. Intended to be called
 * from the session/turn lifecycle so leaked detached jobs do not survive past
 * the agent turn that started them. Returns the number of pids terminated.
 */
export function killAllBackgroundProcesses(): number {
  const pids = [...backgroundProcesses.keys()];
  let killed = 0;
  for (const pid of pids) {
    if (killBackgroundProcess(pid)) {
      killed += 1;
    }
  }
  return killed;
}
