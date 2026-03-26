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
    const worktreePath = path.join(this.options.worktreesRoot, worktreeId);
    await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, baseRef], {
      cwd: this.options.repoRoot,
    });
    return worktreePath;
  }

  public async remove(worktreePath: string): Promise<void> {
    throw new Error(
      `Refusing to force-remove worktree ${worktreePath}. Remove it manually after confirming no uncommitted work would be lost.`,
    );
  }
}
