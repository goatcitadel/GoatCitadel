import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import { CLAUDE_CLI_RESULTS_DIR } from "./claude-code-cli-mcp-stub.js";
import { CLAUDE_CLI_WARM_PARK_DEADLINE_MS } from "./claude-code-cli-warm-registry.js";

/**
 * Age past which an unowned `run-*` dir counts as left behind by a hard-killed Gateway.
 *
 * A live run dir shows activity at least once per step-and-park cycle: mkdtemp and the bridge
 * files touch the run dir itself, and every warm resume stages results into `results/`. Between
 * two such touches a step streams for at most its overall timeout (300 s by default; the longest
 * Chat mode budget is also 300 s) and then parks for at most `CLAUDE_CLI_WARM_PARK_DEADLINE_MS`
 * (600 s), about 15 minutes in all. Two hours is eight times that, so a second Gateway sharing
 * the same temp dir never loses a live run, while a crash's leftovers clear at the next Gateway's
 * first cold CLI step.
 */
export const CLAUDE_CLI_STALE_RUN_DIR_AGE_MS = 2 * 60 * 60 * 1000;

/** Stale age over the park deadline; the tests keep it at 4 or more if either constant moves. */
export const CLAUDE_CLI_STALE_RUN_DIR_PARK_MARGIN = CLAUDE_CLI_STALE_RUN_DIR_AGE_MS / CLAUDE_CLI_WARM_PARK_DEADLINE_MS;

const RUN_DIR_PREFIX = "run-";

const log = logger.child("claude-code-cli-run-dir-sweep");

/** The filesystem reads the sweep needs; both must report links as links (never follow them). */
export interface ClaudeCliRunDirSweepFs {
  listEntries(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  /** `undefined` when the path is missing; `isDirectory` is false for a symlink or junction. */
  statNoFollow(target: string): Promise<{ isDirectory: boolean; mtimeMs: number } | undefined>;
}

export interface ClaudeCliRunDirSweepInput {
  scratchRoot: string;
  /** Removes one run dir; must never throw (the provider's retrying `removeRunDir`). */
  removeDir: (runDir: string) => Promise<void>;
  now?: () => number;
  fs?: ClaudeCliRunDirSweepFs;
  maxAgeMs?: number;
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
};

/**
 * Removes `run-*` dirs directly under `scratchRoot` whose last activity is older than `maxAgeMs`.
 * Links, files, and every other name are left alone, and a missing root is a no-op. Logs counts
 * only; an entry that cannot be read is kept. Never throws.
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
    if (lastActivity === undefined || now - lastActivity < maxAgeMs) {
      kept += 1;
      continue;
    }
    await input.removeDir(runDir);
    removed += 1;
  }
  if (removed > 0) log.info("Claude Code CLI stale run dirs swept", { removed, kept });
  return { removed, kept };
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
