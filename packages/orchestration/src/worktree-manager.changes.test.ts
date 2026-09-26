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

    await expect(manager.listChanges(worktreePath)).resolves.toEqual({ status: "read", changedPaths: [] });

    fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n");
    fs.mkdirSync(path.join(worktreePath, "notes"));
    fs.writeFileSync(path.join(worktreePath, "notes", "draft.md"), "draft\n");
    fs.mkdirSync(path.join(worktreePath, "ignored"));
    fs.writeFileSync(path.join(worktreePath, "ignored", "cache.bin"), "cache");

    const changes = await manager.listChanges(worktreePath);
    expect(changes.status === "read" ? changes.changedPaths.sort() : changes).toEqual([
      "notes/draft.md",
      "tracked.txt",
    ]);
  });

  it("reports a directory the repository did not register as unregistered", async () => {
    const { repoRoot, manager } = createRepo();
    const stray = path.join(repoRoot, ".worktrees", "orchestration", "stray");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "file.txt"), "stray");

    await expect(manager.listChanges(stray)).resolves.toEqual({ status: "unregistered" });
  });

  it("reports a registered worktree git cannot read as unreadable, not clean", async () => {
    const { repoRoot, manager } = createRepo();
    const worktreePath = await manager.create("run-3");
    fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n");
    // Break the registration's HEAD so `git status` fails for this worktree.
    fs.writeFileSync(path.join(repoRoot, ".git", "worktrees", "run-3", "HEAD"), "not a ref\n");

    const changes = await manager.listChanges(worktreePath);

    expect(changes).toMatchObject({ status: "unreadable", error: expect.any(String) });
    expect(changes.status === "unreadable" ? changes.error.length : 0).toBeGreaterThan(0);
  });

  it("reports worktrees as unreadable when git cannot read the repository's registrations", async () => {
    const { repoRoot, manager } = createRepo();
    // The registrations directory cannot be listed.
    fs.writeFileSync(path.join(repoRoot, ".git", "worktrees"), "not a directory\n");

    await expect(
      manager.listChanges(path.join(repoRoot, ".worktrees", "orchestration", "run-1")),
    ).resolves.toMatchObject({ status: "unreadable", error: expect.any(String) });
  });

  it("reports a path as unregistered when the root is not a git repository at all", async () => {
    const { root } = createRepo();
    const notARepository = path.join(root, "plain");
    const orphan = path.join(notARepository, ".worktrees", "orchestration", "run-1");
    fs.mkdirSync(orphan, { recursive: true });
    const manager = new WorktreeManager({
      repoRoot: notARepository,
      worktreesRoot: path.join(notARepository, ".worktrees", "orchestration"),
    });

    await expect(manager.listChanges(orphan)).resolves.toEqual({ status: "unregistered" });
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

      expect(await manager.listChanges(worktreePath)).toEqual({ status: "read", changedPaths: ["tracked.txt"] });
      expect(fs.existsSync(marker)).toBe(false);

      // Control: plain `git status` inside the worktree follows the rewritten file and runs the hook.
      git(worktreePath, "status", "--porcelain");
      expect(fs.existsSync(marker)).toBe(true);
    },
  );
});
