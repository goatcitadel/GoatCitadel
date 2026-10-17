import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeAiderWorkspacePin } from "@goatcitadel/contracts";
import type { CodeModeAiderWorkspaceSeed } from "./code-mode-aider-workspace-pin.js";
import {
  CODE_MODE_AIDER_BASELINE_GIT_DIR,
  CODE_MODE_AIDER_SEED_MAX_FILES,
  CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES,
  collectSeededCodeModeAiderPatch,
  seedCodeModeAiderWorkspace,
} from "./code-mode-aider-workspace-seed.js";

const roots: string[] = [];
const CAN_CREATE_SYMLINKS = probeSymlinkSupport();

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Aider workspace seed", () => {
  it("exposes the baseline and seeding bounds", () => {
    expect(CODE_MODE_AIDER_BASELINE_GIT_DIR).toBe("aider-baseline.git");
    expect(CODE_MODE_AIDER_SEED_MAX_FILES).toBe(20_000);
    expect(CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it("checks the pinned commit out into the work tree through an alternates-backed baseline", async () => {
    const fixture = createFixture({ "src/a.ts": "export const a = 1;\n", "README.md": "# repo\n" });
    const operatorBefore = operatorSnapshot(fixture.repo);

    const seeded = await seedCodeModeAiderWorkspace({
      seed: fixture.seed(),
      runTempRoot: fixture.runTempRoot,
      workTreeRoot: fixture.workTreeRoot,
      pathspec: ".",
      reservedRelPaths: ["aider/request.md"],
    });

    expect(seeded).toEqual({
      baselineGitDir: path.join(fixture.runTempRoot, CODE_MODE_AIDER_BASELINE_GIT_DIR),
      workTreeRoot: fixture.workTreeRoot,
      baseCommit: fixture.head,
      pathspec: ".",
      excludePathspecs: expect.arrayContaining([
        ":(top,exclude,literal)aider/request.md",
        ":(top,exclude,literal)aider.patch",
        ":(top,exclude,literal)aider.git.patch",
        ":(top,exclude,glob)**/.aider*",
      ]),
    });
    expect(fs.readFileSync(path.join(fixture.workTreeRoot, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(fs.readFileSync(path.join(fixture.workTreeRoot, "README.md"), "utf8")).toBe("# repo\n");
    expect(fs.existsSync(path.join(fixture.workTreeRoot, ".git"))).toBe(false);
    const alternates = fs.readFileSync(path.join(seeded.baselineGitDir, "objects", "info", "alternates"), "utf8");
    expect(alternates.trim()).toBe(`${fs.realpathSync(path.join(fixture.repo, ".git")).replaceAll("\\", "/")}/objects`);
    expect(operatorSnapshot(fixture.repo)).toEqual(operatorBefore);
  });

  it("collects the diff against the pinned commit, excluding Aider bookkeeping", async () => {
    const fixture = createFixture({ "src/a.ts": "export const a = 1;\n", "src/gone.ts": "export {};\n" });
    const operatorBefore = operatorSnapshot(fixture.repo);
    const seeded = await seedCodeModeAiderWorkspace({
      seed: fixture.seed(),
      runTempRoot: fixture.runTempRoot,
      workTreeRoot: fixture.workTreeRoot,
      pathspec: ".",
      reservedRelPaths: ["aider/request.md"],
    });
    expect(await collectSeededCodeModeAiderPatch(seeded)).toBeUndefined();

    writeFile(fixture.workTreeRoot, "src/a.ts", "export const a = 2;\n");
    writeFile(fixture.workTreeRoot, "src/new.ts", "export const fresh = true;\n");
    fs.rmSync(path.join(fixture.workTreeRoot, "src", "gone.ts"));
    writeFile(fixture.workTreeRoot, "aider/request.md", "request\n");
    writeFile(fixture.workTreeRoot, "aider.patch", "not a patch\n");
    writeFile(fixture.workTreeRoot, "aider.git.patch", "not a patch\n");
    writeFile(fixture.workTreeRoot, ".aider.chat.history.md", "history\n");
    writeFile(fixture.workTreeRoot, "src/.aider.tags.cache.v3/cache.db", "cache\n");

    const patch = await collectSeededCodeModeAiderPatch(seeded);

    expect(patch).toMatchObject({ kind: "git_patch", fileCount: 3, baseRef: fixture.head });
    expect(patch?.content).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(patch?.content).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(patch?.content).toContain("diff --git a/src/gone.ts b/src/gone.ts");
    expect(patch?.content).not.toMatch(/request\.md|aider\.patch|aider\.git\.patch|\.aider/u);
    expect(applyCheck(fixture.repo, patch?.content ?? "")).toBe(true);
    expect(operatorSnapshot(fixture.repo)).toEqual(operatorBefore);
  });

  it("restricts seeding and the diff to the repository-root pathspec", async () => {
    const fixture = createFixture({ "pkg/src/a.ts": "export const a = 1;\n", "other/b.ts": "export const b = 1;\n" });
    const seeded = await seedCodeModeAiderWorkspace({
      seed: fixture.seed(),
      runTempRoot: fixture.runTempRoot,
      workTreeRoot: fixture.workTreeRoot,
      pathspec: "pkg",
      reservedRelPaths: ["pkg/aider/request.md"],
    });
    expect(fs.existsSync(path.join(fixture.workTreeRoot, "pkg", "src", "a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.workTreeRoot, "other"))).toBe(false);

    writeFile(fixture.workTreeRoot, "pkg/src/a.ts", "export const a = 2;\n");
    writeFile(fixture.workTreeRoot, "pkg/aider.patch", "not a patch\n");
    writeFile(fixture.workTreeRoot, "pkg/aider/request.md", "request\n");
    writeFile(fixture.workTreeRoot, "outside.ts", "export const outside = true;\n");

    const patch = await collectSeededCodeModeAiderPatch(seeded);

    expect(patch).toMatchObject({ kind: "git_patch", fileCount: 1, baseRef: fixture.head });
    expect(patch?.content).toContain("diff --git a/pkg/src/a.ts b/pkg/src/a.ts");
    expect(patch?.content).not.toContain("outside.ts");
    expect(applyCheck(fixture.repo, patch?.content ?? "")).toBe(true);
  });

  it("refuses a baseline inside the work tree", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    await expect(
      seedCodeModeAiderWorkspace({
        seed: fixture.seed(),
        runTempRoot: fixture.workTreeRoot,
        workTreeRoot: fixture.workTreeRoot,
        pathspec: ".",
        reservedRelPaths: [],
      }),
    ).rejects.toThrow(/baseline.*work tree/iu);
    expect(fs.existsSync(path.join(fixture.workTreeRoot, CODE_MODE_AIDER_BASELINE_GIT_DIR))).toBe(false);
  });

  it("refuses an unavailable or malformed pinned commit", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const operatorBefore = operatorSnapshot(fixture.repo);
    await expect(
      seedCodeModeAiderWorkspace({
        seed: fixture.seed({ baseCommit: "f".repeat(40) }),
        runTempRoot: fixture.runTempRoot,
        workTreeRoot: fixture.workTreeRoot,
        pathspec: ".",
        reservedRelPaths: [],
      }),
    ).rejects.toThrow(/pinned commit.*not available/iu);
    await expect(
      seedCodeModeAiderWorkspace({
        seed: fixture.seed({ baseCommit: "--output=evil" }),
        runTempRoot: path.join(fixture.root, "run-temp-2"),
        workTreeRoot: path.join(fixture.root, "run-temp-2", "aider-live"),
        pathspec: ".",
        reservedRelPaths: [],
      }),
    ).rejects.toThrow(/pinned commit/iu);
    expect(fs.readdirSync(fixture.workTreeRoot)).toEqual([]);
    expect(operatorSnapshot(fixture.repo)).toEqual(operatorBefore);
  });

  it("refuses to seed over a tracked reserved path", async () => {
    const fixture = createFixture({ "aider/request.md": "tracked\n", "a.ts": "export {};\n" });
    await expect(
      seedCodeModeAiderWorkspace({
        seed: fixture.seed(),
        runTempRoot: fixture.runTempRoot,
        workTreeRoot: fixture.workTreeRoot,
        pathspec: ".",
        reservedRelPaths: ["aider/request.md"],
      }),
    ).rejects.toThrow(/reserved path aider\/request\.md/iu);
    expect(fs.readdirSync(fixture.workTreeRoot)).toEqual([]);
  });

  it("refuses to seed a pinned commit with more tracked files than the bound", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const blob = git(fixture.repo, ["rev-parse", "HEAD:a.ts"]).trim();
    const entries = Array.from(
      { length: CODE_MODE_AIDER_SEED_MAX_FILES + 1 },
      (_, index) => `100644 blob ${blob}\tf${index}.ts`,
    ).join("\n");
    const tree = git(fixture.repo, ["mktree"], `${entries}\n`).trim();
    const commit = git(fixture.repo, ["commit-tree", tree, "-m", "huge"]).trim();

    await expect(
      seedCodeModeAiderWorkspace({
        seed: fixture.seed({ baseCommit: commit }),
        runTempRoot: fixture.runTempRoot,
        workTreeRoot: fixture.workTreeRoot,
        pathspec: ".",
        reservedRelPaths: [],
      }),
    ).rejects.toThrow(/more than 20000 tracked files/iu);
    expect(fs.readdirSync(fixture.workTreeRoot)).toEqual([]);
  });

  it("refuses a seeded patch over the byte bound", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const seeded = await seedCodeModeAiderWorkspace({
      seed: fixture.seed(),
      runTempRoot: fixture.runTempRoot,
      workTreeRoot: fixture.workTreeRoot,
      pathspec: ".",
      reservedRelPaths: [],
    });
    const line = `${"x".repeat(1023)}\n`;
    writeFile(
      fixture.workTreeRoot,
      "big.txt",
      line.repeat(Math.ceil(CODE_MODE_AIDER_SEEDED_PATCH_MAX_BYTES / 1024) + 8),
    );

    await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/exceeds/iu);
  });

  it("stages changes an Aider-written .gitignore would hide", async () => {
    const fixture = createFixture({ "src/a.ts": "export const a = 1;\n" });
    const seeded = await seedDefault(fixture);
    writeFile(fixture.workTreeRoot, ".gitignore", "src/\n");
    writeFile(fixture.workTreeRoot, "src/a.ts", "export const a = 2;\n");
    writeFile(fixture.workTreeRoot, "src/new.ts", "export const fresh = true;\n");

    const patch = await collectSeededCodeModeAiderPatch(seeded);

    expect(patch?.content).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(patch?.content).toContain("diff --git a/src/new.ts b/src/new.ts");
  });

  it("refuses a nested .git directory in the work tree", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const seeded = await seedDefault(fixture);
    writeFile(fixture.workTreeRoot, "vendor/x/.git/HEAD", "ref: refs/heads/main\n");
    writeFile(fixture.workTreeRoot, "vendor/x/y.ts", "export {};\n");

    await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/nested Git entry at vendor\/x\/\.git/u);
  });

  it("refuses a gitfile pointing at a host repository", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const seeded = await seedDefault(fixture);
    writeFile(fixture.workTreeRoot, "sub/.git", `gitdir: ${path.join(fixture.repo, ".git")}\n`);

    await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/nested Git entry at sub\/\.git/u);
  });

  it("refuses a gitlink change", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const blob = git(fixture.repo, ["rev-parse", "HEAD:a.ts"]).trim();
    const tree = git(
      fixture.repo,
      ["mktree"],
      `100644 blob ${blob}\ta.ts\n160000 commit ${fixture.head}\tsub\n`,
    ).trim();
    const commit = git(fixture.repo, ["commit-tree", tree, "-m", "with gitlink"]).trim();
    const seeded = await seedCodeModeAiderWorkspace({
      seed: fixture.seed({ baseCommit: commit }),
      runTempRoot: fixture.runTempRoot,
      workTreeRoot: fixture.workTreeRoot,
      pathspec: ".",
      reservedRelPaths: [],
    });
    fs.rmSync(path.join(fixture.workTreeRoot, "sub"), { recursive: true, force: true });

    await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/gitlink change at sub/u);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    "refuses a symbolic link addition (skipped where this platform cannot create symlinks)",
    async () => {
      const fixture = createFixture({ "a.ts": "export {};\n" });
      const seeded = await seedDefault(fixture);
      fs.symlinkSync("a.ts", path.join(fixture.workTreeRoot, "link.ts"), "file");

      await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/symbolic link at link\.ts/u);
    },
  );

  it("refuses a patch that is not valid UTF-8", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    const seeded = await seedDefault(fixture);
    fs.writeFileSync(path.join(fixture.workTreeRoot, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

    await expect(collectSeededCodeModeAiderPatch(seeded)).rejects.toThrow(/not valid UTF-8/u);
  });

  it("refuses SHA-256 pinned commits", async () => {
    const fixture = createFixture({ "a.ts": "export {};\n" });
    await expect(seedDefault(fixture, { baseCommit: "a".repeat(64) })).rejects.toThrow(
      "SHA-256 repositories are not supported for Aider seeding.",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "compares reserved paths case-insensitively on Windows (skipped off win32)",
    async () => {
      const fixture = createFixture({ "Aider/Request.md": "tracked\n", "a.ts": "export {};\n" });
      await expect(seedDefault(fixture)).rejects.toThrow(/reserved path aider\/request\.md/iu);
    },
  );
});

function probeSymlinkSupport(): boolean {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goat-aider-seed-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probeRoot, "target"), "x");
    fs.symlinkSync("target", path.join(probeRoot, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

function seedDefault(fixture: ReturnType<typeof createFixture>, overrides: { baseCommit?: string } = {}) {
  return seedCodeModeAiderWorkspace({
    seed: fixture.seed(overrides),
    runTempRoot: fixture.runTempRoot,
    workTreeRoot: fixture.workTreeRoot,
    pathspec: ".",
    reservedRelPaths: ["aider/request.md"],
  });
}

function createFixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-aider-seed-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Seed Test"]);
  git(repo, ["config", "user.email", "seed@example.invalid"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(repo, relPath, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "seed"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const runTempRoot = path.join(root, "run-temp");
  const workTreeRoot = path.join(runTempRoot, "aider-live");
  fs.mkdirSync(workTreeRoot, { recursive: true });
  return {
    root,
    repo,
    head,
    runTempRoot,
    workTreeRoot,
    seed(overrides: { baseCommit?: string } = {}): CodeModeAiderWorkspaceSeed {
      const baseCommit = overrides.baseCommit ?? head;
      const pin: CodeModeAiderWorkspacePin = {
        version: 1,
        sessionId: "session-a",
        worktreeIdentityHash: "a".repeat(64),
        worktreeHead: baseCommit,
        worktreeStateHash: "b".repeat(64),
        capturedAt: "2026-10-16T12:00:00.000Z",
      };
      return { worktreePath: fs.realpathSync(repo), baseCommit, pin };
    },
  };
}

function operatorSnapshot(repo: string) {
  return {
    head: git(repo, ["rev-parse", "HEAD"]),
    status: git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    objects: git(repo, ["count-objects", "-v"]),
  };
}

function applyCheck(repo: string, patch: string): boolean {
  const patchFile = path.join(path.dirname(repo), `check-${Date.now()}.patch`);
  fs.writeFileSync(patchFile, patch);
  try {
    git(repo, ["apply", "--check", patchFile]);
    return true;
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

function writeFile(root: string, relPath: string, content: string): void {
  const target = path.join(root, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}
