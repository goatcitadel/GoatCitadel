import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkbenchPathRevision, type WorkbenchPathScope } from "./workbench-path-revisions.js";
import { withWorkbenchWriteLock } from "./workbench-file-revisions.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-workbench-path-")) {
      throw new Error("Unexpected test cleanup root");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-workbench-path-")); roots.push(root);
  const scope: WorkbenchPathScope = { projectRoot: root, projectId: "project", sessionId: "session", assertAllowed: (target) => {
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Outside test root");
  } };
  await fs.writeFile(path.join(root, "source.txt"), "original");
  return { root, scope };
}

describe("Workbench path reviews", () => {
  it("is stable across project lock lifetimes and binds session, action and destination", async () => {
    const { root, scope } = await fixture();
    const input = { operation: "rename" as const, path: "source.txt", targetPath: "renamed.txt" };
    const first = await withWorkbenchWriteLock(root, () => readWorkbenchPathRevision(scope, input));
    const second = await withWorkbenchWriteLock(root, () => readWorkbenchPathRevision(scope, input));
    expect(first).toEqual(second);
    expect((await readWorkbenchPathRevision({ ...scope, sessionId: "other" }, input)).revision).not.toBe(first.revision);
    expect((await readWorkbenchPathRevision(scope, { ...input, operation: "move" })).revision).not.toBe(first.revision);
    expect((await readWorkbenchPathRevision(scope, { ...input, targetPath: "other.txt" })).revision).not.toBe(first.revision);
  });

  it("detects replacement of an absent target's parent and same-byte file replacement", async () => {
    const { root, scope } = await fixture();
    await fs.mkdir(path.join(root, "destination"));
    const input = { operation: "move" as const, path: "source.txt", targetPath: "destination/file.txt" };
    const first = await readWorkbenchPathRevision(scope, input);
    await fs.rename(path.join(root, "destination"), path.join(root, "old-destination"));
    await fs.mkdir(path.join(root, "destination"));
    const second = await readWorkbenchPathRevision(scope, input);
    expect(second.revision).not.toBe(first.revision);
    await fs.rename(path.join(root, "source.txt"), path.join(root, "old-source.txt"));
    await fs.writeFile(path.join(root, "source.txt"), "original");
    expect((await readWorkbenchPathRevision(scope, input)).revision).not.toBe(second.revision);
  });

  it("hashes nested bytes and reports every path, without truncating oversized reviews", async () => {
    const { root, scope } = await fixture();
    await fs.mkdir(path.join(root, "folder"));
    await fs.writeFile(path.join(root, "folder", "one.txt"), "one");
    const input = { operation: "delete" as const, path: "folder" };
    const first = await readWorkbenchPathRevision(scope, input);
    expect(first.affectedPaths).toEqual([{ path: "folder", kind: "directory", sizeBytes: 0 }, { path: "folder/one.txt", kind: "file", sizeBytes: 3 }]);
    await fs.writeFile(path.join(root, "folder", "one.txt"), "two");
    expect((await readWorkbenchPathRevision(scope, input)).revision).not.toBe(first.revision);
    await Promise.all(Array.from({ length: 500 }, (_, i) => fs.writeFile(path.join(root, "folder", `${i}.txt`), "")));
    await expect(readWorkbenchPathRevision(scope, input)).rejects.toThrow(/too large to review safely/);
    expect((await fs.readdir(path.join(root, "folder"))).length).toBe(501);
  });

  it("rejects junction entries instead of following them during a folder review", async () => {
    const { root, scope } = await fixture();
    await fs.mkdir(path.join(root, "folder"));
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "folder", "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(readWorkbenchPathRevision(scope, { operation: "delete", path: "folder" })).rejects.toThrow(/symbolic links or junctions/);
  });
});
