import { constants } from "node:fs";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import { CLAUDE_CLI_RESULTS_DIR } from "./claude-code-cli-mcp-stub.js";
import { CLAUDE_CLI_WARM_PARK_DEADLINE_MS } from "./claude-code-cli-warm-registry.js";

/**
 * Minimum inactivity before a dead owner's run directory is eligible. Age alone is
 * never ownership proof: long calls and forward wall-clock changes can age a live run.
 */
export const CLAUDE_CLI_STALE_RUN_DIR_AGE_MS = 2 * 60 * 60 * 1000;

/** Stale age over the park deadline; the tests keep it at 4 or more if either constant moves. */
export const CLAUDE_CLI_STALE_RUN_DIR_PARK_MARGIN = CLAUDE_CLI_STALE_RUN_DIR_AGE_MS / CLAUDE_CLI_WARM_PARK_DEADLINE_MS;

const RUN_DIR_PREFIX = "run-";
export const CLAUDE_CLI_OWNER_FILE = ".owner.json";
const OWNER_MAX_BYTES = 512;

export type ClaudeCliOwnerProbe = (pid: number) => "alive" | "dead" | "unknown";

/** Registered before prompt/bridge files; retained while the Gateway owns a warm parked run. */
export async function registerClaudeCliRunDirOwner(runDir: string, pid = process.pid): Promise<void> {
  if (!isOwnerPid(pid)) throw new Error("Invalid Claude CLI run directory owner pid");
  await writeFile(path.join(runDir, CLAUDE_CLI_OWNER_FILE), JSON.stringify({ version: 1, pid }), {
    flag: "wx",
    mode: 0o600,
  });
}

const log = logger.child("claude-code-cli-run-dir-sweep");

/** Filesystem reads must not treat links as directories or valid owner records. */
export interface ClaudeCliRunDirSweepFs {
  listEntries(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  /** `undefined` when the path is missing; `isDirectory` is false for a symlink or junction. */
  statNoFollow(target: string): Promise<{ isDirectory: boolean; mtimeMs: number } | undefined>;
  readOwnerPid(runDir: string): Promise<number | undefined>;
}

export interface ClaudeCliRunDirSweepInput {
  scratchRoot: string;
  /** Removes one run dir; must never throw (the provider's retrying `removeRunDir`). */
  removeDir: (runDir: string) => Promise<void>;
  now?: () => number;
  fs?: ClaudeCliRunDirSweepFs;
  maxAgeMs?: number;
  probeOwner?: ClaudeCliOwnerProbe;
}

export interface ClaudeCliRunDirSweepResult {
  removed: number;
  kept: number;
}

export const hostClaudeCliRunDirSweepFs: ClaudeCliRunDirSweepFs = {
  async listEntries(dir) {
    // Dirent types come from lstat semantics: a symlink or junction is never `isDirectory()`.
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  },
  async statNoFollow(target) {
    try {
      const stats = await lstat(target);
      return { isDirectory: stats.isDirectory(), mtimeMs: stats.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  readOwnerPid: readRunDirOwnerPid,
};

/**
 * Removes old `run-*` directories only when their declared Gateway owner is definitely
 * dead. Missing/invalid/unreadable markers, PID reuse, and unknown liveness are kept.
 * Unmarked legacy directories require explicit offline cleanup; never migrate or delete
 * them automatically. Only the exact declared PID is probed; no process enumeration.
 */
export async function sweepStaleClaudeCliRunDirs(
  input: ClaudeCliRunDirSweepInput,
): Promise<ClaudeCliRunDirSweepResult> {
  const fs = input.fs ?? hostClaudeCliRunDirSweepFs;
  const now = (input.now ?? Date.now)();
  const maxAgeMs = input.maxAgeMs ?? CLAUDE_CLI_STALE_RUN_DIR_AGE_MS;
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    entries = await fs.listEntries(input.scratchRoot);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") log.warn("Claude Code CLI run dir sweep could not list", { code });
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory || !isRunDirName(entry.name)) continue;
    const runDir = path.join(input.scratchRoot, entry.name);
    const lastActivity = await readLastActivity(fs, runDir);
    if (lastActivity === undefined || now - lastActivity < maxAgeMs ||
        !(await hasDeadOwner(fs, runDir, input.probeOwner ?? probeRunDirOwner))) {
      kept += 1;
      continue;
    }
    await input.removeDir(runDir);
    removed += 1;
  }
  if (removed > 0) log.info("Claude Code CLI stale run dirs swept", { removed, kept });
  return { removed, kept };
}

function isOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

/** Signal zero checks existence only. EPERM and every error except ESRCH remain ambiguous. */
function probeRunDirOwner(pid: number): ReturnType<ClaudeCliOwnerProbe> {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

async function hasDeadOwner(fs: ClaudeCliRunDirSweepFs, runDir: string, probe: ClaudeCliOwnerProbe): Promise<boolean> {
  try {
    const pid = await fs.readOwnerPid(runDir);
    return isOwnerPid(pid) && probe(pid) === "dead";
  } catch {
    return false;
  }
}

/** Bounded ordinary-file read; failed ownership reads never authorize cleanup. */
async function readRunDirOwnerPid(runDir: string): Promise<number | undefined> {
  const filename = path.join(runDir, CLAUDE_CLI_OWNER_FILE);
  const expected = await lstat(filename);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size > OWNER_MAX_BYTES) return undefined;
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.nlink !== 1 || held.size > OWNER_MAX_BYTES ||
        held.dev !== expected.dev || held.ino !== expected.ino) return undefined;
    const bytes = Buffer.alloc(OWNER_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > OWNER_MAX_BYTES) return undefined;
    const owner: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return undefined;
    const record = owner as Record<string, unknown>;
    return record.version === 1 && isOwnerPid(record.pid) ? record.pid : undefined;
  } finally {
    await handle.close();
  }
}

function isRunDirName(name: string): boolean {
  return name.startsWith(RUN_DIR_PREFIX) && name.length > RUN_DIR_PREFIX.length && !/[\\/]/.test(name);
}

/** Newest mtime of the run dir and its `results/` folder; undefined (keep) when unreadable or no longer a real dir. */
async function readLastActivity(fs: ClaudeCliRunDirSweepFs, runDir: string): Promise<number | undefined> {
  try {
    const dir = await fs.statNoFollow(runDir);
    if (!dir?.isDirectory) return undefined;
    const results = await fs.statNoFollow(path.join(runDir, CLAUDE_CLI_RESULTS_DIR));
    return results?.isDirectory ? Math.max(dir.mtimeMs, results.mtimeMs) : dir.mtimeMs;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code.slice(0, 32) : "unknown";
}
