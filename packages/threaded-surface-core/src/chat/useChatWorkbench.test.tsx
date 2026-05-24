import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeWorkbenchActionError, useChatWorkbench } from "./useChatWorkbench";

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
  runChatSessionWorkbenchFileOperation: vi.fn(),
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
  runChatSessionWorkbenchFileOperation: apiMocks.runChatSessionWorkbenchFileOperation,
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

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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
  apiMocks.runChatSessionWorkbenchFileOperation.mockResolvedValue({
    state: { ...workbenchState, activeFilePath: "src/new.ts" },
    operation: "create_file",
    path: "src/new.ts",
    changedFiles: ["src/new.ts"],
    tree: {
      ...workbenchTree,
      changedFiles: ["src/new.ts"],
      items: [...workbenchTree.items, { path: "src/new.ts", kind: "file" }],
    },
    output: { state: workbenchState, output: "Created file src/new.ts." },
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

  it("normalizes workbench action error causes", () => {
    expect(describeWorkbenchActionError(new Error("specific failure"), "fallback")).toBe("specific failure");
    expect(describeWorkbenchActionError("string failure", "fallback")).toBe("fallback");
    expect(describeWorkbenchActionError(null, "fallback")).toBe("fallback");
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
      await expect(
        latest!.runWorkbenchFileOperation({ operation: "create_file", path: "src/new.ts" }),
      ).resolves.toBe(true);
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
    expect(apiMocks.runChatSessionWorkbenchFileOperation).toHaveBeenCalledWith("session-1", {
      operation: "create_file",
      path: "src/new.ts",
    });
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
    await expect(latest!.refreshWorkbench()).resolves.toBeUndefined();
    await expect(latest!.createWorkbenchWorktree("main")).resolves.toBeUndefined();
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

    apiMocks.fetchChatSessionWorkbenchFile.mockResolvedValueOnce({
      ...workbenchFile,
      path: "README.md",
      content: "# Readme",
    });
    apiMocks.fetchChatSessionWorkbenchFileDiff.mockResolvedValueOnce({
      ...workbenchFileDiff,
      path: "README.md",
      patch: "@@ readme",
    });
    await act(async () => {
      await expect(latest!.openWorkbenchFile("README.md")).resolves.toBe(true);
      await flushAsyncEffects();
    });
    expect(latest!.workbenchError).toBeNull();

    act(() => {
      latest!.discardWorkbenchDraft();
    });
    expect(latest!.workbenchError).toBeNull();
  });

  it("handles invalid storage, non-ready worktrees, missing candidates, and candidate fallback", async () => {
    storage.set("goatcitadel.chat.workbench.ui.session-1", "{not-json");
    apiMocks.fetchChatSessionWorkbench.mockResolvedValueOnce({
      state: { ...workbenchState, worktreeStatus: "allocating" },
    });
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    expect(latest!.workbenchTree).toBeNull();
    expect(latest!.selectedWorkbenchFile).toBeNull();
    expect(latest!.workbenchDraftContent).toBe("");

    apiMocks.fetchChatSessionWorkbench.mockResolvedValue({ state: workbenchState });
    apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValueOnce({
      state: workbenchState,
      changedFiles: [],
      items: [{ path: "src", kind: "directory" }],
    });
    apiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValueOnce({
      state: { ...workbenchState, activeFilePath: "" },
      output: "",
    });
    await act(async () => {
      create(<Harness sessionId="session-no-file" />);
      await flushAsyncEffects();
    });
    expect(latest!.selectedWorkbenchFile).toBeNull();

    apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValueOnce({
      state: workbenchState,
      changedFiles: ["bad.ts", "src/index.ts"],
      items: [
        { path: "bad.ts", kind: "file" },
        { path: "src/index.ts", kind: "file" },
      ],
    });
    apiMocks.fetchChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("bad candidate"));
    apiMocks.fetchChatSessionWorkbenchFile.mockResolvedValueOnce(workbenchFile);
    await act(async () => {
      create(<Harness sessionId="session-fallback" />);
      await flushAsyncEffects(6);
    });
    expect(apiMocks.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-fallback", "bad.ts");
    expect(apiMocks.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-fallback", "src/index.ts");
    expect(latest!.selectedWorkbenchFile?.path).toBe("src/index.ts");
  });

  it("normalizes sparse persisted UI state without selecting a blank file path", async () => {
    storage.set(
      "goatcitadel.chat.workbench.ui.session-1",
      JSON.stringify({ expandedPaths: "not-an-array", selectedFilePath: "   " }),
    );
    apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValueOnce({
      state: { ...workbenchState, activeFilePath: "" },
      changedFiles: [],
      items: [{ path: "README.md", kind: "file" }],
    });
    apiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValueOnce({
      state: { ...workbenchState, activeFilePath: "" },
      output: "",
    });

    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    expect(latest!.workbenchExpandedPaths).toEqual(["src"]);
    expect(latest!.selectedWorkbenchFile?.path).toBe("src/index.ts");
  });

  it("clears file state and reports the last candidate error when all file candidates fail", async () => {
    apiMocks.fetchChatSessionWorkbenchTree.mockResolvedValueOnce({
      state: workbenchState,
      changedFiles: ["bad.ts", "worse.ts"],
      items: [
        { path: "bad.ts", kind: "file" },
        { path: "worse.ts", kind: "file" },
      ],
    });
    apiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValueOnce({
      state: { ...workbenchState, activeFilePath: "bad.ts" },
      output: "",
    });
    apiMocks.fetchChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("bad candidate"));
    apiMocks.fetchChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("worse candidate"));

    await act(async () => {
      create(<Harness sessionId="session-all-candidates-fail" />);
      await flushAsyncEffects(8);
    });

    expect(latest!.selectedWorkbenchFile).toBeNull();
    expect(latest!.selectedWorkbenchFileDiff).toBeNull();
    expect(latest!.workbenchDraftContent).toBe("");
    expect(latest!.workbenchError).toBe("worse candidate");
  });

  it("surfaces action failures and works without a browser storage object", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });
    expect(latest!.workbenchExpandedPaths).toEqual(["src"]);

    apiMocks.saveChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("save failed"));
    await act(async () => {
      latest!.setWorkbenchDraftContent("changed again");
      await expect(latest!.saveWorkbenchFile()).resolves.toBe(false);
    });
    expect(latest!.workbenchError).toBe("save failed");

    apiMocks.createChatSessionWorkbenchWorktree.mockRejectedValueOnce(new Error("create failed"));
    await act(async () => {
      await latest!.createWorkbenchWorktree("feature");
    });
    expect(latest!.workbenchError).toBe("create failed");

    apiMocks.runChatSessionWorkbenchCommand.mockRejectedValueOnce(new Error("command failed"));
    apiMocks.applyChatSessionWorkbenchPatch.mockRejectedValueOnce(new Error("patch failed"));
    apiMocks.exportChatSessionWorkbenchPatch.mockRejectedValueOnce(new Error("export failed"));
    apiMocks.revertChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("revert file failed"));
    apiMocks.revertChatSessionWorkbenchChanges.mockRejectedValueOnce(new Error("revert all failed"));
    await act(async () => {
      await expect(latest!.runWorkbenchValidationCommand({ command: "pnpm test" })).resolves.toBe(false);
      await expect(latest!.applyWorkbenchPatch("diff --git")).resolves.toBe(false);
      await expect(latest!.exportWorkbenchPatch()).resolves.toBeNull();
      await expect(latest!.revertWorkbenchFile("src/index.ts")).resolves.toBe(false);
      await expect(latest!.revertWorkbenchAll()).resolves.toBe(false);
    });
    expect(latest!.workbenchError).toBe("revert all failed");
  });

  it("persists sorted UI state, executes refresh subscriptions, and handles beforeunload events", async () => {
    await act(async () => {
      create(<Harness />);
      await flushAsyncEffects();
    });

    act(() => {
      latest!.setWorkbenchExpandedPaths([" z ", "a", "z"]);
      latest!.setWorkbenchDraftContent("dirty");
    });
    expect(JSON.parse(storage.get("goatcitadel.chat.workbench.ui.session-1") ?? "{}")).toEqual(
      expect.objectContaining({ expandedPaths: ["a", "z"] }),
    );
    const beforeUnloadHandler = addEventListener.mock.calls.find((call) => call[0] === "beforeunload")?.[1] as
      | ((event: BeforeUnloadEvent) => void)
      | undefined;
    const event = { preventDefault: vi.fn(), returnValue: "keep" } as unknown as BeforeUnloadEvent;
    beforeUnloadHandler?.(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe("");

    const refreshCallback = hookMocks.useRefreshSubscription.mock.calls.at(-1)?.[1] as
      | (() => Promise<void>)
      | undefined;
    await act(async () => {
      await refreshCallback?.();
      await flushAsyncEffects();
    });
    expect(apiMocks.fetchChatSessionWorkbench).toHaveBeenCalled();
  });

  it("keeps stale async completions from mutating a newer session", async () => {
    let resolveInitialWorkbench!: (value: unknown) => void;
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitialWorkbench = resolve;
      }),
    );
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness sessionId="session-stale-a" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-stale-b" />);
      resolveInitialWorkbench({ state: workbenchState });
      await flushAsyncEffects(8);
    });
    expect(latest!.workbenchState?.sessionId).toBe("session-1");

    let resolveTree!: (value: unknown) => void;
    apiMocks.fetchChatSessionWorkbench.mockResolvedValueOnce({ state: workbenchState });
    apiMocks.fetchChatSessionWorkbenchTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTree = resolve;
      }),
    );
    await act(async () => {
      renderer.update(<Harness sessionId="session-stale-tree-a" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-stale-tree-b" />);
      resolveTree(workbenchTree);
      await flushAsyncEffects(8);
    });
    expect(latest!.workbenchError).toBeNull();

    let resolveFile!: (value: unknown) => void;
    apiMocks.fetchChatSessionWorkbenchFile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFile = resolve;
      }),
    );
    let openPromise!: Promise<boolean>;
    await act(async () => {
      openPromise = latest!.openWorkbenchFile("src/index.ts");
      renderer.update(<Harness sessionId="session-file-stale" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      resolveFile(workbenchFile);
      await expect(openPromise).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    let resolveRefreshWorkbench!: (value: unknown) => void;
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefreshWorkbench = resolve;
      }),
    );
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = latest!.refreshWorkbench();
      renderer.update(<Harness sessionId="session-refresh-stale" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      resolveRefreshWorkbench({ state: workbenchState });
      await refreshPromise;
      await flushAsyncEffects(8);
    });

    let resolveRefreshTree!: (value: unknown) => void;
    apiMocks.fetchChatSessionWorkbench.mockResolvedValueOnce({ state: workbenchState });
    apiMocks.fetchChatSessionWorkbenchTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefreshTree = resolve;
      }),
    );
    let treeRefreshPromise!: Promise<void>;
    await act(async () => {
      treeRefreshPromise = latest!.refreshWorkbench();
      renderer.update(<Harness sessionId="session-refresh-tree-stale" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      resolveRefreshTree(workbenchTree);
      await treeRefreshPromise;
      await flushAsyncEffects(8);
    });
  });

  it("ignores stale mutating action completions after the active session changes", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness sessionId="session-action-a" />);
      await flushAsyncEffects();
    });

    act(() => {
      latest!.setWorkbenchDraftContent("changed");
    });

    const save = deferred<typeof workbenchFile>();
    apiMocks.saveChatSessionWorkbenchFile.mockReturnValueOnce(save.promise);
    let saveResult!: Promise<boolean>;
    await act(async () => {
      saveResult = latest!.saveWorkbenchFile();
      renderer.update(<Harness sessionId="session-action-b" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      save.resolve({ ...workbenchFile, content: "changed" });
      await expect(saveResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const createWorktree = deferred<{ state: typeof workbenchState }>();
    apiMocks.createChatSessionWorkbenchWorktree.mockReturnValueOnce(createWorktree.promise);
    let createResult!: Promise<void>;
    await act(async () => {
      createResult = latest!.createWorkbenchWorktree("main");
      renderer.update(<Harness sessionId="session-action-c" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      createWorktree.resolve({ state: workbenchState });
      await createResult;
      await flushAsyncEffects(8);
    });

    const run = deferred<{ state: typeof workbenchState; output: typeof workbenchOutput }>();
    apiMocks.runChatSessionWorkbenchCommand.mockReturnValueOnce(run.promise);
    let runResult!: Promise<boolean>;
    await act(async () => {
      runResult = latest!.runWorkbenchValidationCommand({ command: "pnpm" });
      renderer.update(<Harness sessionId="session-action-d" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      run.resolve({ state: workbenchState, output: workbenchOutput });
      await expect(runResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const patch = deferred<{ state: typeof workbenchState; output: typeof workbenchOutput; applied: boolean }>();
    apiMocks.applyChatSessionWorkbenchPatch.mockReturnValueOnce(patch.promise);
    let patchResult!: Promise<boolean>;
    await act(async () => {
      patchResult = latest!.applyWorkbenchPatch("diff --git");
      renderer.update(<Harness sessionId="session-action-e" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      patch.resolve({ state: workbenchState, output: workbenchOutput, applied: true });
      await expect(patchResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const exported = deferred<{ state: typeof workbenchState; patch: string }>();
    apiMocks.exportChatSessionWorkbenchPatch.mockReturnValueOnce(exported.promise);
    let exportResult!: Promise<{ state: typeof workbenchState; patch: string } | null>;
    await act(async () => {
      exportResult = latest!.exportWorkbenchPatch();
      renderer.update(<Harness sessionId="session-action-f" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      exported.resolve({ state: workbenchState, patch: "diff --git" });
      await expect(exportResult).resolves.toBeNull();
      await flushAsyncEffects(8);
    });

    const revertFile = deferred<{ state: typeof workbenchState; output: typeof workbenchOutput }>();
    apiMocks.revertChatSessionWorkbenchFile.mockReturnValueOnce(revertFile.promise);
    let revertFileResult!: Promise<boolean>;
    await act(async () => {
      revertFileResult = latest!.revertWorkbenchFile("src/index.ts");
      renderer.update(<Harness sessionId="session-action-g" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      revertFile.resolve({ state: workbenchState, output: workbenchOutput });
      await expect(revertFileResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const revertAll = deferred<{ state: typeof workbenchState; output: typeof workbenchOutput }>();
    apiMocks.revertChatSessionWorkbenchChanges.mockReturnValueOnce(revertAll.promise);
    let revertAllResult!: Promise<boolean>;
    await act(async () => {
      revertAllResult = latest!.revertWorkbenchAll();
      renderer.update(<Harness sessionId="session-action-h" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      revertAll.resolve({ state: workbenchState, output: workbenchOutput });
      await expect(revertAllResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });
  });

  it("ignores mutating action refresh completions after the active session changes", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness sessionId="session-refresh-action-a" />);
      await flushAsyncEffects();
    });

    act(() => {
      latest!.setWorkbenchDraftContent("changed");
    });

    const saveTree = deferred<typeof workbenchTree>();
    apiMocks.fetchChatSessionWorkbenchTree.mockReturnValueOnce(saveTree.promise);
    let saveResult!: Promise<boolean>;
    await act(async () => {
      saveResult = latest!.saveWorkbenchFile();
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-refresh-action-b" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      saveTree.resolve(workbenchTree);
      await expect(saveResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const runRefresh = deferred<{ state: typeof workbenchState }>();
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(runRefresh.promise);
    let runResult!: Promise<boolean>;
    await act(async () => {
      runResult = latest!.runWorkbenchValidationCommand({ command: "pnpm" });
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-refresh-action-c" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      runRefresh.resolve({ state: workbenchState });
      await expect(runResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const patchRefresh = deferred<{ state: typeof workbenchState }>();
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(patchRefresh.promise);
    let patchResult!: Promise<boolean>;
    await act(async () => {
      patchResult = latest!.applyWorkbenchPatch("diff --git");
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-refresh-action-d" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      patchRefresh.resolve({ state: workbenchState });
      await expect(patchResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const revertFileRefresh = deferred<{ state: typeof workbenchState }>();
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(revertFileRefresh.promise);
    let revertFileResult!: Promise<boolean>;
    await act(async () => {
      revertFileResult = latest!.revertWorkbenchFile("src/index.ts");
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-refresh-action-e" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      revertFileRefresh.resolve({ state: workbenchState });
      await expect(revertFileResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });

    const revertAllRefresh = deferred<{ state: typeof workbenchState }>();
    apiMocks.fetchChatSessionWorkbench.mockReturnValueOnce(revertAllRefresh.promise);
    let revertAllResult!: Promise<boolean>;
    await act(async () => {
      revertAllResult = latest!.revertWorkbenchAll();
      await flushAsyncEffects();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-refresh-action-f" />);
      await flushAsyncEffects();
    });
    await act(async () => {
      revertAllRefresh.resolve({ state: workbenchState });
      await expect(revertAllResult).resolves.toBe(false);
      await flushAsyncEffects(8);
    });
    await act(async () => {
      renderer.unmount();
      await flushAsyncEffects();
    });
  });

  it("covers guard writes and missing-session expansion helpers", async () => {
    await act(async () => {
      create(<Harness sessionId={null} enabled={false} />);
      await flushAsyncEffects();
    });
    storage.clear();
    const existingStorageSize = storage.size;
    act(() => {
      latest!.setWorkbenchExpandedPaths(["src"]);
    });
    expect(storage.size).toBe(existingStorageSize);
  });
});
