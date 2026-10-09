import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedCodeModeSource, resolveEngineeringLearningSourceRoot } from "./engineering-learning-sources.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eng-sources-")));
  roots.push(root);
  return root;
}
function owners(rootDir: string, overrides: Record<string, unknown> = {}) {
  return {
    rootDir,
    workspaceDir: "workspace",
    storage: {
      chatSessionWorkbench: { get: vi.fn(async () => undefined) },
      chatSessionProjects: { get: vi.fn(async () => undefined) },
      chatProjects: { find: vi.fn(async () => undefined) },
      ...overrides,
    },
  } as never;
}

describe("readVerifiedCodeModeSource", () => {
  it("returns the run with the evidence its current verification names, scoped to the workspace", async () => {
    const run = { runId: "run-1", verification: { evidenceId: "ev-2" } };
    const capabilities = {
      getCodeModeRunInScope: vi.fn(async () => run),
      listCodeModeRunVerificationEvidence: vi.fn(async () => [{ evidenceId: "ev-1" }, { evidenceId: "ev-2" }]),
    };
    await expect(readVerifiedCodeModeSource(capabilities as never, "run-1", "ws-1")).resolves.toEqual({
      run,
      evidence: { evidenceId: "ev-2" },
    });
    expect(capabilities.getCodeModeRunInScope).toHaveBeenCalledWith("run-1", { workspaceId: "ws-1" });
    expect(capabilities.listCodeModeRunVerificationEvidence).toHaveBeenCalledWith("run-1", { workspaceId: "ws-1" });
  });

  it("fails closed when the named evidence is not recorded", async () => {
    const capabilities = {
      getCodeModeRunInScope: vi.fn(async () => ({ runId: "run-1", verification: { evidenceId: "ev-9" } })),
      listCodeModeRunVerificationEvidence: vi.fn(async () => [{ evidenceId: "ev-1" }]),
    };
    await expect(readVerifiedCodeModeSource(capabilities as never, "run-1", "ws-1")).rejects.toThrow(
      "No current verification evidence exists for this source run.",
    );
  });
});

describe("resolveEngineeringLearningSourceRoot", () => {
  it("uses the session's ready worktree inside the root", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "wt"));
    const resolved = await resolveEngineeringLearningSourceRoot(
      owners(root, {
        chatSessionWorkbench: { get: vi.fn(async () => ({ worktreeStatus: "ready", worktreePath: "./wt" })) },
      }),
      { sessionId: "s-1" },
    );
    expect(resolved).toBe(path.join(root, "wt"));
  });

  it("never follows an outside-root worktree and falls back to the project path", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "workspace", "proj"), { recursive: true });
    const resolved = await resolveEngineeringLearningSourceRoot(
      owners(root, {
        chatSessionWorkbench: { get: vi.fn(async () => ({ worktreeStatus: "ready", worktreePath: "[outside-root]" })) },
        chatSessionProjects: { get: vi.fn(async () => ({ projectId: "p-1" })) },
        chatProjects: { find: vi.fn(async () => ({ workspacePath: "proj" })) },
      }),
      { sessionId: "s-1" },
    );
    // Not a Git checkout: the project path itself is the source root.
    expect(resolved).toBe(path.join(root, "workspace", "proj"));
  });

  it("returns undefined when neither a worktree nor a project is known", async () => {
    await expect(
      resolveEngineeringLearningSourceRoot(owners(tempRoot()), { sessionId: "s-1" }),
    ).resolves.toBeUndefined();
  });
});
