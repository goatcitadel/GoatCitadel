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
   * Lists paths with uncommitted work (modified, staged, or untracked and not
   * ignored) in a worktree this repository registered. Returns undefined when
   * the path is not one of its registered worktrees or git cannot read it.
   *
   * Agents can write inside a worktree, including its `.git` file, which could
   * point git at a directory whose config runs commands. Git therefore reads the
   * worktree through its registration under the repository's own git dir, never
   * through that file, and with the fsmonitor hook off.
   */
  public async listChanges(worktreePath: string): Promise<string[] | undefined> {
    const resolvedPath = path.resolve(worktreePath);
    const adminDir = await this.findRegisteredAdminDir(resolvedPath);
    if (!adminDir) {
      return undefined;
    }
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
      return parsePorcelainPaths(stdout);
    } catch {
      return undefined;
    }
  }

  /** The registration (`<git dir>/worktrees/<id>`) that git recorded for a worktree directory. */
  private async findRegisteredAdminDir(resolvedPath: string): Promise<string | undefined> {
    let adminRoot: string;
    let names: string[];
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
        cwd: this.options.repoRoot,
        env: this.gitEnv(),
      });
      adminRoot = path.join(path.resolve(this.options.repoRoot, stdout.trim()), "worktrees");
      names = await fs.readdir(adminRoot);
    } catch {
      return undefined;
    }
    const target = await realpathOrResolve(resolvedPath);
    for (const name of names) {
      const adminDir = path.join(adminRoot, name);
      try {
        // `gitdir` names the worktree's `.git` file; compare the directories that hold it.
        const recordedGitFile = (await fs.readFile(path.join(adminDir, "gitdir"), "utf8")).trim();
        if (samePath(await realpathOrResolve(path.dirname(path.resolve(adminDir, recordedGitFile))), target)) {
          return adminDir;
        }
      } catch {
        // Not a readable registration; keep looking.
      }
    }
    return undefined;
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
