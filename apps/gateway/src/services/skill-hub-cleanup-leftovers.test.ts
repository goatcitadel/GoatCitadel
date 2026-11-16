import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { countRemovalCleanupLeftovers } from "./skill-hub-cleanup-leftovers.js";
import { projectionScratch } from "./skill-hub-runtime-removal.js";

const ROOT = path.join(path.sep, "install", "skills", "extra");

function failure(operationId: string) {
  return { summary: { operationId, code: "projection_scratch_cleanup_failed" } };
}

function sources(present: ReadonlySet<string>, events: Record<string, Array<ReturnType<typeof failure>>>) {
  const listPage = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ items: events[workspaceId] ?? [] }));
  return {
    storage: {
      workspaces: { list: vi.fn(async () => Object.keys(events).map((workspaceId) => ({ workspaceId }))) },
      governanceJourneyEvents: { listPage },
    },
    filesystem: {
      pathKind: vi.fn(async (_root: string, folder: string) => (present.has(folder) ? "directory" : "missing")),
    },
    root: ROOT,
    signal: new AbortController().signal,
  };
}

describe("countRemovalCleanupLeftovers", () => {
  it("counts each removal whose recorded cleanup failure still leaves its folder, once", async () => {
    const left = projectionScratch(ROOT, "operation-left");
    const parts = sources(new Set([left.backup]), {
      "workspace-a": [failure("operation-left"), failure("operation-left"), failure("operation-cleaned")],
      "workspace-b": [failure("operation-gone")],
    });

    await expect(countRemovalCleanupLeftovers(parts as never)).resolves.toBe(1);
    expect(parts.storage.governanceJourneyEvents.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a", actions: ["remove_cleanup_failed"] }),
    );
  });

  it("is none once the folders are gone, and counts a folder it can't read plainly", async () => {
    const cleaned = sources(new Set(), { "workspace-a": [failure("operation-left")] });
    await expect(countRemovalCleanupLeftovers(cleaned as never)).resolves.toBe(0);

    const unreadable = sources(new Set(), { "workspace-a": [failure("operation-link")] });
    unreadable.filesystem.pathKind.mockRejectedValue(new Error("reparse point"));
    await expect(countRemovalCleanupLeftovers(unreadable as never)).resolves.toBe(1);
  });
});
