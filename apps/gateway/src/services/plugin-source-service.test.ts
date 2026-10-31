import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS, type DeploymentProfile, type PluginSource } from "@goatcitadel/contracts";

vi.mock("./hardened-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hardened-git.js")>()),
  fetchGitTree: vi.fn(),
}));

import { GitCommitFetchRefusedError, GitFetchInputError, GitTreeLimitError, fetchGitTree } from "./hardened-git.js";
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

function deps(deploymentProfile: DeploymentProfile = "trusted_local") {
  return {
    store: new PluginSnapshotStore(path.join(scratchRoot, "snapshots")),
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
    const sourceDeps = deps();

    const result = await fetchPluginSource(
      { kind: "git", url: "https://github.com/Octo/Plugin.git", ref: COMMIT },
      sourceDeps,
    );

    expect(result.pin).toEqual({ kind: "commit", commit: COMMIT });
    expect(result.trust).toBe("unverified");
    expect(result.sourceDisplay).toBe("github.com/Octo/Plugin");
    expect(fs.readFileSync(path.join(result.snapshot.dir, "skills", "one", "SKILL.md"), "utf8")).toBe("# One");
    expect(sourceDeps.store.resolve(result.snapshot.treeSha256)).toBe(result.snapshot.dir);
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
    expect(path.resolve(call.destDir).startsWith(path.resolve(sourceDeps.tempRoot) + path.sep)).toBe(true);
    expect(tempLeftovers()).toEqual([]);
  });

  it("passes a branch, a tag or no ref straight through", async () => {
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      return { commit: COMMIT };
    });
    await fetchPluginSource({ kind: "git", url: "https://gitlab.com/group/sub/repo" }, deps());
    await fetchPluginSource({ kind: "git", url: "https://codeberg.org/o/r", ref: "v1.2.0" }, deps());

    expect(fetchGitTreeMock.mock.calls.map(([input]) => input.ref)).toEqual([undefined, "v1.2.0"]);
  });

  it("names a repository without its .git or any credentials", async () => {
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      return { commit: COMMIT };
    });
    const results = await Promise.all([
      fetchPluginSource({ kind: "git", url: "https://bitbucket.org/team/tool.git" }, deps()),
      fetchPluginSource({ kind: "git", url: "https://GitLab.com/group/sub/repo/" }, deps()),
    ]);
    expect(results.map((result) => result.sourceDisplay)).toEqual([
      "bitbucket.org/team/tool",
      "gitlab.com/group/sub/repo",
    ]);
  });

  it("refuses a host that isn't a trusted forge", async () => {
    const sourceDeps = deps();
    for (const url of [
      "https://evil.example/o/r",
      "https://github.com.evil.example/o/r",
      "https://evil.example/github.com/o/r",
      "https://gitlab.com:8443/o/r",
      "https://127.0.0.1/o/r",
      "https://localhost/o/r",
    ]) {
      const failure = await failureOf(fetchPluginSource({ kind: "git", url }, sourceDeps));
      expect(failure, url).toMatchObject({
        statusCode: 400,
        reason: "UNTRUSTED_GIT_HOST",
        message: "GoatCitadel installs plugins only from GitHub, GitLab, Bitbucket or Codeberg.",
      });
    }
    expect(fetchGitTreeMock).not.toHaveBeenCalled();
    expect(fs.existsSync(sourceDeps.tempRoot)).toBe(false);
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
      const failure = await failureOf(fetchPluginSource({ kind: "git", url }, deps()));
      expect(failure.reason, url).toMatch(/^(INVALID_GIT_SOURCE|UNTRUSTED_GIT_HOST)$/u);
      expect(failure.statusCode, url).toBe(400);
      expect(failure.message, url).not.toContain("secret");
    }
    expect(fetchGitTreeMock).not.toHaveBeenCalled();
  });

  it("says plainly when the host won't fetch that exact commit", async () => {
    fetchGitTreeMock.mockRejectedValue(new GitCommitFetchRefusedError());
    const sourceDeps = deps();

    const failure = await failureOf(
      fetchPluginSource({ kind: "git", url: "https://github.com/o/r", ref: COMMIT }, sourceDeps),
    );

    expect(failure).toMatchObject({
      statusCode: 422,
      reason: "COMMIT_NOT_FETCHABLE",
      message: "This host can't fetch that exact commit. Leave the pin empty, or use a branch or tag.",
    });
    expect(tempLeftovers()).toEqual([]);
  });

  it("maps the other Git failures without leaking paths", async () => {
    fetchGitTreeMock.mockRejectedValueOnce(new GitTreeLimitError("Git plugin tree exceeds 256 files."));
    expect(await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, deps()))).toMatchObject({
      statusCode: 413,
      reason: "TREE_OVER_LIMITS",
      message: "Git plugin tree exceeds 256 files.",
    });

    fetchGitTreeMock.mockRejectedValueOnce(
      new GitFetchInputError("Git ref must be a full commit, or a branch or tag name."),
    );
    expect(
      await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r", ref: "a..b" }, deps())),
    ).toMatchObject({ statusCode: 400, reason: "INVALID_GIT_SOURCE" });

    const gitFailure = Object.assign(
      new Error(
        `Command failed: git clone -- https://github.com/o/r ${scratchRoot}\nfatal: repository 'https://github.com/o/r/' not found`,
      ),
      { stderr: "Cloning...\nfatal: repository 'https://github.com/o/r/' not found\n" },
    );
    fetchGitTreeMock.mockRejectedValueOnce(gitFailure);
    const failed = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, deps()));
    expect(failed).toMatchObject({ statusCode: 502, reason: "GIT_FETCH_FAILED" });
    expect(failed.message).toContain("repository 'https://github.com/o/r/' not found");
    expect(failed.message).not.toContain(scratchRoot);
    expect(failed.message).not.toContain("Command failed");

    fetchGitTreeMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    expect(await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, deps()))).toMatchObject({
      statusCode: 502,
      reason: "GIT_FETCH_FAILED",
      message: expect.stringContaining("too long"),
    });
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a fetched tree that holds a link, and cleans up", async () => {
    const outside = makeFolder({ "secret.txt": "x" });
    fetchGitTreeMock.mockImplementation(async (input) => {
      writeTree(input.destDir, PLUGIN_FILES);
      fs.symlinkSync(outside, path.join(input.destDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      return { commit: COMMIT };
    });
    const failure = await failureOf(fetchPluginSource({ kind: "git", url: "https://github.com/o/r" }, deps()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
    expect(tempLeftovers()).toEqual([]);
  });
});

describe("fetchPluginSource: folder", () => {
  it("copies a folder into a snapshot pinned by its content", async () => {
    const folder = makeFolder(PLUGIN_FILES, scratchRoot, "My Plugin");
    const sourceDeps = deps();

    const result = await fetchPluginSource({ kind: "folder", path: folder }, sourceDeps);

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
    const sourceDeps = deps();
    const first = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, sourceDeps);
    const second = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, sourceDeps);

    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.pin).toEqual(first.pin);
    expect(fs.readdirSync(path.join(scratchRoot, "snapshots"))).toEqual([first.snapshot.treeSha256]);
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a folder install on remote_hardened", async () => {
    const folder = makeFolder(PLUGIN_FILES);
    const sourceDeps = deps("remote_hardened");

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, sourceDeps));

    expect(failure).toMatchObject({
      statusCode: 403,
      reason: "FOLDER_INSTALL_NOT_ALLOWED",
      message: "Folder installs work only when GoatCitadel runs on this computer.",
    });
    // It was refused before anything was read or written.
    expect(fs.existsSync(sourceDeps.tempRoot)).toBe(false);
    expect(fs.existsSync(path.join(scratchRoot, "snapshots"))).toBe(false);
  });

  it("allows a folder install on the local profiles", async () => {
    for (const profile of ["local_dev", "trusted_local"] as const) {
      const result = await fetchPluginSource({ kind: "folder", path: makeFolder(PLUGIN_FILES) }, deps(profile));
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
      const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folderPath }, deps()));
      expect(failure.statusCode, name).toBe(statusCode);
    }
  });

  it("refuses a folder with a link in it", async () => {
    const outside = makeFolder({ "secret.txt": "do not read" });
    const folder = makeFolder(PLUGIN_FILES);
    fs.symlinkSync(outside, path.join(folder, "linked"), process.platform === "win32" ? "junction" : "dir");

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, deps()));

    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
    expect(failure.message).toContain("linked");
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a folder that is itself a link", async () => {
    const real = makeFolder(PLUGIN_FILES);
    const link = path.join(scratchRoot, "folder-link");
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: link }, deps()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("refuses a file with a second hard link", async () => {
    const folder = makeFolder(PLUGIN_FILES);
    fs.linkSync(path.join(folder, "goatcitadel-plugin.json"), path.join(scratchRoot, "twin.json"));
    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, deps()));
    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("refuses a tree over the limits before copying it", async () => {
    const folder = makeFolder(
      Object.fromEntries(Array.from({ length: PLUGIN_LIMITS.maxFiles + 1 }, (_, index) => [`f${index}.md`, "x"])),
    );
    const sourceDeps = deps();

    const failure = await failureOf(fetchPluginSource({ kind: "folder", path: folder }, sourceDeps));

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
    const sourceDeps = deps();

    const result = await fetchPluginSource({ kind: "built_in", pluginId: "demo-plugin" }, sourceDeps);

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
      const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId }, sourceDeps));
      expect(failure, JSON.stringify(pluginId)).toMatchObject({ statusCode: 400, reason: "INVALID_BUILT_IN_ID" });
    }
    for (const pluginId of ["missing-plugin", "not-a-folder", "readme"]) {
      const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId }, sourceDeps));
      expect(failure, pluginId).toMatchObject({ statusCode: 404, reason: "BUILT_IN_NOT_FOUND" });
    }
    expect(tempLeftovers()).toEqual([]);
  });

  it("refuses a shipped folder that has been swapped for a link", async () => {
    const root = shippedRoot();
    const outside = makeFolder({ "goatcitadel-plugin.json": "outside" }, scratchRoot, "outside-plugin");
    fs.symlinkSync(outside, path.join(root, "linked-plugin"), process.platform === "win32" ? "junction" : "dir");

    const failure = await failureOf(fetchPluginSource({ kind: "built_in", pluginId: "linked-plugin" }, deps()));

    expect(failure).toMatchObject({ statusCode: 422, reason: "UNSAFE_TREE" });
  });

  it("is not held back by the folder rule on remote_hardened", async () => {
    shippedRoot();
    const result = await fetchPluginSource({ kind: "built_in", pluginId: "demo-plugin" }, deps("remote_hardened"));
    expect(result.trust).toBe("built_in");
  });
});

describe("fetchPluginSource: anything else", () => {
  it("refuses a source of a kind it doesn't know", async () => {
    const failure = await failureOf(
      fetchPluginSource({ kind: "zip", url: "https://github.com/o/r.zip" } as unknown as PluginSource, deps()),
    );
    expect(failure).toMatchObject({ statusCode: 400, reason: "INVALID_SOURCE" });
  });
});
