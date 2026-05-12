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

const workbenchState = {
  sessionId: "session-1",
  worktreeStatus: "ready",
  activeFilePath: "src/index.ts",
  branchName: "coverage",
  baseRef: "main",
};

const workbenchTree = {
  state: workbenchState,
  changedFiles: ["src/index.ts", "README.md"],
  items: [
    { path: "README.md", kind: "file" },
    { path: "src", kind: "directory" },
    { path: "src/index.ts", kind: "file" },
  ],
};

const workbenchDiff = { state: workbenchState, patch: "diff --git" };
const workbenchOutput = { state: workbenchState, output: "ok" };
const workbenchFile = { state: workbenchState, path: "src/index.ts", content: "export const value = 1;" };
const workbenchFileDiff = { state: workbenchState, path: "src/index.ts", patch: "@@ diff" };

let latest: ReturnType<typeof useChatWorkbench> | null = null;
let storage = new Map<string, string>();
const addEventListener = vi.fn();
const removeEventListener = vi.fn();

function installWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
      addEventListener,
      removeEventListener,
    },
  });
}

function Harness(props: { sessionId?: string | null; enabled?: boolean }) {
  latest = useChatWorkbench({
    sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
    enabled: props.enabled ?? true,
  });
  return null;
}

async function flushAsyncEffects(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

function primeSuccessMocks() {
  apiMocks.fetchChatSessionWorkbench.mockResolvedValue({ state: workbenchState });
  apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValue(workbenchTree);
  apiMocks.fetchChatSessionWorkbenchDiff.mockResolvedValue(workbenchDiff);
  apiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValue(workbenchOutput);
  apiMocks.fetchChatSessionWorkbenchFile.mockResolvedValue(workbenchFile);
  apiMocks.fetchChatSessionWorkbenchFileDiff.mockResolvedValue(workbenchFileDiff);
  apiMocks.saveChatSessionWorkbenchFile.mockResolvedValue({ ...workbenchFile, content: "changed" });
  apiMocks.createChatSessionWorkbenchWorktree.mockResolvedValue({ state: workbenchState });
  apiMocks.runChatSessionWorkbenchCommand.mockResolvedValue({
    state: workbenchState,
    output: { state: workbenchState, output: "tests passed" },
  });
  apiMocks.applyChatSessionWorkbenchPatch.mockResolvedValue({
    state: workbenchState,
    output: { state: workbenchState, output: "patch applied" },
    applied: true,
  });
  apiMocks.exportChatSessionWorkbenchPatch.mockResolvedValue({
    state: workbenchState,
    patch: "diff --git exported",
  });
  apiMocks.revertChatSessionWorkbenchFile.mockResolvedValue({
    state: workbenchState,
    output: { state: workbenchState, output: "file reverted" },
  });
  apiMocks.revertChatSessionWorkbenchChanges.mockResolvedValue({
    state: workbenchState,
    output: { state: workbenchState, output: "all reverted" },
  });
}

describe("useChatWorkbench", () => {
  beforeEach(() => {
    latest = null;
    storage = new Map<string, string>();
    addEventListener.mockClear();
    removeEventListener.mockClear();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    hookMocks.useRefreshSubscription.mockReset();
    primeSuccessMocks();
    installWindow();
  });

  it("hydrates workbench state, persisted UI state, selected file, and refresh subscription", async () => {
    storage.set(
      "goatcitadel.chat.workbench.ui.session-1",
      JSON.stringify({ expandedPaths: [" src ", "src"], selectedFilePath: " src/index.ts " }),
    );

    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    expect(apiMocks.fetchChatSessionWorkbench).toHaveBeenCalledWith("session-1");
    expect(apiMocks.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", "src/index.ts");
    expect(latest!.workbenchState).toEqual(workbenchState);
    expect(latest!.workbenchTree).toEqual(workbenchTree);
    expect(latest!.selectedWorkbenchFile).toEqual(workbenchFile);
    expect(latest!.selectedWorkbenchFileDiff).toEqual(workbenchFileDiff);
    expect(latest!.workbenchDraftContent).toBe("export const value = 1;");
    expect(latest!.workbenchExpandedPaths).toEqual(["src"]);
    expect(latest!.workbenchError).toBeNull();
    expect(hookMocks.useRefreshSubscription).toHaveBeenCalledWith(
      "chat",
      expect.any(Function),
      expect.objectContaining({ enabled: true, coalesceMs: 900 }),
    );
  });

  it("saves dirty drafts and protects unsaved work with beforeunload", async () => {
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    act(() => {
      latest!.setWorkbenchDraftContent("changed");
    });
    expect(latest!.hasDirtyWorkbenchDraft).toBe(true);
    expect(addEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    await act(async () => {
      await expect(latest!.saveWorkbenchFile()).resolves.toBe(true);
      await flushAsyncEffects();
    });

    expect(apiMocks.saveChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", {
      path: "src/index.ts",
      content: "changed",
    });
    expect(latest!.workbenchDraftContent).toBe("changed");
    expect(latest!.hasDirtyWorkbenchDraft).toBe(false);
  });

  it("runs worktree, validation, patch, export, and revert operations through the session workbench", async () => {
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    await act(async () => {
      await latest!.createWorkbenchWorktree("main");
      await flushAsyncEffects();
    });
    expect(apiMocks.createChatSessionWorkbenchWorktree).toHaveBeenCalledWith("session-1", { baseRef: "main" });

    await act(async () => {
      await expect(latest!.runWorkbenchValidationCommand({ command: "pnpm", args: ["test"] })).resolves.toBe(true);
      await expect(latest!.applyWorkbenchPatch("diff --git")).resolves.toBe(true);
      await expect(latest!.exportWorkbenchPatch()).resolves.toEqual({
        state: workbenchState,
        patch: "diff --git exported",
      });
      await expect(latest!.revertWorkbenchFile()).resolves.toBe(true);
      await expect(latest!.revertWorkbenchFile("README.md")).resolves.toBe(true);
      await expect(latest!.revertWorkbenchAll()).resolves.toBe(true);
      await flushAsyncEffects();
    });

    expect(apiMocks.runChatSessionWorkbenchCommand).toHaveBeenCalledWith("session-1", {
      command: "pnpm",
      args: ["test"],
    });
    expect(apiMocks.applyChatSessionWorkbenchPatch).toHaveBeenCalledWith("session-1", { patch: "diff --git" });
    expect(apiMocks.exportChatSessionWorkbenchPatch).toHaveBeenCalledWith("session-1");
    expect(apiMocks.revertChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", { path: "src/index.ts" });
    expect(apiMocks.revertChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", { path: "README.md" });
    expect(apiMocks.revertChatSessionWorkbenchChanges).toHaveBeenCalledWith("session-1");
  });

  it("resets when disabled and returns guard values without a session", async () => {
    await act(async () => {
      create(<Harness enabled={false} sessionId={null} />);
      await flushAsyncEffects();
    });

    expect(latest!.workbenchState).toBeNull();
    expect(apiMocks.fetchChatSessionWorkbench).not.toHaveBeenCalled();
    await expect(latest!.openWorkbenchFile("src/index.ts")).resolves.toBe(false);
    await expect(latest!.saveWorkbenchFile()).resolves.toBe(false);
    await expect(latest!.runWorkbenchValidationCommand({ command: "pnpm" })).resolves.toBe(false);
    await expect(latest!.applyWorkbenchPatch("diff --git")).resolves.toBe(false);
    await expect(latest!.applyWorkbenchPatch("   ")).resolves.toBe(false);
    await expect(latest!.exportWorkbenchPatch()).resolves.toBeNull();
    await expect(latest!.revertWorkbenchFile()).resolves.toBe(false);
    await expect(latest!.revertWorkbenchAll()).resolves.toBe(false);
  });

  it("surfaces refresh and action errors only for the active session", async () => {
    apiMocks.fetchChatSessionWorkbench.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    expect(latest!.workbenchError).toBe("refresh failed");

    apiMocks.fetchChatSessionWorkbench.mockResolvedValue({ state: workbenchState });
    await act(async () => {
      await latest!.refreshWorkbench();
      await flushAsyncEffects();
    });
    apiMocks.fetchChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("file failed"));
    await act(async () => {
      await expect(latest!.openWorkbenchFile("missing.ts")).resolves.toBe(false);
    });
    expect(latest!.workbenchError).toBe("file failed");

    act(() => {
      latest!.discardWorkbenchDraft();
    });
    expect(latest!.workbenchError).toBeNull();
  });
});
