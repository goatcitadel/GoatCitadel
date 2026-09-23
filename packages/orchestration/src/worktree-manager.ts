import { execFile } from "node:child_process";
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
    // Run-scoped orchestration worktrees are disposable, detached, and almost
    // always dirty (agents write into them), so a plain `git worktree remove`
    // fails. `--force` is safe here and lets the git-side removal succeed.
    await execFileAsync("git", ["worktree", "remove", "--force", resolvedPath], {
      cwd: this.options.repoRoot,
      env: this.gitEnv(),
    });
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
