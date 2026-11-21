import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** A fresh delegation can proceed without a Git scope when Git confirms there is no repository. */
export function readRealGitTopLevel(cwd: string, allowNonGit: boolean): string | undefined {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return realpathSync(topLevel.trim());
  } catch (error) {
    const gitError = error as { status?: number; stderr?: unknown } | undefined;
    if (
      allowNonGit &&
      gitError?.status === 128 &&
      typeof gitError.stderr === "string" &&
      gitError.stderr.trim() === "fatal: not a git repository (or any of the parent directories): .git"
    ) {
      return undefined;
    }
    throw error;
  }
}
