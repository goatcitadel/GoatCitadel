import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface WorktreeOptions {
  repoRoot: string;
  worktreesRoot: string;
}

export class WorktreeManager {
  public constructor(private readonly options: WorktreeOptions) {}

  public async create(worktreeId: string, baseRef = "HEAD"): Promise<string> {
    const worktreesRoot = path.resolve(this.options.worktreesRoot);
    const worktreePath = path.resolve(worktreesRoot, worktreeId);
    const relativePath = path.relative(worktreesRoot, worktreePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Worktree id resolves outside worktrees root: ${worktreeId}`);
    }
    await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, baseRef], {
      cwd: this.options.repoRoot,
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
    });
  }

  public async prune(): Promise<void> {
    // Reclaim stale `.git/worktrees/<id>` administrative entries left behind
    // when a worktree directory was removed outside of `git worktree remove`
    // (e.g. a filesystem-level cleanup fallback).
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: this.options.repoRoot,
    });
  }
}
