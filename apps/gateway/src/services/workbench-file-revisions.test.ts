import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkbenchFileSnapshot,
  withWorkbenchWriteLock,
  WORKBENCH_WRITE_LOCK,
  writeWorkbenchFileSnapshot,
  type WorkbenchFileScope,
} from "./workbench-file-revisions.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-workbench-revision-")) {
      throw new Error("Refusing cleanup outside an owned temporary fixture.");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<WorkbenchFileScope> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-workbench-revision-"));
  roots.push(projectRoot);
  await fs.writeFile(path.join(projectRoot, "file.txt"), "original content\n", { mode: 0o640 });
  return { projectRoot, relativePath: "file.txt", sessionId: "session", projectId: "project", assertAllowed: () => {} };
}

function save(scope: WorkbenchFileScope, expectedRevision: string | null, content: string) {
  return withWorkbenchWriteLock(scope.projectRoot, () => writeWorkbenchFileSnapshot(scope, { expectedRevision, content }, () => {}));
}

describe("Workbench file revisions", () => {
  it("reads stable revisions and saves exact shorter contents while preserving existing identity and permissions", async () => {
    const scope = await fixture();
    const before = await readWorkbenchFileSnapshot(scope);
    expect((await readWorkbenchFileSnapshot(scope)).revision).toBe(before.revision);
    const after = await save(scope, before.revision, "short\n");
    expect(after.content.toString()).toBe("short\n");
    expect(after.revision).not.toBe(before.revision);
    expect(after.stat.ino).toBe(before.stat.ino);
    expect(after.stat.mode).toBe(before.stat.mode);
    expect((await readWorkbenchFileSnapshot(scope)).revision).toBe(after.revision);
    await expect(save(scope, before.revision, "stale")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    await expect(fs.access(path.join(scope.projectRoot, WORKBENCH_WRITE_LOCK))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows one of two independent processes to save the same reviewed revision", async () => {
    const scope = await fixture();
    const before = await readWorkbenchFileSnapshot(scope);
    const writers = [startWriter(scope.projectRoot), startWriter(scope.projectRoot)];
    try {
      await Promise.all(writers.map((writer) => writer.ready));
      const results = writers.map((writer, index) => {
        const reply = nextMessage(writer.child);
        writer.child.send({ revision: before.revision, content: `writer ${index}\n` });
        return reply;
      });
      const outcomes = await Promise.all(results);
      expect(outcomes.filter((outcome) => outcome.status === "saved")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.code === "WRITE_CONFLICT")).toHaveLength(1);
      expect(await fs.readFile(path.join(scope.projectRoot, scope.relativePath), "utf8"))
        .toBe(outcomes.find((outcome) => outcome.status === "saved")?.content);
      expect(await Promise.all(writers.map((writer) => writer.closed))).toEqual([0, 0]);
    } finally {
      for (const writer of writers) if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
      await Promise.all(writers.map((writer) => writer.closed));
    }
  }, 30_000);

  it("rejects revisions from another session, project, relative path or physical root", async () => {
    const scope = await fixture();
    const before = await readWorkbenchFileSnapshot(scope);
    const other = await fixture();
    await fs.writeFile(path.join(scope.projectRoot, "other.txt"), before.content);
    for (const foreign of [
      { ...scope, sessionId: "different-session" }, { ...scope, projectId: "different-project" },
      { ...scope, relativePath: "other.txt" }, other,
    ]) await expect(save(foreign, before.revision, "wrong scope")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect((await readWorkbenchFileSnapshot(scope)).content).toEqual(before.content);
  });

  it("requires explicit absence for creation and never replaces an existing file with null", async () => {
    const scope = await fixture();
    await expect(save(scope, null, "overwrite")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    await expect(save(scope, undefined as unknown as string, "unguarded")).rejects.toThrow(/revision is required/);
    const newScope = { ...scope, relativePath: "new.txt" };
    await expect(save(newScope, undefined as unknown as string, "unguarded")).rejects.toThrow(/revision is required/);
    await expect(fs.access(path.join(scope.projectRoot, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const created = await save(newScope, null, "created\n");
    expect(created.content.toString()).toBe("created\n");
    await expect(save(newScope, null, "second create")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("rejects an ABA change and a same-content replacement even if mtime is restored", async () => {
    const scope = await fixture();
    const before = await readWorkbenchFileSnapshot(scope);
    const target = path.join(scope.projectRoot, scope.relativePath);
    await fs.writeFile(target, "intervening change");
    await fs.writeFile(target, before.content);
    await fs.utimes(target, before.stat.atime, before.stat.mtime);
    await expect(save(scope, before.revision, "stale ABA")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    const latest = await readWorkbenchFileSnapshot(scope);
    await fs.rename(target, path.join(scope.projectRoot, "old.txt"));
    await fs.writeFile(target, before.content);
    await fs.utimes(target, latest.stat.atime, latest.stat.mtime);
    await expect(save(scope, latest.revision, "stale identity")).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("rejects hardlink writes before modifying any link", async () => {
    const scope = await fixture();
    const before = await readWorkbenchFileSnapshot(scope);
    await fs.link(path.join(scope.projectRoot, scope.relativePath), path.join(scope.projectRoot, "linked.txt"));
    await expect(save(scope, before.revision, "replace both")).rejects.toThrow(/one filesystem link/);
    expect(await fs.readFile(path.join(scope.projectRoot, "linked.txt"))).toEqual(before.content);
  });

  it("releases its own failed-operation lock and does not delete a replacement lock", async () => {
    const scope = await fixture();
    const lockPath = path.join(scope.projectRoot, WORKBENCH_WRITE_LOCK);
    await expect(withWorkbenchWriteLock(scope.projectRoot, async () => { throw new Error("before write"); }))
      .rejects.toThrow("before write");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await withWorkbenchWriteLock(scope.projectRoot, async () => {
      await fs.rename(lockPath, path.join(scope.projectRoot, "original-lock"));
      await fs.writeFile(lockPath, "replacement lock");
    });
    expect(await fs.readFile(lockPath, "utf8")).toBe("replacement lock");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 6_000);
    await expect(withWorkbenchWriteLock(scope.projectRoot, async () => "unsafe takeover"))
      .rejects.toMatchObject({ details: { reason: "WORKBENCH_WRITE_LOCK_BUSY" } });
    expect(await fs.readFile(lockPath, "utf8")).toBe("replacement lock");
  });
});

type WriterMessage = { status: string; code?: string; content?: string };
function nextMessage(child: ChildProcess): Promise<WriterMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Owned Workbench test process did not reply.")); }, 15_000);
    const onMessage = (message: WriterMessage) => { cleanup(); resolve(message); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("error", onError); };
    child.once("message", onMessage); child.once("error", onError);
  });
}

function startWriter(root: string) {
  const child = fork(fileURLToPath(new URL("./workbench-file-revisions-worker.test-fixture.mjs", import.meta.url)), [root], {
    execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, ready: nextMessage(child), closed };
}
