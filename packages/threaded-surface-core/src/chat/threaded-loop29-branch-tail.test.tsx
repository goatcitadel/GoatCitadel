import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatWorkbench } from "./useChatWorkbench";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  applyChatSessionWorkbenchPatch: vi.fn(),
  createChatSessionWorkbenchWorktree: vi.fn(),
  exportChatSessionWorkbenchPatch: vi.fn(),
  fetchChatSessionWorkbench: vi.fn(),
  fetchChatSessionWorkbenchDiff: vi.fn(),
  fetchChatSessionWorkbenchFile: vi.fn(),
  fetchChatSessionWorkbenchFileDiff: vi.fn(),
  fetchChatSessionWorkbenchOutput: vi.fn(),
  fetchChatSessionWorkbenchTree: vi.fn(),
  revertChatSessionWorkbenchChanges: vi.fn(),
  revertChatSessionWorkbenchFile: vi.fn(),
  runChatSessionWorkbenchCommand: vi.fn(),
  saveChatSessionWorkbenchFile: vi.fn(),
}));

const hookMocks = vi.hoisted(() => ({
  useRefreshSubscription: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  applyChatSessionWorkbenchPatch: apiMocks.applyChatSessionWorkbenchPatch,
  createChatSessionWorkbenchWorktree: apiMocks.createChatSessionWorkbenchWorktree,
  exportChatSessionWorkbenchPatch: apiMocks.exportChatSessionWorkbenchPatch,
  fetchChatSessionWorkbench: apiMocks.fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchDiff: apiMocks.fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchFile: apiMocks.fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchFileDiff: apiMocks.fetchChatSessionWorkbenchFileDiff,
  fetchChatSessionWorkbenchOutput: apiMocks.fetchChatSessionWorkbenchOutput,
  fetchChatSessionWorkbenchTree: apiMocks.fetchChatSessionWorkbenchTree,
  revertChatSessionWorkbenchChanges: apiMocks.revertChatSessionWorkbenchChanges,
  revertChatSessionWorkbenchFile: apiMocks.revertChatSessionWorkbenchFile,
  runChatSessionWorkbenchCommand: apiMocks.runChatSessionWorkbenchCommand,
  saveChatSessionWorkbenchFile: apiMocks.saveChatSessionWorkbenchFile,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: hookMocks.useRefreshSubscription,
}));

let latest: ReturnType<typeof useChatWorkbench> | null = null;
let storage = new Map<string, string>();

const workbenchState = {
  sessionId: "session-loop29",
  worktreeStatus: "ready",
  activeFilePath: "src/nested/file.ts",
  branchName: "coverage",
  baseRef: "main",
};

function Harness(props: { sessionId?: string | null; enabled?: boolean }) {
  latest = useChatWorkbench({
    sessionId: props.sessionId === undefined ? "session-loop29" : props.sessionId,
    enabled: props.enabled ?? true,
  });
  return null;
}

async function flushAsyncEffects(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

describe("threaded workbench loop 29 branch tails", () => {
  beforeEach(() => {
    latest = null;
    storage = new Map();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    hookMocks.useRefreshSubscription.mockReset();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    apiMocks.fetchChatSessionWorkbench.mockResolvedValue({ state: workbenchState });
    apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValue({
      state: workbenchState,
      changedFiles: ["src/nested/file.ts"],
      items: [
        { path: "src", kind: "directory" },
        { path: "src/nested", kind: "directory" },
        { path: "src/nested/file.ts", kind: "file" },
      ],
    });
    apiMocks.fetchChatSessionWorkbenchDiff.mockResolvedValue({ state: workbenchState, patch: "diff --git" });
    apiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValue({ state: workbenchState, output: "" });
    apiMocks.fetchChatSessionWorkbenchFile.mockResolvedValue({
      state: workbenchState,
      path: "src/nested/file.ts",
      content: "export const value = 1;",
    });
    apiMocks.fetchChatSessionWorkbenchFileDiff.mockResolvedValue({ state: workbenchState, path: "src/nested/file.ts" });
  });

  it("derives expanded ancestor paths from changed and selected files when persisted paths are omitted", async () => {
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    expect(latest?.workbenchExpandedPaths).toEqual(["src", "src/nested"]);
    expect(latest?.selectedWorkbenchFile?.path).toBe("src/nested/file.ts");
    expect(apiMocks.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-loop29", "src/nested/file.ts");
  });

  it("persists blank selected-file updates as omitted values without a session", async () => {
    await act(async () => {
      create(<Harness sessionId={null} enabled={false} />);
      await flushAsyncEffects();
    });

    act(() => {
      latest?.setWorkbenchExpandedPaths([" z ", "", "a", "z"]);
    });

    expect(storage.size).toBe(0);
    act(() => {
      latest?.discardWorkbenchDraft();
    });
    expect(latest?.workbenchDraftContent).toBe("");
    await expect(latest?.openWorkbenchFile("   ")).resolves.toBe(false);
  });
});
