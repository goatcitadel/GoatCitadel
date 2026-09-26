import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { GIT_REPOSITORY_ENV_KEYS, buildScrubbedSpawnEnv } from "@goatcitadel/contracts";

const execFileAsync = promisify(execFile);

// Git transport plumbing whose name matches the secret-key scrub but whose value is not a credential:
// an agent socket path that same-user processes can already reach. Git LFS smudge over SSH needs it.
const GIT_TRANSPORT_PASSTHROUGH_KEYS = ["SSH_AUTH_SOCK"] as const;

export interface WorktreeOptions {
  repoRoot: string;
  worktreesRoot: string;
  /** Operator opt-out (`sandbox.spawnEnvPassthrough`) for otherwise-scrubbed keys, e.g. credential-helper config. */
  spawnEnvPassthrough?: readonly string[];
}

/** What git reported about a worktree's uncommitted work. */
export type WorktreeChanges =
  /** The path is not one of this repository's registered worktrees. */
  | { status: "unregistered" }
  /** Git could not report on the worktree, so whether it holds uncommitted work is unknown. */
  | { status: "unreadable"; error: string }
  /** Modified, staged, or untracked and not ignored paths; empty when the worktree is clean. */
  | { status: "read"; changedPaths: string[] };

/** How much of a git failure a change report carries. */
const MAX_GIT_ERROR_CHARACTERS = 500;

export class WorktreeManager {
  public constructor(private readonly options: WorktreeOptions) {}

  /**
   * `git worktree add` checks files out, running repository hooks and filters: they get the ambient
   * environment minus credential-shaped keys, and git never blocks on a terminal prompt. An inherited
   * repository location (e.g. `GIT_DIR` under a hook) never redirects git away from `repoRoot`.
   */
  private gitEnv(): Record<string, string> {
    return buildScrubbedSpawnEnv(process.env, {
      extraEnv: { GIT_TERMINAL_PROMPT: "0" },
      passthroughKeys: [...GIT_TRANSPORT_PASSTHROUGH_KEYS, ...(this.options.spawnEnvPassthrough ?? [])],
      dropKeys: GIT_REPOSITORY_ENV_KEYS,
    });
  }

  public async create(worktreeId: string, baseRef = "HEAD"): Promise<string> {
    const worktreesRoot = path.resolve(this.options.worktreesRoot);
    const worktreePath = path.resolve(worktreesRoot, worktreeId);
    const relativePath = path.relative(worktreesRoot, worktreePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Worktree id resolves outside worktrees root: ${worktreeId}`);
    }
    await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, baseRef], {
      cwd: this.options.repoRoot,
      env: this.gitEnv(),
    });
    return worktreePath;
  }

  public async remove(worktreePath: string): Promise<void> {
    const resolvedPath = path.resolve(worktreePath);
    // Run-scoped orchestration worktrees are disposable and detached. Callers
    // check `listChanges` first and keep a worktree with uncommitted work, so
    // `--force` only has to get past git's own cleanliness check.
    await execFileAsync("git", ["worktree", "remove", "--force", resolvedPath], {
      cwd: this.options.repoRoot,
      env: this.gitEnv(),
    });
  }

  /**
   * Reports the paths with uncommitted work (modified, staged, or untracked and
   * not ignored) in a worktree this repository registered. A failure to read the
   * registrations or the worktree is reported as `unreadable`, never as clean.
   *
   * Agents can write inside a worktree, including its `.git` file, which could
   * point git at a directory whose config runs commands. Git therefore reads the
   * worktree through its registration under the repository's own git dir, never
   * through that file, and with the fsmonitor hook off.
   */
  public async listChanges(worktreePath: string): Promise<WorktreeChanges> {
    const resolvedPath = path.resolve(worktreePath);
    const registration = await this.findRegisteredAdminDir(resolvedPath);
    if (registration.status !== "found") {
      return registration;
    }
    const adminDir = registration.adminDir;
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "--git-dir",
          adminDir,
          "--work-tree",
          resolvedPath,
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain",
          "-z",
          "--untracked-files=all",
        ],
        { cwd: this.options.repoRoot, env: this.gitEnv(), maxBuffer: 16 * 1024 * 1024 },
      );
      return { status: "read", changedPaths: parsePorcelainPaths(stdout) };
    } catch (error) {
      return { status: "unreadable", error: describeGitFailure(error) };
    }
  }

  /** The registration (`<git dir>/worktrees/<id>`) that git recorded for a worktree directory. */
  private async findRegisteredAdminDir(
    resolvedPath: string,
  ): Promise<{ status: "found"; adminDir: string } | Exclude<WorktreeChanges, { status: "read" }>> {
    let adminRoot: string;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
        cwd: this.options.repoRoot,
        // Untranslated messages, so a missing repository is recognized below.
        env: { ...this.gitEnv(), LC_ALL: "C" },
      });
      adminRoot = path.join(path.resolve(this.options.repoRoot, stdout.trim()), "worktrees");
    } catch (error) {
      // Without a repository nothing is registered, so there is no uncommitted
      // work git could report. Any other failure could hide a registration.
      return isNotARepositoryError(error)
        ? { status: "unregistered" }
        : { status: "unreadable", error: describeGitFailure(error) };
    }
    let names: string[];
    try {
      names = await fs.readdir(adminRoot);
    } catch (error) {
      // No `worktrees` directory means git has no worktrees registered.
      return isMissingPathError(error)
        ? { status: "unregistered" }
        : { status: "unreadable", error: describeGitFailure(error) };
    }
    const target = await realpathOrResolve(resolvedPath);
    let unreadableRegistration: unknown;
    for (const name of names) {
      const adminDir = path.join(adminRoot, name);
      try {
        // `gitdir` names the worktree's `.git` file; compare the directories that hold it.
        const recordedGitFile = (await fs.readFile(path.join(adminDir, "gitdir"), "utf8")).trim();
        if (samePath(await realpathOrResolve(path.dirname(path.resolve(adminDir, recordedGitFile))), target)) {
          return { status: "found", adminDir };
        }
      } catch (error) {
        // A registration without a `gitdir` file is not one git can use; any
        // other failure could hide this worktree's registration.
        if (!isMissingPathError(error)) {
          unreadableRegistration = error;
        }
      }
    }
    return unreadableRegistration === undefined
      ? { status: "unregistered" }
      : { status: "unreadable", error: describeGitFailure(unreadableRegistration) };
  }

  public async prune(): Promise<void> {
    // Reclaim stale `.git/worktrees/<id>` administrative entries left behind
    // when a worktree directory was removed outside of `git worktree remove`
    // (e.g. a filesystem-level cleanup fallback).
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: this.options.repoRoot,
      env: this.gitEnv(),
    });
  }
}

/** Paths named by `git status --porcelain -z`; a rename or copy is followed by its source path. */
function parsePorcelainPaths(stdout: string): string[] {
  const records = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) {
      continue;
    }
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) {
      index += 1;
    }
  }
  return paths;
}

function isNotARepositoryError(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  return typeof stderr === "string" && /not a git repository/i.test(stderr);
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A bounded, single-line description of a git or filesystem failure. */
function describeGitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  const detail =
    typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  const singleLine = detail.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_GIT_ERROR_CHARACTERS
    ? `${singleLine.slice(0, MAX_GIT_ERROR_CHARACTERS)}...`
    : singleLine;
}

async function realpathOrResolve(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
