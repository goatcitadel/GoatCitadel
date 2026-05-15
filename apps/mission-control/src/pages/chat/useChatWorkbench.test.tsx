import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatWorkbench } from "./useChatWorkbench";

const chatApiMocks = vi.hoisted(() => ({
  createChatSessionWorkbenchWorktree: vi.fn(),
  fetchChatSessionWorkbench: vi.fn(),
  fetchChatSessionWorkbenchDiff: vi.fn(),
  fetchChatSessionWorkbenchFile: vi.fn(),
  fetchChatSessionWorkbenchFileDiff: vi.fn(),
  fetchChatSessionWorkbenchOutput: vi.fn(),
  fetchChatSessionWorkbenchTree: vi.fn(),
  saveChatSessionWorkbenchFile: vi.fn(),
}));

const refreshSubscriptionMocks = vi.hoisted(() => ({
  callback: null as (() => Promise<void> | void) | null,
  options: null as { enabled?: boolean; coalesceMs?: number; staleMs?: number; pollIntervalMs?: number } | null,
  topic: null as string | null,
}));

vi.mock("../../api/chat", () => ({
  createChatSessionWorkbenchWorktree: chatApiMocks.createChatSessionWorkbenchWorktree,
  fetchChatSessionWorkbench: chatApiMocks.fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchDiff: chatApiMocks.fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchFile: chatApiMocks.fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchFileDiff: chatApiMocks.fetchChatSessionWorkbenchFileDiff,
  fetchChatSessionWorkbenchOutput: chatApiMocks.fetchChatSessionWorkbenchOutput,
  fetchChatSessionWorkbenchTree: chatApiMocks.fetchChatSessionWorkbenchTree,
  saveChatSessionWorkbenchFile: chatApiMocks.saveChatSessionWorkbenchFile,
}));

vi.mock("../../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn((topic, callback, options) => {
    refreshSubscriptionMocks.topic = topic;
    refreshSubscriptionMocks.callback = callback;
    refreshSubscriptionMocks.options = options ?? null;
  }),
}));

let latest: ReturnType<typeof useChatWorkbench> | null = null;

function installWindowMock() {
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function workbenchState(sessionId = "session-1", activeFilePath = "src/app.ts") {
  return {
    sessionId,
    worktreeStatus: "ready",
    baseRef: "main",
    activeFilePath,
  };
}

function readyTree(changedFiles = ["src/app.ts"]) {
  return {
    state: workbenchState(),
    changedFiles,
    items: [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "src/components", kind: "directory" },
      { path: "src/components/Card.tsx", kind: "file" },
    ],
  };
}

function Harness(props: { sessionId?: string | null; enabled?: boolean }) {
  latest = useChatWorkbench({
    sessionId: props.sessionId ?? "session-1",
    enabled: props.enabled ?? true,
  });
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useChatWorkbench", () => {
  beforeEach(() => {
    latest = null;
    installWindowMock();
    window.localStorage.clear();
    refreshSubscriptionMocks.callback = null;
    refreshSubscriptionMocks.options = null;
    refreshSubscriptionMocks.topic = null;
    for (const mock of Object.values(chatApiMocks)) {
      mock.mockReset();
    }
    chatApiMocks.fetchChatSessionWorkbench.mockResolvedValue({ state: workbenchState() });
    chatApiMocks.fetchChatSessionWorkbenchTree.mockResolvedValue(readyTree());
    chatApiMocks.fetchChatSessionWorkbenchDiff.mockResolvedValue({ state: workbenchState(), files: [] });
    chatApiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValue({
      state: workbenchState("session-1", "src/app.ts"),
      stdout: "",
      stderr: "",
      exitCode: null,
    });
    chatApiMocks.fetchChatSessionWorkbenchFile.mockResolvedValue({
      state: workbenchState(),
      path: "src/app.ts",
      content: "original content",
      language: "typescript",
    });
    chatApiMocks.fetchChatSessionWorkbenchFileDiff.mockResolvedValue({
      state: workbenchState(),
      path: "src/app.ts",
      patch: "@@ -1 +1 @@",
    });
    chatApiMocks.saveChatSessionWorkbenchFile.mockResolvedValue({
      state: workbenchState(),
      path: "src/app.ts",
      content: "edited content",
      language: "typescript",
    });
    chatApiMocks.createChatSessionWorkbenchWorktree.mockResolvedValue({ state: workbenchState() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the active workbench file and persists default expanded paths", async () => {
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    expect(chatApiMocks.fetchChatSessionWorkbench).toHaveBeenCalledWith("session-1");
    expect(chatApiMocks.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", "src/app.ts");
    expect(latest?.selectedWorkbenchFile?.path).toBe("src/app.ts");
    expect(latest?.workbenchDraftContent).toBe("original content");
    expect(latest?.workbenchExpandedPaths).toEqual(["src"]);
    expect(JSON.parse(window.localStorage.getItem("goatcitadel.chat.workbench.ui.session-1") ?? "{}")).toEqual({
      expandedPaths: ["src"],
      selectedFilePath: "src/app.ts",
    });
    expect(refreshSubscriptionMocks.topic).toBe("chat");
    expect(refreshSubscriptionMocks.options).toMatchObject({
      enabled: true,
      coalesceMs: 900,
      staleMs: 20_000,
      pollIntervalMs: 15_000,
    });
  });

  it("preserves a dirty draft when refresh reloads the same selected file", async () => {
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    act(() => {
      latest?.setWorkbenchDraftContent("local edit");
    });
    chatApiMocks.fetchChatSessionWorkbenchFile.mockResolvedValueOnce({
      state: workbenchState(),
      path: "src/app.ts",
      content: "server edit",
      language: "typescript",
    });

    await act(async () => {
      await latest?.refreshWorkbench();
    });

    expect(latest?.selectedWorkbenchFile?.content).toBe("server edit");
    expect(latest?.workbenchDraftContent).toBe("local edit");
    expect(latest?.hasDirtyWorkbenchDraft).toBe(true);
  });

  it("warns before unload while a workbench draft is dirty and removes the guard when discarded", async () => {
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    act(() => {
      latest?.setWorkbenchDraftContent("local edit");
    });

    const addEventListener = window.addEventListener as ReturnType<typeof vi.fn>;
    const removeEventListener = window.removeEventListener as ReturnType<typeof vi.fn>;
    const beforeUnloadHandler = addEventListener.mock.calls.find(([eventName]) => eventName === "beforeunload")?.[1] as
      | ((event: BeforeUnloadEvent) => void)
      | undefined;
    const event = {
      preventDefault: vi.fn(),
      returnValue: undefined as string | undefined,
    } as unknown as BeforeUnloadEvent;

    expect(beforeUnloadHandler).toBeDefined();
    beforeUnloadHandler?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe("");

    await act(async () => {
      latest?.discardWorkbenchDraft();
    });

    expect(removeEventListener).toHaveBeenCalledWith("beforeunload", beforeUnloadHandler);
    expect(latest?.hasDirtyWorkbenchDraft).toBe(false);
  });

  it("falls back through file candidates and reports a load error when every candidate fails", async () => {
    window.localStorage.setItem(
      "goatcitadel.chat.workbench.ui.session-1",
      JSON.stringify({
        expandedPaths: ["src/components", "src"],
        selectedFilePath: "src/components/Card.tsx",
      }),
    );
    chatApiMocks.fetchChatSessionWorkbenchFile
      .mockRejectedValueOnce(new Error("stored file missing"))
      .mockRejectedValueOnce(new Error("active file missing"));
    chatApiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValueOnce({
      state: workbenchState("session-1", "src/app.ts"),
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    expect(chatApiMocks.fetchChatSessionWorkbenchFile).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "src/components/Card.tsx",
    );
    expect(chatApiMocks.fetchChatSessionWorkbenchFile).toHaveBeenNthCalledWith(2, "session-1", "src/app.ts");
    expect(latest?.selectedWorkbenchFile).toBeNull();
    expect(latest?.workbenchDraftContent).toBe("");
    expect(latest?.workbenchError).toBe("active file missing");
    expect(latest?.workbenchExpandedPaths).toEqual(["src", "src/components"]);
  });

  it("clears file state when a ready workbench has no selectable file candidates", async () => {
    chatApiMocks.fetchChatSessionWorkbenchTree.mockResolvedValueOnce({
      state: workbenchState(),
      changedFiles: ["missing.ts"],
      items: [{ path: "src", kind: "directory" }],
    });
    chatApiMocks.fetchChatSessionWorkbenchOutput.mockResolvedValueOnce({
      state: workbenchState("session-1", "missing.ts"),
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    expect(latest?.workbenchTree?.items).toEqual([{ path: "src", kind: "directory" }]);
    expect(chatApiMocks.fetchChatSessionWorkbenchFile).not.toHaveBeenCalled();
    expect(latest?.selectedWorkbenchFile).toBeNull();
    expect(latest?.workbenchDraftContent).toBe("");
    expect(latest?.workbenchError).toBeNull();
  });

  it("surfaces refresh, load, save, and create-worktree errors without leaving busy flags stuck", async () => {
    chatApiMocks.fetchChatSessionWorkbench.mockRejectedValueOnce(new Error("gateway unavailable"));
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    expect(latest?.workbenchError).toBe("gateway unavailable");
    expect(latest?.workbenchLoading).toBe(false);

    chatApiMocks.fetchChatSessionWorkbench.mockResolvedValueOnce({ state: workbenchState() });
    chatApiMocks.fetchChatSessionWorkbenchFile.mockResolvedValueOnce({
      state: workbenchState(),
      path: "src/app.ts",
      content: "original content",
      language: "typescript",
    });
    await act(async () => {
      await latest?.refreshWorkbench();
    });

    chatApiMocks.fetchChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("file unavailable"));
    await act(async () => {
      const loaded = await latest?.openWorkbenchFile("src/app.ts");
      expect(loaded).toBe(false);
    });
    expect(latest?.workbenchError).toBe("file unavailable");
    expect(latest?.workbenchBusy).toBe(false);

    chatApiMocks.saveChatSessionWorkbenchFile.mockRejectedValueOnce(new Error("save rejected"));
    await act(async () => {
      const saved = await latest?.saveWorkbenchFile();
      expect(saved).toBe(false);
    });
    expect(latest?.workbenchError).toBe("save rejected");
    expect(latest?.workbenchSaving).toBe(false);
    expect(latest?.workbenchBusy).toBe(false);

    chatApiMocks.createChatSessionWorkbenchWorktree.mockRejectedValueOnce(new Error("branch exists"));
    await act(async () => {
      await latest?.createWorkbenchWorktree("main");
    });
    expect(latest?.workbenchError).toBe("branch exists");
    expect(latest?.workbenchBusy).toBe(false);
  });

  it("saves the current draft content and clears dirty state", async () => {
    await act(async () => {
      create(<Harness />);
    });
    await flushEffects();

    act(() => {
      latest?.setWorkbenchDraftContent("edited content");
    });

    await act(async () => {
      await latest?.saveWorkbenchFile();
    });

    expect(chatApiMocks.saveChatSessionWorkbenchFile).toHaveBeenCalledWith("session-1", {
      path: "src/app.ts",
      content: "edited content",
    });
    expect(latest?.workbenchDraftContent).toBe("edited content");
    expect(latest?.hasDirtyWorkbenchDraft).toBe(false);
    expect(latest?.workbenchSaving).toBe(false);
  });

  it("resets all loaded state when the workbench is disabled", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await flushEffects();
    expect(latest?.selectedWorkbenchFile?.path).toBe("src/app.ts");

    await act(async () => {
      renderer.update(<Harness enabled={false} />);
    });

    expect(latest?.workbenchState).toBeNull();
    expect(latest?.selectedWorkbenchFile).toBeNull();
    expect(latest?.workbenchDraftContent).toBe("");
    expect(latest?.workbenchLoading).toBe(false);
  });

  it("ignores stale file loads after switching sessions", async () => {
    let resolveFile!: (value: unknown) => void;
    chatApiMocks.fetchChatSessionWorkbenchFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFile = resolve;
        }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    await act(async () => {
      renderer.update(<Harness sessionId="session-2" />);
      resolveFile({
        state: workbenchState("session-1"),
        path: "src/app.ts",
        content: "stale session content",
        language: "typescript",
      });
      await Promise.resolve();
    });
    await flushEffects();

    expect(latest?.selectedWorkbenchFile?.content).not.toBe("stale session content");
    expect(latest?.workbenchError).toBeNull();
  });
});
