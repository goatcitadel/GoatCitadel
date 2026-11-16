import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRemovalCleanupCounter, REMOVAL_CLEANUP_COUNT_TTL_MS } from "./skill-hub-cleanup-leftovers.js";
import { finishAppliedProjection, projectionScratch } from "./skill-hub-runtime-removal.js";

const ROOT = path.join(path.sep, "install", "skills", "extra");

function failure(operationId: string) {
  return { summary: { operationId, code: "projection_scratch_cleanup_failed" } };
}

function reads(present: ReadonlySet<string>, failures: Array<ReturnType<typeof failure>>, rootThere = true) {
  let clock = 1_000;
  const parts = {
    listCleanupFailures: vi.fn(async () => failures),
    rootExists: vi.fn(async () => rootThere),
    readFolderKind: vi.fn(async (folder: string) => (present.has(folder) ? "directory" : "missing")),
    advance: (ms: number) => {
      clock += ms;
    },
  };
  const count = createRemovalCleanupCounter(
    parts.listCleanupFailures,
    parts.rootExists,
    parts.readFolderKind,
    ROOT,
    () => clock,
  );
  return { ...parts, count };
}

describe("createRemovalCleanupCounter", () => {
  it("counts each removal whose recorded cleanup failure still leaves its folder, once", async () => {
    const left = projectionScratch(ROOT, "operation-left");
    const parts = reads(new Set([left.backup]), [
      failure("operation-left"),
      failure("operation-left"),
      failure("operation-cleaned"),
    ]);

    await expect(parts.count()).resolves.toBe(1);
  });

  it("touches no file with no recorded failure, and none with the skills folder missing", async () => {
    const none = reads(new Set(), []);
    await expect(none.count()).resolves.toBe(0);
    expect(none.rootExists).not.toHaveBeenCalled();
    expect(none.readFolderKind).not.toHaveBeenCalled();

    const noRoot = reads(new Set(), [failure("operation-left")], false);
    await expect(noRoot.count()).resolves.toBe(0);
    expect(noRoot.readFolderKind).not.toHaveBeenCalled();
  });

  it("counts a folder it can't read plainly", async () => {
    const unreadable = reads(new Set(), [failure("operation-link")]);
    unreadable.readFolderKind.mockRejectedValue(new Error("reparse point"));
    await expect(unreadable.count()).resolves.toBe(1);
  });

  it("does the work once inside its window, again after it, and at once after a removal's cleanup ran", async () => {
    const parts = reads(new Set(), [failure("operation-left")]);
    await parts.count();
    await parts.count();
    parts.advance(REMOVAL_CLEANUP_COUNT_TTL_MS - 1);
    await parts.count();
    expect(parts.listCleanupFailures).toHaveBeenCalledOnce();

    parts.advance(2);
    await parts.count();
    expect(parts.listCleanupFailures).toHaveBeenCalledTimes(2);

    // A removal's cleanup runs (here it finds nothing to delete): the kept count is read again on the next call.
    const intent = { operationId: "operation-x", operationKind: "remove" } as never;
    await finishAppliedProjection({ removeTreeIfPresent: vi.fn(async () => undefined) } as never, ROOT, {
      intent,
      signal: new AbortController().signal,
      recordFailure: vi.fn(),
    });
    await parts.count();
    expect(parts.listCleanupFailures).toHaveBeenCalledTimes(3);
  });
});
