import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS, type DeploymentProfile, type PluginSource } from "@goatcitadel/contracts";

vi.mock("./hardened-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hardened-git.js")>()),
  fetchGitTree: vi.fn(),
}));

import {
  GitCommitFetchRefusedError,
  GitFetchFailedError,
  GitFetchInputError,
  GitHostLookupError,
  GitHostRefusedError,
  GitTreeLimitError,
  GitTreeRefusedError,
  HostLookupError,
  fetchGitTree,
} from "./hardened-git.js";
import { PluginSnapshotStore } from "./plugin-snapshot-store.js";
import { PluginSourceError, fetchPluginSource } from "./plugin-source-service.js";

const fetchGitTreeMock = vi.mocked(fetchGitTree);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PLUGIN_FILES = {
  "goatcitadel-plugin.json": '{"pluginId":"demo-plugin"}',
  "skills/one/SKILL.md": "# One",
};

let scratchRoot: string;
let counter = 0;

function inputs(deploymentProfile: DeploymentProfile = "trusted_local") {
  const store = new PluginSnapshotStore(path.join(scratchRoot, "snapshots"));
  return {
    // Not an input: the tests read it to look inside what was stored.
    store,
    importSnapshot: (dir: string) => store.importDirectory(dir),
    builtInRoot: path.join(scratchRoot, "shipped"),
    deploymentProfile,
    tempRoot: path.join(scratchRoot, "tmp"),
  };
}

function makeFolder(files: Record<string, string | Buffer>, parent = scratchRoot, name?: string): string {
  counter += 1;
  const root = path.join(parent, name ?? `folder-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/** Every file and folder name at any depth below `root`. */
function namesBelow(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => [entry.name, ...(entry.isDirectory() ? namesBelow(path.join(root, entry.name)) : [])]);
}

function tempLeftovers(): string[] {
  const tempRoot = path.join(scratchRoot, "tmp");
  return fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : [];
}

function writeTree(destDir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(destDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

async function failureOf(work: Promise<unknown>): Promise<PluginSourceError> {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PluginSourceError);
  return error as PluginSourceError;
}

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goat-plugin-source-"));
  fetchGitTreeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("fetchPluginSource: Git", () => {
  it("fetches a pinned commit into a snapshot and records the pin", async () => {
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      return { commit: COMMIT };
    });
    const sourceInputs = inputs();

    const result = await fetchPluginSource(
      { kind: "git", url: "https://github.com/Octo/Plugin.git", ref: COMMIT },
      sourceInputs,
    );

    expect(result.pin).toEqual({ kind: "commit", commit: COMMIT });
    expect(result.trust).toBe("unverified");
    expect(result.sourceDisplay).toBe("github.com/Octo/Plugin");
    expect(fs.readFileSync(path.join(result.snapshot.dir, "skills", "one", "SKILL.md"), "utf8")).toBe("# One");
    expect(sourceInputs.store.resolve(result.snapshot.treeSha256)).toBe(result.snapshot.dir);
    expect(fetchGitTreeMock).toHaveBeenCalledTimes(1);
    const call = fetchGitTreeMock.mock.calls[0]![0];
    expect(call).toMatchObject({
      url: "https://github.com/Octo/Plugin.git",
      ref: COMMIT,
      limits: {
        maxFiles: PLUGIN_LIMITS.maxFiles,
        maxTotalBytes: PLUGIN_LIMITS.maxTotalBytes,
        maxFileBytes: PLUGIN_LIMITS.maxFileBytes,
      },
    });
    // The tree is written under the temp root, which is left empty afterwards.
    expect(path.resolve(call.destDir).startsWith(path.resolve(sourceInputs.tempRoot) + path.sep)).toBe(true);
    expect(tempLeftovers()).toEqual([]);
  });

  it("passes a branch, a tag or no ref straight through", async () => {
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      return { commit: COMMIT };
    });
    await fetchPluginSource({ kind: "git", url: "https://gitlab.com/group/sub/repo" }, inputs());
    await fetchPluginSource({ kind: "git", url: "https://codeberg.org/o/r", ref: "v1.2.0" }, inputs());

    expect(fetchGitTreeMock.mock.calls.map(([input]) => input.ref)).toEqual([undefined, "v1.2.0"]);
  });

  it("names a repository without its .git or any credentials", async () => {
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      return { commit: COMMIT };
    });
    const results = await Promise.all([
      fetchPluginSource({ kind: "git", url: "https://bitbucket.org/team/tool.git" }, inputs()),
      fetchPluginSource({ kind: "git", url: "https://GitLab.com/group/sub/repo/" }, inputs()),
    ]);
    expect(results.map((result) => result.sourceDisplay)).toEqual([
      "bitbucket.org/team/tool",
      "gitlab.com/group/sub/repo",
    ]);
  });

  it("refuses a host that isn't a trusted forge", async () => {
    const sourceInputs = inputs();
    for (const url of [
      "https://evil.example/o/r",
      "https://github.com.evil.example/o/r",
      "https://evil.example/github.com/o/r",
      "https://gitlab.com:8443/o/r",
      "https://127.0.0.1/o/r",
      "https://localhost/o/r",
    ]) {
      const failure = await failureOf(fetchPluginSource({ kind: "git", url }, sourceInputs));
      expect(failure, url).toMatchObject({
        statusCode: 400,
        reason: "UNTRUSTED_GIT_HOST",
        message: "GoatCitadel installs plugins only from GitHub, GitLab, Bitbucket or Codeberg.",
      });
    }
    expect(fetchGitTreeMock).not.toHaveBeenCalled();
    expect(fs.existsSync(sourceInputs.tempRoot)).toBe(false);
  });

  it("refuses an address that isn't a plain https address for a repository", async () => {
    for (const url of [
      "http://github.com/o/r",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r",
      "file:///C:/repos/plugin",
      "https://token@github.com/o/r",
      "https://user:secret@github.com/o/r",
      "https://github.com/o/r?access_token=abc",
      "https://github.com/o/r#readme",
      "https://github.com/owner",
      "not a url",
      "",
    ]) {
      const failure = await failureOf(fetchPluginSource({ kind: "git", url }, inputs()));
      expect(failure.reason, url).toMatch(/^(INVALID_GIT_SOURCE|UNTRUSTED_GIT_HOST)$/u);
      expect(failure.statusCode, url).toBe(400);
      expect(failure.message, url).not.toContain("secret");
    }
    expect(fetchGitTreeMock).not.toHaveBeenCalled();
  });

  it("says plainly when the host won't fetch that exact commit", async () => {
    fetchGitTreeMock.mockRejectedValue(new GitCommitFetchRefusedError());
    const sourceInputs = inputs();

    const failure = await failureOf(
      fetchPluginSource({ kind: "git", url: "https://github.com/o/r", ref: COMMIT }, sourceInputs),
    );

    expect(failure).toMatchObject({
      statusCode: 422,
      reason: "COMMIT_NOT_FETCHABLE",
      message: "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag.",
    });
    expect(tempLeftovers()).toEqual([]);
  });

  it("maps the other Git failures without leaking paths", async () => {
    fetchGitTreeMock.mockRejectedValueOnce(new GitTreeLimitError("A plugin can hold at most 256 files."));
    expect(await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()))).toMatchObject({
      statusCode: 413,
      reason: "TREE_OVER_LIMITS",
      message: "A plugin can hold at most 256 files.",
    });

    fetchGitTreeMock.mockRejectedValueOnce(
      new GitFetchInputError("Git ref must be a full commit, or a branch or tag name."),
    );
    expect(
      await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r", ref: "a..b" }, inputs())),
    ).toMatchObject({ statusCode: 400, reason: "INVALID_GIT_SOURCE" });

    const gitFailure = Object.assign(
      new Error(
        `Command failed: git clone -- https://github.com/o/r ${scratchRoot}\nfatal: repository 'https://github.com/o/r/' not found`,
      ),
      { stderr: "Cloning...\nfatal: repository 'https://github.com/o/r/' not found\n" },
    );
    fetchGitTreeMock.mockRejectedValueOnce(gitFailure);
    const failed = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
    expect(failed).toMatchObject({ statusCode: 502, reason: "GIT_FETCH_FAILED" });
    expect(failed.message).toContain("repository 'https://github.com/o/r/' not found");
    expect(failed.message).not.toContain(scratchRoot);
    expect(failed.message).not.toContain("Command failed");

    fetchGitTreeMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    expect(await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()))).toMatchObject({
      statusCode: 502,
      reason: "GIT_FETCH_FAILED",
      message: expect.stringContaining("too long"),
    });
    expect(tempLeftovers()).toEqual([]);
  });

  describe("keeps the operator's words plain", () => {
    /** Nothing an operator reads may carry a temp path, the work folder's name or how Git was run. */
    function expectPlain(failure: Error): void {
      for (const leak of [scratchRoot, os.tmpdir(), "git -c", "Command failed", "protocol.allow", ".git-scratch"]) {
        expect(failure.message, leak).not.toContain(leak);
      }
    }

    it("reads Git's words from a stderr Buffer, never from the command line", async () => {
      fetchGitTreeMock.mockRejectedValueOnce(
        Object.assign(
          new Error(
            `Command failed: git -c protocol.allow=never -c protocol.https.allow=always clone -- https://github.com/o/r ${scratchRoot}\n`,
          ),
          { code: 128, stderr: Buffer.from("Cloning...\r\nfatal: repository 'https://github.com/o/r/' not found\r\n") },
        ),
      );

      const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));

      expect(failure).toMatchObject({
        statusCode: 502,
        reason: "GIT_FETCH_FAILED",
        message:
          "GoatCitadel couldn't fetch that Git repository. Git said: repository 'https://github.com/o/r/' not found",
      });
      expectPlain(failure);
    });

    it("drops a line of Git's that names a place on this computer", async () => {
      const lines = [
        `fatal: could not create work tree dir '${path.join(scratchRoot, "tmp", "git-1", "tree.git-scratch")}': Permission denied`,
        "fatal: could not create work tree dir 'C:\\Users\\someone\\AppData\\Local\\Temp\\tree.git-scratch': denied",
        "fatal: could not create work tree dir '/tmp/goat/git-1/tree.git-scratch': Permission denied",
        "fatal: unable to access '\\\\server\\share\\repo': denied",
      ];
      for (const line of lines) {
        fetchGitTreeMock.mockRejectedValueOnce(
          Object.assign(new Error(`Command failed: git -c protocol.allow=never clone ${scratchRoot}`), {
            code: 128,
            stderr: Buffer.from(`${line}\n`),
          }),
        );
        const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
        expect(failure, line).toMatchObject({
          statusCode: 502,
          reason: "GIT_FETCH_FAILED",
          message: "GoatCitadel couldn't fetch that Git repository. Git didn't finish.",
        });
        expectPlain(failure);
      }
    });

    it("says only that Git didn't finish when it left nothing to read", async () => {
      fetchGitTreeMock.mockRejectedValueOnce(
        Object.assign(new Error(`Command failed: git -c protocol.allow=never fetch ${scratchRoot}`), { code: 1 }),
      );
      const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
      expect(failure.message).toBe("GoatCitadel couldn't fetch that Git repository. Git didn't finish.");
      expectPlain(failure);
    });

    it("lets a file system failure through unchanged, not labelled a Git failure", async () => {
      const failure = Object.assign(
        new Error(
          `EPERM: operation not permitted, mkdir '${path.join(scratchRoot, "tmp", "git-1", "tree", "skills")}'`,
        ),
        { code: "EPERM", syscall: "mkdir", errno: -4048 },
      );
      fetchGitTreeMock.mockRejectedValueOnce(failure);

      const thrown = await fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()).catch(
        (error: unknown) => error,
      );

      expect(thrown).toBe(failure);
      expect(thrown).not.toBeInstanceOf(PluginSourceError);
      expect(tempLeftovers()).toEqual([]);
    });

    it("answers a host that sent something other than what was asked for with a 502 and that fixed sentence", async () => {
      for (const sentence of [
        "The host sent a different commit from the one that was asked for.",
        "Git sent a list of files GoatCitadel couldn't read.",
      ]) {
        fetchGitTreeMock.mockRejectedValueOnce(new GitFetchFailedError(sentence));
        const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
        expect(failure, sentence).toMatchObject({
          statusCode: 502,
          reason: "GIT_FETCH_FAILED",
          message: `GoatCitadel couldn't fetch that Git repository. ${sentence}`,
        });
      }
      expect(tempLeftovers()).toEqual([]);
    });

    it("answers a host name that didn't resolve with a 502, never as a private host", async () => {
      const lookup = new HostLookupError("unresolved", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }),
      });
      fetchGitTreeMock.mockRejectedValueOnce(new GitHostLookupError({ cause: lookup }));

      const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));

      expect(failure).toMatchObject({
        statusCode: 502,
        reason: "HOST_NOT_FOUND",
        message: "GoatCitadel couldn't reach that host. Check the connection and try again.",
      });
      expect(failure.cause).toBeInstanceOf(GitHostLookupError);
      expectPlain(failure);
    });

    it("lets any other error of GoatCitadel's own through unchanged", async () => {
      const failure = new Error("Something GoatCitadel did itself went wrong.");
      fetchGitTreeMock.mockRejectedValueOnce(failure);
      const thrown = await fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()).catch(
        (error: unknown) => error,
      );
      expect(thrown).toBe(failure);
    });

    it("refuses an address that isn't a public host with a plain 422", async () => {
      fetchGitTreeMock.mockRejectedValueOnce(
        new GitHostRefusedError({
          cause: new Error(`Private or reserved host blocked: 10.0.0.5 (resolved by github.example, ${scratchRoot})`),
        }),
      );

      const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));

      expect(failure).toMatchObject({
        statusCode: 422,
        reason: "HOST_NOT_PUBLIC",
        message: "That address isn't a public host.",
      });
      expectPlain(failure);
      expect(failure.message).not.toContain("10.0.0.5");
    });

    it("refuses a tree the Git reader found unsafe, in the tree's own words", async () => {
      fetchGitTreeMock.mockRejectedValueOnce(
        new GitTreeRefusedError(
          "skills/link isn't a plain file. A plugin can't hold links, other repositories or files that run.",
        ),
      );
      const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
      expect(failure).toMatchObject({
        statusCode: 422,
        reason: "UNSAFE_TREE",
        message: "skills/link isn't a plain file. A plugin can't hold links, other repositories or files that run.",
      });
    });
  });

  it("refuses a fetched tree that holds a link, and cleans up", async () => {
    const outside = makeFolder({ "secret.txt": "x" });
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      fs.symlinkSync(outside, path.join(input.destDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      return { commit: COMMIT };
    });
    const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, inputs()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
    expect(tempLeftovers()).toEqual([]);
  });
});

describe("fetchPluginSource: folder", () => {
  it("copies a folder into a snapshot pinned by its content", async () => {
    const folder = makeFolder(PLUGIN_FILES, scratchRoot, "My Plugin");
    const sourceInputs = inputs();

    const result = await fetchPluginSource({ kind: "folder", path: folder }, sourceInputs);

    expect(result.trust).toBe("unverified");
    expect(result.sourceDisplay).toBe("My Plugin");
    expect(result.pin).toEqual({ kind: "content", treeSha256: result.snapshot.treeSha256 });
    expect(fs.readFileSync(path.join(result.snapshot.dir, "goatcitadel-plugin.json"), "utf8")).toBe(
      PLUGIN_FILES["goatcitadel-plugin.json"],
    );
    // The operator's folder is only read.
    expect(fs.readFileSync(path.join(folder, "skills", "one", "SKILL.md"), "utf8")).toBe("# One");
    expect(tempLeftovers()).toEqual([]);
  });

  it("gives two copies of the same folder one snapshot", async () => {
    const sourceInputs = inputs();
    const first = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, sourceInputs);
    const second = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, sourceInputs);

    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.pin).toEqual(first.pin);
    expect(fs.readdirSync(path.join(scratchRoot, "snapshots"))).toEqual([first.snapshot.treeSha256]);
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a folder install on remote_hardened", async () => {
    const folder = makeFolder(PLUGIN_FILES);
    const sourceInputs = inputs("remote_hardened");

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, sourceInputs));

    expect(failure).toMatchObject({
      statusCode: 403,
      reason: "FOLDER_INSTALL_NOT_ALLOWED",
      message: "Folder installs work only when GoatCitadel runs on this computer.",
    });
    // It was refused before anything was read or written.
    expect(fs.existsSync(sourceInputs.tempRoot)).toBe(false);
    expect(fs.existsSync(path.join(scratchRoot, "snapshots"))).toBe(false);
  });

  it("allows a folder install on the local profiles", async () => {
    for (const profile of ["local_dev", "trusted_local"] as const) {
      const result = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, inputs(profile));
      expect(result.pin.kind, profile).toBe("content");
    }
  });

  it("needs an absolute path to a folder that is there", async () => {
    const aFile = path.join(makeFolder({ "plain.txt": "x" }), "plain.txt");
    const cases: Array<[string, string, number]> = [
      ["relative", "plugins/demo", 400],
      ["dot", ".", 400],
      ["empty", "", 400],
      ["nul", `${scratchRoot}${path.sep}bad\u0000name`, 400],
      ["missing", path.join(scratchRoot, "nope"), 404],
      ["a file", aFile, 400],
    ];
    for (const [name, folderPath, statusCode] of cases) {
      const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folderPath }, inputs()));
      expect(failure.statusCode, name).toBe(statusCode);
    }
  });

  it("refuses a folder with a link in it", async () => {
    const outside = makeFolder({ "secret.txt": "do not read" });
    const folder = makeFolder(PLUGIN_FILES);
    fs.symlinkSync(outside, path.join(folder, "linked"), process.platform === "win32" ? "junction" : "dir");

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, inputs()));

    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
    expect(failure.message).toContain("linked");
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a folder that is itself a link", async () => {
    const real = makeFolder(PLUGIN_FILES);
    const link = path.join(scratchRoot, "folder-link");
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: link }, inputs()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("refuses a file with a second hard link", async () => {
    const folder = makeFolder(PLUGIN_FILES);
    fs.linkSync(path.join(folder, "goatcitadel-plugin.json"), path.join(scratchRoot, "twin.json"));
    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, inputs()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("skips a .git folder in a folder source", async () => {
    const plain = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, inputs());

    const checkout = makeFolder({
      ...PLUGIN_FILES,
      ".git/HEAD": "ref: refs/heads/main",
      ".git/objects/ab/cdef": "object",
      "skills/one/.GIT/config": "nested, upper case",
    });
    // A `.git` file, as a linked work tree has.
    fs.writeFileSync(path.join(checkout, "skills", ".Git"), "gitdir: ../elsewhere");
    const withGit = await fetchPluginSource({ kind: "folder", path: checkout }, inputs());

    expect(withGit.snapshot.treeSha256).toBe(plain.snapshot.treeSha256);
    expect(withGit.pin).toEqual(plain.pin);
    expect(namesBelow(withGit.snapshot.dir).filter((name) => name.toLowerCase() === ".git")).toEqual([]);
    expect(tempLeftovers()).toEqual([]);
  });

  it("does not follow or refuse a .git link", async () => {
    const outside = makeFolder({ "secret.txt": "do not read" });
    const plain = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, inputs());
    const checkout = makeFolder(PLUGIN_FILES);
    fs.symlinkSync(outside, path.join(checkout, ".git"), process.platform === "win32" ? "junction" : "dir");

    const withLink = await fetchPluginSource({ kind: "folder", path: checkout }, inputs());

    expect(withLink.snapshot.treeSha256).toBe(plain.snapshot.treeSha256);
    expect(namesBelow(withLink.snapshot.dir)).not.toContain("secret.txt");
  });

  it("refuses a folder that is itself a .git folder", async () => {
    const gitFolder = makeFolder({ HEAD: "ref: refs/heads/main", "objects/ab/cdef": "object" }, scratchRoot, ".git");
    // Windows drops a name's trailing dots and spaces, so these spellings name the same .git folder there.
    const windowsSpellings = [".git.", ".git ", ".GIT. ", ".Git.."].map((name) =>
      path.join(path.dirname(gitFolder), name),
    );
    for (const folderPath of [
      gitFolder,
      `${gitFolder}${path.sep}`,
      path.join(path.dirname(gitFolder), ".GIT"),
      ...windowsSpellings,
    ]) {
      const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folderPath }, inputs()));
      expect(failure, folderPath).toMatchObject({
        statusCode: 400,
        reason: "INVALID_FOLDER",
        message: "Choose the plugin's folder, not its .git folder.",
      });
    }
    expect(tempLeftovers()).toEqual([]);
  });

  it("still refuses a link that isn't named .git", async () => {
    const outside = makeFolder({ "secret.txt": "do not read" });
    const folder = makeFolder(PLUGIN_FILES);
    fs.symlinkSync(outside, path.join(folder, ".github"), process.platform === "win32" ? "junction" : "dir");
    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, inputs()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("refuses a network or device folder path", async () => {
    // Text only: none of these may reach the file system, so none of its calls may be made.
    const fileSystemCalls = (["lstat", "readdir", "mkdir", "mkdtemp"] as const).map((name) =>
      vi.spyOn(fs.promises, name),
    );
    try {
      for (const folderPath of [
        "\\\\server\\share\\plugin",
        "\\\\?\\C:\\plugin",
        "\\\\?\\UNC\\server\\share\\plugin",
        "\\\\.\\C:\\plugin",
        "\\\\.\\COM1",
        "//server/share/plugin",
        "\\/server/share",
        "\\??\\C:\\plugin",
        "  \\\\server\\share\\plugin",
      ]) {
        const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folderPath }, inputs()));
        expect(failure, folderPath).toMatchObject({
          statusCode: 400,
          reason: "INVALID_FOLDER",
          message: "Use a folder on this computer.",
        });
      }
      for (const spy of fileSystemCalls) expect(spy).not.toHaveBeenCalled();

      // The same spies see an ordinary folder, so "not called" above means something.
      await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, inputs());
      expect(fileSystemCalls[0]).toHaveBeenCalled();
    } finally {
      for (const spy of fileSystemCalls) spy.mockRestore();
    }
  });

  it("refuses a tree over the limits before copying it", async () => {
    const folder = makeFolder(
      Object.fromEntries(Array.from({ length: PLUGIN_LIMITS.maxFiles + 1 }, (_, index) => [`f${index}.md`, "x"])),
    );
    const sourceInputs = inputs();

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, sourceInputs));

    expect(failure).toMatchObject({ statusCode: 413, reason: "TREE_OVER_LIMITS" });
    expect(tempLeftovers()).toEqual([]);
    expect(fs.existsSync(path.join(scratchRoot, "snapshots"))).toBe(false);
  });
});

describe("fetchPluginSource: built in", () => {
  function shippedRoot(): string {
    const root = path.join(scratchRoot, "shipped");
    makeFolder(PLUGIN_FILES, root, "demo-plugin");
    fs.writeFileSync(path.join(root, "README.md"), "This folder holds the plugins that ship with GoatCitadel.");
    fs.writeFileSync(path.join(root, "not-a-folder"), "a file named like a plugin id");
    return root;
  }

  it("resolves a built-in plugin only from the shipped folder", async () => {
    const root = shippedRoot();
    const outside = makeFolder({ "goatcitadel-plugin.json": "outside" }, scratchRoot, "outside-plugin");
    const sourceInputs = inputs();

    const result = await fetchPluginSource({ kind: "built_in", pluginId: "demo-plugin" }, sourceInputs);

    expect(result.trust).toBe("built_in");
    expect(result.sourceDisplay).toBe("Ships with GoatCitadel");
    expect(result.pin).toEqual({ kind: "content", treeSha256: result.snapshot.treeSha256 });
    expect(fs.readFileSync(path.join(result.snapshot.dir, "skills", "one", "SKILL.md"), "utf8")).toBe("# One");
    // The shipped folder is read, not consumed.
    expect(fs.existsSync(path.join(root, "demo-plugin", "goatcitadel-plugin.json"))).toBe(true);

    // No caller text reaches the file system: anything that isn't a plain plugin id is refused first.
    for (const pluginId of [
      "../outside-plugin",
      "..",
      ".",
      "demo-plugin/../../outside-plugin",
      "demo-plugin/skills",
      "Demo-Plugin",
      "demo_plugin",
      "a",
      "-demo",
      "x".repeat(49),
      "",
      "demo-plugin ",
      outside,
      "C:\\Windows",
      "demo-plugin\u0000",
    ]) {
      const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId }, sourceInputs));
      expect(failure, JSON.stringify(pluginId)).toMatchObject({ statusCode: 400, reason: "INVALID_BUILT_IN_ID" });
    }
    for (const pluginId of ["missing-plugin", "not-a-folder", "readme"]) {
      const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId }, sourceInputs));
      expect(failure, pluginId).toMatchObject({ statusCode: 404, reason: "BUILT_IN_NOT_FOUND" });
    }
    expect(tempLeftovers()).toEqual([]);
  });

  it("skips a .git folder in a built-in plugin", async () => {
    const root = shippedRoot();
    const plain = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, inputs());
    makeFolder({ ".git/config": "[core]" }, root, "demo-plugin");

    const result = await fetchPluginSource({ kind: "built_in", pluginId: "demo-plugin" }, inputs());

    expect(result.snapshot.treeSha256).toBe(plain.snapshot.treeSha256);
    expect(namesBelow(result.snapshot.dir)).not.toContain(".git");
  });

  it("refuses a shipped folder that has been swapped for a link", async () => {
    const root = shippedRoot();
    const outside = makeFolder({ "goatcitadel-plugin.json": "outside" }, scratchRoot, "outside-plugin");
    fs.symlinkSync(outside, path.join(root, "linked-plugin"), process.platform === "win32" ? "junction" : "dir");

    const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId: "linked-plugin" }, inputs()));

    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("is not held back by the folder rule on remote_hardened", async () => {
    shippedRoot();
    const result = await fetchPluginSource({ kind: "built_in", pluginId: "demo-plugin" }, inputs("remote_hardened"));
    expect(result.trust).toBe("built_in");
  });
});

describe("fetchPluginSource: anything else", () => {
  it("refuses a source of a kind it doesn't know", async () => {
    const failure = await failureOf(
      fetchPluginSource({ kind: "zip", url: "https://github.com/o/r.zip" } as unknown as PluginSource, inputs()),
    );
    expect(failure).toMatchObject({ statusCode: 400, reason: "INVALID_SOURCE" });
  });
});
