import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("worktree manager coverage", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_, __, ___, callback) => {
      callback?.(null, "", "");
      return {} as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates worktrees and removes them without force", async () => {
    await import("./index.js");
    const { WorktreeManager } = await import("./worktree-manager.js");
    const manager = new WorktreeManager({
      repoRoot: "/repo/root",
      worktreesRoot: "/repo/worktrees",
    });

    const createdPath = await manager.create("wt-1", "main");
    await manager.remove(createdPath);

    const expectedPath = path.join("/repo/worktrees", "wt-1");
    const expectedResolvedPath = path.resolve(expectedPath);
    expect(createdPath).toBe(expectedPath);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("git");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["worktree", "add", "--detach", expectedPath, "main"]);
    expect(execFileMock.mock.calls[1]?.[0]).toBe("git");
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(["worktree", "remove", expectedResolvedPath]);
  });
});
