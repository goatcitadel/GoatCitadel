import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { countRemovalCleanupLeftovers, removalCleanupFailureQuery } from "./skill-hub-cleanup-leftovers.js";
import { projectionScratch } from "./skill-hub-runtime-removal.js";

const ROOT = path.join(path.sep, "install", "skills", "extra");

function failure(operationId: string) {
  return { summary: { operationId, code: "projection_scratch_cleanup_failed" } };
}

function reads(present: ReadonlySet<string>, events: Record<string, Array<ReturnType<typeof failure>>>) {
  return {
    listWorkspaceIds: vi.fn(async () => Object.keys(events)),
    listCleanupFailures: vi.fn(async (workspaceId: string) => events[workspaceId] ?? []),
    readFolderKind: vi.fn(async (folder: string) => (present.has(folder) ? "directory" : "missing")),
  };
}

const count = (parts: ReturnType<typeof reads>) =>
  countRemovalCleanupLeftovers(parts.listWorkspaceIds, parts.listCleanupFailures, parts.readFolderKind, ROOT);

describe("countRemovalCleanupLeftovers", () => {
  it("counts each removal whose recorded cleanup failure still leaves its folder, once", async () => {
    const left = projectionScratch(ROOT, "operation-left");
    const parts = reads(new Set([left.backup]), {
      "workspace-a": [failure("operation-left"), failure("operation-left"), failure("operation-cleaned")],
      "workspace-b": [failure("operation-gone")],
    });

    await expect(count(parts)).resolves.toBe(1);
    expect(parts.listCleanupFailures).toHaveBeenCalledWith("workspace-a");
    expect(parts.listCleanupFailures).toHaveBeenCalledWith("workspace-b");
  });

  it("is none once the folders are gone, and counts a folder it can't read plainly", async () => {
    await expect(count(reads(new Set(), { "workspace-a": [failure("operation-left")] }))).resolves.toBe(0);

    const unreadable = reads(new Set(), { "workspace-a": [failure("operation-link")] });
    unreadable.readFolderKind.mockRejectedValue(new Error("reparse point"));
    await expect(count(unreadable)).resolves.toBe(1);
  });

  it("reads only the removal cleanup failures Skill Hub records", () => {
    expect(removalCleanupFailureQuery("workspace-a")).toEqual({
      workspaceId: "workspace-a",
      eventTypes: ["skill_hub_lifecycle"],
      actions: ["remove_cleanup_failed"],
      limit: 100,
    });
  });
});
