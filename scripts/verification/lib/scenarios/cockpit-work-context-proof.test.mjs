import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkContextProjectFixture } from "./cockpit-work-context-proof.mjs";

test("Work context fixture initializes and commits a portable isolated Git repository", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "goatcitadel-usability-work-context-test-"));
  try {
    await mkdir(path.join(runtimeRoot, "config"));
    await writeFile(path.join(runtimeRoot, "config", "assistant.config.json"), JSON.stringify({
      workspaceDir: "workspace", worktreesDir: "worktrees",
    }));
    const fixture = await createWorkContextProjectFixture({ runtimeRoot }, path);
    const source = path.join(runtimeRoot, "workspace", fixture.workspacePath);
    assert.equal(fixture.paths.length, 82);
    assert.equal(await readFile(path.join(runtimeRoot, "work-context-empty.gitconfig"), "utf8"), "");
    const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
    assert.equal(git(["ls-tree", "--name-only", "HEAD"]).trim().split(/\r?\n/u).length, 82);
    assert.equal(git(["status", "--porcelain"]), "");
    assert.equal(git(["config", "--local", "core.longpaths"]).trim(), "true");
  } finally {
    const target = await realpath(runtimeRoot);
    const relative = path.relative(await realpath(tmpdir()), target);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith("goatcitadel-usability-work-context-test-"));
    await rm(target, { recursive: true, force: true });
  }
});
