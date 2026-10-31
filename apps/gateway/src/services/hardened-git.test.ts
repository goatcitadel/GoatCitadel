import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COMMIT_FETCH_REFUSED_MESSAGE,
  GitCommitFetchRefusedError,
  GitFetchInputError,
  GitHostRefusedError,
  GitTreeLimitError,
  GitTreeRefusedError,
  __fetchGitTreeForTests,
  __gitTreeFetchArgsForTests,
  buildSanitizedGitEnvironment,
  createTreePathTracker,
  fetchGitTree,
  hardenedGitConfigArgs,
  isGitProcessFailure,
  isPortableTreePath,
  parseBoundedGitTree,
  type BoundedGitTreeOptions,
} from "./hardened-git.js";

const LIMITS = { maxFiles: 256, maxTotalBytes: 8 * 1024 * 1024, maxFileBytes: 1024 * 1024 };
const HARDENED_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
];

let scratchRoot: string;
let bareUrl: string;
let firstCommit: string;
let secondCommit: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: buildSanitizedGitEnvironment(), encoding: "utf8", windowsHide: true },
  ).trim();
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** A bare repository on disk with two commits and a tag on the first, standing in for a forge. */
function buildBareRepository(root: string): void {
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  writeFiles(work, { "goatcitadel-plugin.json": "{}", "skills/one/SKILL.md": "one" });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "first");
  firstCommit = git(work, "rev-parse", "HEAD");
  git(work, "tag", "v1");
  writeFiles(work, { "skills/one/SKILL.md": "two", "notes.md": "added" });
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "second");
  secondCommit = git(work, "rev-parse", "HEAD");
  const bare = path.join(root, "bare.git");
  git(root, "clone", "--quiet", "--bare", work, bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  bareUrl = pathToFileURL(bare).href;
}

function listFiles(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else found[path.relative(root, full).replaceAll("\\", "/")] = fs.readFileSync(full, "utf8");
    }
  };
  visit(root);
  return found;
}

function freshDest(): string {
  return path.join(fs.mkdtempSync(path.join(scratchRoot, "dest-")), "tree");
}

beforeAll(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goat-hardened-git-"));
  buildBareRepository(scratchRoot);
});

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("fetchGitTree (through a local bare repository)", () => {
  it("fetches a pinned commit and records it", async () => {
    const destDir = freshDest();

    const result = await __fetchGitTreeForTests({ url: bareUrl, ref: firstCommit, destDir, limits: LIMITS });

    // The pin is the commit that was asked for, not the branch tip.
    expect(result).toEqual({ commit: firstCommit });
    expect(result.commit).not.toBe(secondCommit);
    expect(listFiles(destDir)).toEqual({ "goatcitadel-plugin.json": "{}", "skills/one/SKILL.md": "one" });
    // Nothing but the tree's files: no repository metadata, and the scratch repository is gone.
    expect(fs.existsSync(path.join(destDir, ".git"))).toBe(false);
    expect(fs.existsSync(`${destDir}.git-scratch`)).toBe(false);
  });

  it("accepts an upper-case commit and still pins the lower-case id", async () => {
    const destDir = freshDest();
    const result = await __fetchGitTreeForTests({
      url: bareUrl,
      ref: firstCommit.toUpperCase(),
      destDir,
      limits: LIMITS,
    });
    expect(result.commit).toBe(firstCommit);
  });

  it("reads the default branch when there is no ref", async () => {
    const destDir = freshDest();
    const result = await __fetchGitTreeForTests({ url: bareUrl, destDir, limits: LIMITS });
    expect(result.commit).toBe(secondCommit);
    expect(listFiles(destDir)).toEqual({
      "goatcitadel-plugin.json": "{}",
      "skills/one/SKILL.md": "two",
      "notes.md": "added",
    });
  });

  it("clones a tag with --branch and pins the commit it names", async () => {
    const destDir = freshDest();
    const result = await __fetchGitTreeForTests({ url: bareUrl, ref: "v1", destDir, limits: LIMITS });
    expect(result.commit).toBe(firstCommit);
    expect(listFiles(destDir)["skills/one/SKILL.md"]).toBe("one");
  });

  it("clones a branch with --branch", async () => {
    const destDir = freshDest();
    const result = await __fetchGitTreeForTests({ url: bareUrl, ref: "main", destDir, limits: LIMITS });
    expect(result.commit).toBe(secondCommit);
  });

  it("says so when the host won't serve that exact commit", async () => {
    const destDir = freshDest();
    const failure = await __fetchGitTreeForTests({
      url: bareUrl,
      ref: "1".repeat(40),
      destDir,
      limits: LIMITS,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitCommitFetchRefusedError);
    expect((failure as Error).message).toBe(COMMIT_FETCH_REFUSED_MESSAGE);
    expect(COMMIT_FETCH_REFUSED_MESSAGE).toBe(
      "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag.",
    );
    expect(fs.existsSync(`${destDir}.git-scratch`)).toBe(false);
  });

  it("refuses a tree over the limits", async () => {
    const tooManyFiles = await __fetchGitTreeForTests({
      url: bareUrl,
      destDir: freshDest(),
      limits: { ...LIMITS, maxFiles: 2 },
    }).catch((error: unknown) => error);
    expect(tooManyFiles).toBeInstanceOf(GitTreeLimitError);
    expect((tooManyFiles as Error).message).toBe("Git plugin tree exceeds 2 files.");

    const tooManyBytes = await __fetchGitTreeForTests({
      url: bareUrl,
      destDir: freshDest(),
      limits: { ...LIMITS, maxTotalBytes: 6 },
    }).catch((error: unknown) => error);
    expect(tooManyBytes).toBeInstanceOf(GitTreeLimitError);
    expect((tooManyBytes as Error).message).toBe("Git plugin tree exceeds 6 total bytes.");
  });
});

describe("what counts as a Git failure", () => {
  it("is a failed command, not one of GoatCitadel's own errors", () => {
    const filesystem = Object.assign(new Error("EPERM: operation not permitted, mkdir"), {
      code: "EPERM",
      errno: -4048,
      syscall: "mkdir",
    });
    expect(isGitProcessFailure(filesystem)).toBe(false);
    expect(isGitProcessFailure(new Error("The fetched Git revision is not the exact commit that was asked for."))).toBe(
      false,
    );
    expect(isGitProcessFailure(null)).toBe(false);
    expect(isGitProcessFailure("fatal: nope")).toBe(false);

    expect(isGitProcessFailure(Object.assign(new Error("Command failed"), { code: 128, stderr: "fatal: x" }))).toBe(
      true,
    );
    expect(isGitProcessFailure(Object.assign(new Error("Command failed"), { code: 1 }))).toBe(true);
    expect(isGitProcessFailure(Object.assign(new Error("Command failed"), { stderr: Buffer.from("fatal: x") }))).toBe(
      true,
    );
    expect(isGitProcessFailure(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }))).toBe(true);
    expect(isGitProcessFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
  });

  it("passes a file system failure through fetchGitTree unchanged", async () => {
    const failure = Object.assign(new Error(`EPERM: operation not permitted, mkdir '${scratchRoot}'`), {
      code: "EPERM",
      syscall: "mkdir",
    });
    const mkdir = vi.spyOn(fs.promises, "mkdir").mockRejectedValueOnce(failure);
    try {
      const thrown = await __fetchGitTreeForTests({ url: bareUrl, destDir: freshDest(), limits: LIMITS }).catch(
        (error: unknown) => error,
      );
      expect(mkdir).toHaveBeenCalled();
      expect(thrown).toBe(failure);
      expect(isGitProcessFailure(thrown)).toBe(false);
    } finally {
      mkdir.mockRestore();
    }
  });
});

describe("the scratch repository", () => {
  it("is removed only when this call made it", async () => {
    const destDir = freshDest();
    const scratch = `${destDir}.git-scratch`;
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "keep.txt"), "not ours");

    await expect(__fetchGitTreeForTests({ url: bareUrl, destDir, limits: LIMITS })).rejects.toMatchObject({
      code: "EEXIST",
    });

    expect(fs.readFileSync(path.join(scratch, "keep.txt"), "utf8")).toBe("not ours");
  });
});

describe("fetchGitTree in production", () => {
  it("keeps protocol.allow=never and no file allowance in every command it builds", () => {
    const url = "https://github.com/example/plugin";
    const commit = "a".repeat(40);
    for (const ref of [undefined, "v1.2", commit]) {
      const commands = __gitTreeFetchArgsForTests(url, ref);
      expect(commands.length).toBeGreaterThan(0);
      for (const args of commands) {
        expect(args.slice(0, HARDENED_CONFIG.length)).toEqual(HARDENED_CONFIG);
        expect(args.join(" ")).not.toMatch(/protocol\.file|protocol\.allow=always/u);
        expect(args).not.toContain("checkout");
      }
    }
    expect(hardenedGitConfigArgs()).toEqual(HARDENED_CONFIG);
  });

  it("builds the three ref modes the way the brief says", () => {
    const url = "https://github.com/example/plugin";
    const commit = "b".repeat(40);

    const [defaultClone] = __gitTreeFetchArgsForTests(url, undefined, 100);
    expect(defaultClone).toEqual([
      ...HARDENED_CONFIG,
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--no-checkout",
      "--filter=blob:limit=101",
      "--",
      url,
      "C:/bounded/repo",
    ]);

    const [branchClone] = __gitTreeFetchArgsForTests(url, "release/1.x", 100);
    // Only `--branch <ref>` is added, right before the `--` that ends the options.
    const withBranch = [...(defaultClone ?? [])];
    withBranch.splice(-3, 0, "--branch", "release/1.x");
    expect(branchClone).toEqual(withBranch);

    const [init, remote, fetch] = __gitTreeFetchArgsForTests(url, commit, 100);
    expect(init?.slice(HARDENED_CONFIG.length)).toEqual(["init", "--quiet"]);
    expect(remote?.slice(HARDENED_CONFIG.length)).toEqual(["remote", "add", "--", "origin", url]);
    expect(fetch?.slice(HARDENED_CONFIG.length)).toEqual([
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--no-tags",
      "--filter=blob:limit=101",
      "--",
      "origin",
      commit,
    ]);
  });

  it("refuses an address that isn't a plain https address before it touches the disk", async () => {
    const notHttps = [GitFetchInputError, "Git source must be an https URL."] as const;
    const refusals = [
      ["http://github.com/o/r", ...notHttps],
      ["git@github.com:o/r.git", ...notHttps],
      ["file:///etc/passwd", ...notHttps],
      ["ssh://github.com/o/r", ...notHttps],
      ["https://user:token@github.com/o/r", GitFetchInputError, "Git source must not carry a user name or token."],
      ["-oProxyCommand=whoami", GitFetchInputError, "Git source address must not begin with '-'"],
      ["https://127.0.0.1/o/r.git", GitHostRefusedError, "That address isn't a public host."],
    ] as const;
    for (const [url, errorClass, message] of refusals) {
      const destDir = freshDest();
      const failure = await fetchGitTree({ url, destDir, limits: LIMITS }).catch((error: unknown) => error);
      expect(failure, url).toBeInstanceOf(errorClass);
      expect((failure as Error).message, url).toContain(message);
      expect(fs.existsSync(destDir), url).toBe(false);
    }
  });

  it("refuses a ref that could be read as an option or climbs out", async () => {
    for (const ref of ["--upload-pack=whoami", "-x", "a..b", "has space", "semi;colon", "x".repeat(201)]) {
      const destDir = freshDest();
      const failure = await fetchGitTree({ url: "https://github.com/o/r", ref, destDir, limits: LIMITS }).catch(
        (error: unknown) => error,
      );
      expect(failure, ref).toBeInstanceOf(GitFetchInputError);
      expect((failure as Error).message, ref).toMatch(/Git ref/u);
      expect(fs.existsSync(destDir), ref).toBe(false);
    }
  });

  it("refuses limits that aren't positive whole numbers", async () => {
    const failure = await fetchGitTree({
      url: "https://github.com/o/r",
      destDir: freshDest(),
      limits: { ...LIMITS, maxFiles: 0 },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitFetchInputError);
    expect((failure as Error).message).toBe("Git tree limits must be positive whole numbers.");
  });
});

describe("the tree rules the Git readers share", () => {
  const pluginOptions: BoundedGitTreeOptions = {
    limits: { ...LIMITS, maxEntries: 4 },
    label: "plugin",
    limitError: GitTreeLimitError,
  };
  const oid = "c".repeat(40);

  it("names the tree in its refusals and raises the limit error it was given", () => {
    expect(parseBoundedGitTree(`100644 blob ${oid}\tskills/a/SKILL.md\0`, pluginOptions)).toEqual([
      { objectId: oid, relativePath: "skills/a/SKILL.md", bytes: 0 },
    ]);
    expect(() => parseBoundedGitTree(`120000 blob ${oid}\tlink\0`, pluginOptions)).toThrow(
      "Git plugin tree contains a symlink, submodule, or unsupported object at link.",
    );
    expect(() => parseBoundedGitTree(`100755 blob ${oid}\trun.sh\0`, pluginOptions)).toThrow(GitTreeRefusedError);
    expect(() => parseBoundedGitTree(`100644 blob ${oid}\t.git/config\0`, pluginOptions)).toThrow(
      "Git plugin tree contains a non-portable path: .git/config.",
    );
    const twoFiles = `100644 blob ${oid}\ta.md\u0000100644 blob ${oid}\tb.md\u0000`;
    expect(() =>
      parseBoundedGitTree(twoFiles, { ...pluginOptions, limits: { ...pluginOptions.limits, maxFiles: 1 } }),
    ).toThrow(GitTreeLimitError);
  });

  it("tracks collisions and the entry limit", () => {
    // A refusal ends a whole tree, so each rule gets its own tracker.
    const caseTwin = createTreePathTracker("A tree", 10, GitTreeLimitError);
    caseTwin("docs/Readme.md");
    expect(() => caseTwin("docs/README.md")).toThrow("A tree contains a case-colliding path: docs/README.md.");

    const fileThenFolder = createTreePathTracker("A tree", 10, GitTreeLimitError);
    fileThenFolder("docs/readme");
    expect(() => fileThenFolder("docs/Readme/inner.md")).toThrow(
      "A tree contains a file-directory collision: docs/Readme/inner.md.",
    );

    // Two folders, not two files: the second spelling of a folder is refused, whatever it holds.
    const folderTwin = createTreePathTracker("A tree", 10, GitTreeLimitError);
    folderTwin("Skills/a.md");
    expect(() => folderTwin("skills/b.md")).toThrow(
      new GitTreeRefusedError("A tree contains a case-colliding path: skills/b.md."),
    );
    // The same spelling again is the same folder.
    folderTwin("Skills/c.md");
    const nested = createTreePathTracker("A tree", 10, GitTreeLimitError);
    nested("docs/Guide/one.md");
    expect(() => nested("docs/guide/two.md")).toThrow(GitTreeRefusedError);

    const small = createTreePathTracker("A tree", 3, GitTreeLimitError);
    small("a"); // one entry
    small("b/c.md"); // a file and its folder: three entries
    expect(() => small("d")).toThrow(new GitTreeLimitError("A tree exceeds 3 filesystem entries."));
  });

  it("refuses a Git tree with two folders that differ only in case", () => {
    const twinFolders = `100644 blob ${oid}\tSkills/a.md\u0000100644 blob ${oid}\tskills/b.md\u0000`;
    const failure = (() => {
      try {
        return parseBoundedGitTree(twinFolders, pluginOptions);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(GitTreeRefusedError);
    expect((failure as Error).message).toBe("Git plugin tree contains a case-colliding path: skills/b.md.");
  });

  it("holds a path to what every disk can write the same", () => {
    for (const ok of ["SKILL.md", "skills/a/SKILL.md", "docs/guide.v2.md", "naïve/readme.md"]) {
      expect(isPortableTreePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "../up.md",
      "a/../b.md",
      "/abs.md",
      "C:/drive.md",
      "a\\b.md",
      "a//b.md",
      "./a.md",
      ".git/config",
      "a/.GIT/config",
      "a/CON.txt",
      "a/aux",
      "a/stream.txt:evil",
      "a/trailing.",
      "a/trailing ",
      "tab\there.md",
      "ﬁle.md",
      "e\u0301.md",
    ]) {
      expect(isPortableTreePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
