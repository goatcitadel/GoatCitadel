import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree-manager.js";

// Real git: listChanges must read a worktree through its registration under
// the repository's own git dir, because agents can rewrite the worktree's
// `.git` file to point at a git dir whose config runs commands.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_TERMINAL_PROMPT: "0",
  };
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
}

function createRepo(): { root: string; repoRoot: string; manager: WorktreeManager } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gc-worktree-changes-")));
  roots.push(root);
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot);
  git(repoRoot, "init", "-q");
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "original\n");
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "ignored/\n");
  git(repoRoot, "add", "-A");
  git(
    repoRoot,
    "-c",
    "user.name=GoatCitadel Test",
    "-c",
    "user.email=worktree-changes@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  );
  const manager = new WorktreeManager({ repoRoot, worktreesRoot: path.join(repoRoot, ".worktrees", "orchestration") });
  return { root, repoRoot, manager };
}

describe("WorktreeManager.listChanges", () => {
  it("reports a fresh worktree as clean and lists modified and untracked, unignored files", async () => {
    const { manager } = createRepo();
    const worktreePath = await manager.create("run-1");

    await expect(manager.listChanges(worktreePath)).resolves.toEqual([]);

    fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n");
    fs.mkdirSync(path.join(worktreePath, "notes"));
    fs.writeFileSync(path.join(worktreePath, "notes", "draft.md"), "draft\n");
    fs.mkdirSync(path.join(worktreePath, "ignored"));
    fs.writeFileSync(path.join(worktreePath, "ignored", "cache.bin"), "cache");

    expect((await manager.listChanges(worktreePath))?.sort()).toEqual(["notes/draft.md", "tracked.txt"]);
  });

  it("returns undefined for a directory the repository did not register", async () => {
    const { repoRoot, manager } = createRepo();
    const stray = path.join(repoRoot, ".worktrees", "orchestration", "stray");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "file.txt"), "stray");

    await expect(manager.listChanges(stray)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "does not run a command configured by a git dir the worktree's .git file was rewritten to",
    async () => {
      const { root, manager } = createRepo();
      const worktreePath = await manager.create("run-2");
      const marker = path.join(root, "fsmonitor-ran");
      const hook = path.join(root, "fsmonitor.sh");
      fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
      git(root, "init", "-q", "hostile");
      git(path.join(root, "hostile"), "config", "core.fsmonitor", hook);
      fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${path.join(root, "hostile", ".git")}\n`);
      fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n");

      expect(await manager.listChanges(worktreePath)).toEqual(["tracked.txt"]);
      expect(fs.existsSync(marker)).toBe(false);

      // Control: plain `git status` inside the worktree follows the rewritten file and runs the hook.
      git(worktreePath, "status", "--porcelain");
      expect(fs.existsSync(marker)).toBe(true);
    },
  );
});
