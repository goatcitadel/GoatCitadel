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

  it("creates worktrees and removes them without forcing away late edits", async () => {
    await import("./index.js");
    const { WorktreeManager } = await import("./worktree-manager.js");
    const manager = new WorktreeManager({
      repoRoot: "/repo/root",
      worktreesRoot: "/repo/worktrees",
    });

    const createdPath = await manager.create("wt-1", "main");
    await manager.remove(createdPath);

    const expectedPath = path.resolve("/repo/worktrees", "wt-1");
    const expectedResolvedPath = path.resolve(expectedPath);
    expect(createdPath).toBe(expectedPath);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("git");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["worktree", "add", "--detach", expectedPath, "main"]);
    expect(execFileMock.mock.calls[1]?.[0]).toBe("git");
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(["worktree", "remove", expectedResolvedPath]);
  });

  it("prunes stale worktree metadata so .git/worktrees entries are not orphaned", async () => {
    const { WorktreeManager } = await import("./worktree-manager.js");
    const manager = new WorktreeManager({
      repoRoot: "/repo/root",
      worktreesRoot: "/repo/worktrees",
    });

    await manager.prune();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("git");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["worktree", "prune"]);
  });

  it("runs every git worktree command with a scrubbed, prompt-free environment", async () => {
    vi.stubEnv("GOATCITADEL_WT_UNIT_TOKEN", "unit-secret-value");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/agent.sock");
    vi.stubEnv("GOATCITADEL_WT_UNIT_API_KEY", "operator-opted-in");
    try {
      const { WorktreeManager } = await import("./worktree-manager.js");
      const manager = new WorktreeManager({
        repoRoot: "/repo/root",
        worktreesRoot: "/repo/worktrees",
        spawnEnvPassthrough: ["GOATCITADEL_WT_UNIT_API_KEY"],
      });

      await manager.remove(await manager.create("wt-env", "main"));
      await manager.prune();

      expect(execFileMock).toHaveBeenCalledTimes(3);
      for (const call of execFileMock.mock.calls) {
        const options = call[2] as { cwd: string; env: Record<string, string> };
        expect(options.cwd).toBe("/repo/root");
        expect(options.env.GOATCITADEL_WT_UNIT_TOKEN).toBeUndefined();
        expect(options.env).toMatchObject({
          GIT_TERMINAL_PROMPT: "0",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          GOATCITADEL_WT_UNIT_API_KEY: "operator-opted-in",
        });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects worktree ids that resolve outside the configured root", async () => {
    const { WorktreeManager } = await import("./worktree-manager.js");
    const manager = new WorktreeManager({
      repoRoot: "/repo/root",
      worktreesRoot: "/repo/worktrees",
    });

    await expect(manager.create("../outside", "main")).rejects.toThrow("outside worktrees root");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
