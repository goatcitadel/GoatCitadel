import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LIMITS } from "@goatcitadel/contracts";
import {
  PluginSnapshotPathError,
  PluginSnapshotStore,
  listPluginTree,
  readPluginFileBounded,
} from "./plugin-snapshot-store.js";

let scratchRoot: string;
let store: PluginSnapshotStore;
let storeRoot: string;
let counter = 0;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The tree hash as the brief words it: sha256 over the sorted `path\0sha256(content)\n` lines. */
function expectedTreeHash(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((relativePath) => `${relativePath}\u0000${sha256(files[relativePath] ?? "")}\n`);
  return sha256(lines.join(""));
}

function makeFolder(files: Record<string, string | Buffer>): string {
  counter += 1;
  const root = path.join(scratchRoot, `folder-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goat-plugin-store-"));
  storeRoot = path.join(scratchRoot, "snapshots");
  store = new PluginSnapshotStore(storeRoot);
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("PluginSnapshotStore.importDirectory", () => {
  const files = {
    "goatcitadel-plugin.json": '{"pluginId":"demo"}',
    "skills/one/SKILL.md": "# One",
    "prompts/pack.md": "Hello",
  };

  it("hashes the sorted path-and-content lines and renames the folder into place", async () => {
    const source = makeFolder(files);

    const snapshot = await store.importDirectory(source);

    expect(snapshot.treeSha256).toBe(expectedTreeHash(files));
    expect(snapshot.dir).toBe(path.join(storeRoot, snapshot.treeSha256));
    expect(fs.readFileSync(path.join(snapshot.dir, "skills", "one", "SKILL.md"), "utf8")).toBe("# One");
    // The temp copy was consumed: it was renamed, not copied.
    expect(fs.existsSync(source)).toBe(false);
  });

  it("gives two copies of the same folder one snapshot", async () => {
    const first = await store.importDirectory(makeFolder(files));
    const secondSource = makeFolder(files);

    const second = await store.importDirectory(secondSource);

    expect(second).toEqual(first);
    expect(fs.readdirSync(storeRoot)).toEqual([first.treeSha256]);
    // The loser's temp copy is deleted, and the first snapshot is untouched.
    expect(fs.existsSync(secondSource)).toBe(false);
    expect(fs.readFileSync(path.join(first.dir, "prompts", "pack.md"), "utf8")).toBe("Hello");
  });

  it("treats a lost race as 'already there', not as an error", async () => {
    const sources = [makeFolder(files), makeFolder(files), makeFolder(files)];

    const snapshots = await Promise.all(sources.map((source) => store.importDirectory(source)));

    expect(new Set(snapshots.map((snapshot) => snapshot.treeSha256)).size).toBe(1);
    expect(fs.readdirSync(storeRoot)).toHaveLength(1);
    for (const source of sources) expect(fs.existsSync(source)).toBe(false);
  });

  it("throws the rename's own error when it fails and the snapshot can't be looked at, with the look as context", async () => {
    const source = makeFolder(files);
    const wanted = path.join(storeRoot, expectedTreeHash(files));
    const renameFailure = Object.assign(new Error(`EPERM: operation not permitted, rename '${source}'`), {
      code: "EPERM",
    });
    const lookFailure = Object.assign(new Error(`EACCES: permission denied, lstat '${wanted}'`), { code: "EACCES" });
    const realLstatSync = fs.lstatSync.bind(fs);
    let looks = 0;
    // The first look (before the rename) finds nothing there; the look after the failed rename can't be made.
    const lstatSync = vi.spyOn(fs, "lstatSync").mockImplementation(((target: string, ...rest: unknown[]) => {
      if (target === wanted && (looks += 1) > 1) throw lookFailure;
      return realLstatSync(target, ...(rest as []));
    }) as never);
    const rename = vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(renameFailure);
    try {
      const thrown = await store.importDirectory(source).catch((error: unknown) => error);
      expect(thrown).toBe(renameFailure);
      expect((thrown as Error).cause).toBe(lookFailure);
      expect(looks).toBe(2);
    } finally {
      rename.mockRestore();
      lstatSync.mockRestore();
    }
    // Nothing was stored, and the folder is left for the caller to remove.
    expect(fs.existsSync(wanted)).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  });

  it("does not depend on the order the files were written", async () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const a = await store.importDirectory(makeFolder(files));
    const b = await store.importDirectory(makeFolder(reversed));
    expect(b.treeSha256).toBe(a.treeSha256);
  });

  it("changes the hash when a path or a byte changes", async () => {
    const base = await store.importDirectory(makeFolder(files));
    const changedByte = await store.importDirectory(makeFolder({ ...files, "prompts/pack.md": "Hellp" }));
    const { "prompts/pack.md": _moved, ...withoutPack } = files;
    const movedFile = await store.importDirectory(makeFolder({ ...withoutPack, "prompts/other.md": "Hello" }));
    expect(new Set([base.treeSha256, changedByte.treeSha256, movedFile.treeSha256]).size).toBe(3);
  });

  it("refuses a link in the folder", async () => {
    const outside = makeFolder({ "secret.txt": "do not read" });
    const source = makeFolder({ "a.md": "a" });
    // A junction needs no privilege on Windows and is how Node reports a link there.
    fs.symlinkSync(outside, path.join(source, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(store.importDirectory(source)).rejects.toMatchObject({ reason: "UNSAFE_TREE" });
    expect(fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot) : []).toEqual([]);
  });

  it("refuses a file symbolic link", async (context) => {
    const source = makeFolder({ "a.md": "a" });
    try {
      fs.symlinkSync(path.join(source, "a.md"), path.join(source, "b.md"), "file");
    } catch {
      context.skip(); // creating a file link needs a privilege this machine hasn't given
      return;
    }
    await expect(store.importDirectory(source)).rejects.toMatchObject({ reason: "UNSAFE_TREE" });
  });

  it("refuses a link as the folder itself", async () => {
    const real = makeFolder({ "a.md": "a" });
    const link = path.join(scratchRoot, "link-to-folder");
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    await expect(store.importDirectory(link)).rejects.toMatchObject({ reason: "UNSAFE_TREE" });
  });

  it("refuses a file that has a second hard link", async () => {
    const source = makeFolder({ "a.md": "a" });
    fs.linkSync(path.join(source, "a.md"), path.join(scratchRoot, "elsewhere.md"));
    await expect(store.importDirectory(source)).rejects.toMatchObject({
      reason: "UNSAFE_TREE",
      message: expect.stringContaining("a.md"),
    });
  });

  it("refuses names that aren't portable", async () => {
    for (const name of [".git/config", "ﬁle.md", "docs/e\u0301.md"]) {
      const source = makeFolder({ [name]: "x" });
      await expect(store.importDirectory(source), name).rejects.toMatchObject({ reason: "UNSAFE_TREE" });
    }
  });

  it("leaves out .git only when asked, and refuses it otherwise", async () => {
    const source = makeFolder({ "a.md": "a", ".git/HEAD": "x", "docs/.GIT": "gitdir: x" });

    await expect(listPluginTree(source)).rejects.toMatchObject({ reason: "UNSAFE_TREE" });
    await expect(store.importDirectory(source)).rejects.toMatchObject({ reason: "UNSAFE_TREE" });

    const listed = await listPluginTree(source, { skipVcsMetadata: true });
    expect(listed.map((file) => file.relativePath)).toEqual(["a.md"]);
  });

  it("refuses two names a case-insensitive disk would merge", async (context) => {
    const source = makeFolder({ "Readme.md": "a" });
    fs.writeFileSync(path.join(source, "README.md"), "b");
    if (fs.readdirSync(source).length < 2) {
      context.skip(); // this disk is case-insensitive, so the second name was the first file
      return;
    }
    await expect(store.importDirectory(source)).rejects.toMatchObject({
      reason: "UNSAFE_TREE",
      message: expect.stringContaining("case-colliding"),
    });
  });

  it("refuses a tree over the limits", async () => {
    const tooMany = makeFolder(
      Object.fromEntries(Array.from({ length: PLUGIN_LIMITS.maxFiles + 1 }, (_, index) => [`f${index}.md`, "x"])),
    );
    await expect(store.importDirectory(tooMany)).rejects.toMatchObject({
      reason: "TREE_OVER_LIMITS",
      message: `A plugin can hold at most ${PLUGIN_LIMITS.maxFiles} files.`,
    });

    const bigFile = makeFolder({ "big.md": Buffer.alloc(PLUGIN_LIMITS.maxFileBytes + 1, 0x61) });
    await expect(store.importDirectory(bigFile)).rejects.toMatchObject({
      reason: "TREE_OVER_LIMITS",
      message: expect.stringContaining("big.md"),
    });

    const exactFile = makeFolder({ "exact.md": Buffer.alloc(PLUGIN_LIMITS.maxFileBytes, 0x61) });
    await expect(store.importDirectory(exactFile)).resolves.toHaveProperty("treeSha256");

    const heavy = makeFolder(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`part${index}.md`, Buffer.alloc(PLUGIN_LIMITS.maxFileBytes, index)]),
      ),
    );
    await expect(store.importDirectory(heavy)).rejects.toMatchObject({
      reason: "TREE_OVER_LIMITS",
      message: "A plugin can hold at most 8 MiB in all.",
    });

    const wide = makeFolder({ "a.md": "a" });
    for (let index = 0; index <= PLUGIN_LIMITS.maxFiles * 2; index += 1) {
      fs.mkdirSync(path.join(wide, `empty-${index}`));
    }
    await expect(store.importDirectory(wide)).rejects.toMatchObject({ reason: "TREE_OVER_LIMITS" });
  });

  it("rejects a folder that isn't there", async () => {
    await expect(store.importDirectory(path.join(scratchRoot, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops reading a folder as soon as it holds too many entries", async () => {
    let yielded = 0;
    const hugeFolder = {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 1_000_000; index += 1) {
          yielded += 1;
          yield { name: `f${index}.md` };
        }
      },
    };
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValue(hugeFolder as never);
    try {
      await expect(listPluginTree(makeFolder({ "a.md": "a" }))).rejects.toMatchObject({
        reason: "TREE_OVER_LIMITS",
        message: `A plugin can hold at most ${PLUGIN_LIMITS.maxFiles * 2} files and folders.`,
      });
    } finally {
      opendir.mockRestore();
    }
    // The first entry past the limit ended the read; the other 999,000-odd were never asked for.
    expect(yielded).toBe(PLUGIN_LIMITS.maxFiles * 2 + 1);
  });

  it("refuses two folders that differ only in case", async () => {
    // A real disk can't hold both spellings on Windows or macOS, so the folder listing is faked: two folders, one
    // spelled `Skills` and one `skills`, each with a file.
    const root = makeFolder({ "readme.md": "r" });
    const listing = new Map<string, string[]>([
      [root, ["Skills", "skills"]],
      [path.join(root, "Skills"), ["a.md"]],
      [path.join(root, "skills"), ["b.md"]],
    ]);
    const realLstat = fs.promises.lstat.bind(fs.promises);
    let fileId = 0n;
    const opendir = vi.spyOn(fs.promises, "opendir").mockImplementation((async (folder: string) => ({
      async *[Symbol.asyncIterator]() {
        for (const name of listing.get(String(folder)) ?? []) yield { name };
      },
    })) as never);
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: string, options?: object) => {
      if (target === root) return realLstat(target, options as never);
      const isFolder = listing.has(String(target));
      fileId += 1n;
      return {
        isSymbolicLink: () => false,
        isDirectory: () => isFolder,
        isFile: () => !isFolder,
        nlink: 1n,
        size: 1n,
        dev: 1n,
        ino: fileId,
      };
    }) as never);
    try {
      await expect(listPluginTree(root)).rejects.toMatchObject({
        reason: "UNSAFE_TREE",
        message: expect.stringMatching(/^The plugin folder contains a case-colliding path: [Ss]kills\/[ab]\.md\.$/u),
      });
    } finally {
      opendir.mockRestore();
      lstat.mockRestore();
    }
  });

  it("is a plain list of files for the callers that only need to look", async () => {
    const source = makeFolder(files);
    const listed = await listPluginTree(source);
    expect(listed.map((file) => file.relativePath)).toEqual([
      "goatcitadel-plugin.json",
      "prompts/pack.md",
      "skills/one/SKILL.md",
    ]);
    expect(listed.map((file) => file.bytes)).toEqual([
      files["goatcitadel-plugin.json"].length,
      files["prompts/pack.md"].length,
      files["skills/one/SKILL.md"].length,
    ]);
    // Looking changes nothing.
    expect(fs.existsSync(source)).toBe(true);
  });
});

describe("PluginSnapshotStore.resolve", () => {
  const files = { "goatcitadel-plugin.json": "{}", "skills/one/SKILL.md": "# One" };

  it("answers the snapshot folder, or a path inside it", async () => {
    const snapshot = await store.importDirectory(makeFolder(files));

    expect(store.resolve(snapshot.treeSha256)).toBe(snapshot.dir);
    expect(store.resolve(snapshot.treeSha256, "")).toBe(snapshot.dir);
    const inside = store.resolve(snapshot.treeSha256, "skills/one");
    expect(inside).toBe(path.join(snapshot.dir, "skills", "one"));
    expect(fs.readFileSync(path.join(inside, "SKILL.md"), "utf8")).toBe("# One");
  });

  it("refuses a snapshot path that climbs out", async () => {
    const snapshot = await store.importDirectory(makeFolder(files));
    const hash = snapshot.treeSha256;

    for (const relativePath of [
      "..",
      "../",
      "../outside",
      "skills/../../outside",
      "skills/../..",
      ".",
      "./skills",
      "/etc/passwd",
      "C:/Windows",
      "C:\\Windows",
      "skills\\..\\..\\outside",
      "skills//one",
      "skills/one/",
      "skills/\u0000/one",
      ".git/config",
    ]) {
      expect(() => store.resolve(hash, relativePath), JSON.stringify(relativePath)).toThrow(PluginSnapshotPathError);
    }
  });

  it("builds its answer only from a real hash", async () => {
    const snapshot = await store.importDirectory(makeFolder(files));

    for (const id of [
      "",
      "..",
      `..${path.sep}outside`,
      "../outside",
      snapshot.treeSha256.toUpperCase(),
      snapshot.treeSha256.slice(0, 63),
      `${snapshot.treeSha256}/..`,
      `${snapshot.treeSha256}\u0000`,
      "g".repeat(64),
    ]) {
      expect(() => store.resolve(id), JSON.stringify(id)).toThrow(PluginSnapshotPathError);
    }
  });

  it("refuses a snapshot that isn't there", () => {
    expect(() => store.resolve("a".repeat(64))).toThrow(/isn't on this computer/u);
    expect(() => store.resolve("a".repeat(64), "skills/one")).toThrow(/isn't on this computer/u);
  });

  it("says a snapshot is missing only when it is, not when the disk can't be read", () => {
    const hash = "b".repeat(64);
    const wanted = path.join(storeRoot, hash);
    const realLstatSync = fs.lstatSync.bind(fs);
    const denied = Object.assign(new Error(`EACCES: permission denied, lstat '${wanted}'`), { code: "EACCES" });
    const lstatSync = vi.spyOn(fs, "lstatSync").mockImplementation(((target: string, ...rest: unknown[]) => {
      if (target === wanted) throw denied;
      return realLstatSync(target, ...(rest as []));
    }) as never);
    try {
      expect(() => store.resolve(hash)).toThrow(denied);
    } finally {
      lstatSync.mockRestore();
    }
    // The same snapshot, truly absent, is the ordinary refusal.
    expect(() => store.resolve(hash)).toThrow(PluginSnapshotPathError);
  });
});

describe("readPluginFileBounded", () => {
  const swapped = "The folder changed while it was being copied.";

  it("reads the file the listing saw", async () => {
    const [file] = await listPluginTree(makeFolder({ "a.md": "hello" }));
    expect((await readPluginFileBounded(file!)).toString("utf8")).toBe("hello");
  });

  it("refuses a file that was swapped for another after the listing", async () => {
    const source = makeFolder({ "a.md": "aaaa" });
    const [file] = await listPluginTree(source);
    // Same name, same size, different file: a new one renamed over the listed one.
    fs.writeFileSync(path.join(source, "impostor.tmp"), "zzzz");
    fs.renameSync(path.join(source, "impostor.tmp"), path.join(source, "a.md"));

    await expect(readPluginFileBounded(file!)).rejects.toMatchObject({ reason: "UNSAFE_TREE", message: swapped });
  });

  it("refuses a file that changed size after the listing", async () => {
    const source = makeFolder({ "a.md": "aaaa" });
    const [file] = await listPluginTree(source);
    fs.appendFileSync(path.join(source, "a.md"), "more");

    await expect(readPluginFileBounded(file!)).rejects.toMatchObject({ reason: "UNSAFE_TREE", message: swapped });
  });

  it("refuses a file that gained a second link after the listing", async () => {
    const source = makeFolder({ "a.md": "aaaa" });
    const [file] = await listPluginTree(source);
    fs.linkSync(path.join(source, "a.md"), path.join(scratchRoot, "twin.md"));

    await expect(readPluginFileBounded(file!)).rejects.toMatchObject({ reason: "UNSAFE_TREE", message: swapped });
  });
});

describe("PluginSnapshotStore.sweep", () => {
  it("removes every snapshot outside the keep set, and a removed one no longer resolves", async () => {
    const first = await store.importDirectory(makeFolder({ "a.txt": "one" }));
    const second = await store.importDirectory(makeFolder({ "a.txt": "two" }));
    const third = await store.importDirectory(makeFolder({ "a.txt": "three" }));
    fs.mkdirSync(path.join(storeRoot, "not-a-snapshot"));

    const { removed } = await store.sweep(new Set([first.treeSha256]), { olderThanMs: 0 });

    expect(removed.sort()).toEqual([second.treeSha256, third.treeSha256].sort());
    expect(store.resolve(first.treeSha256)).toBe(first.dir);
    expect(() => store.resolve(second.treeSha256)).toThrow(PluginSnapshotPathError);
    expect(fs.existsSync(path.join(storeRoot, "not-a-snapshot"))).toBe(true);
  });

  it("keeps a snapshot newer than the grace window even when nothing keeps it", async () => {
    const fresh = await store.importDirectory(makeFolder({ "a.txt": "fresh" }));
    const hour = 60 * 60 * 1000;

    expect((await store.sweep(new Set(), { olderThanMs: hour })).removed).toEqual([]);
    expect(store.resolve(fresh.treeSha256)).toBe(fresh.dir);

    const later = await store.sweep(new Set(), { olderThanMs: hour, now: Date.now() + 2 * hour });
    expect(later.removed).toEqual([fresh.treeSha256]);
  });

  it("answers nothing removed when the store folder doesn't exist yet", async () => {
    await expect(store.sweep(new Set(), { olderThanMs: 0 })).resolves.toEqual({ removed: [] });
  });
});
