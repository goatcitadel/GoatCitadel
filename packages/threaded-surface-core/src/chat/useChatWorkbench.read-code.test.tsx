import type { ChatSessionWorkbenchRecord, ChatSessionWorkbenchTreeResponse, ChatSessionWorkbenchDiffResponse, ChatSessionWorkbenchOutputResponse, ChatSessionWorkbenchFileResponse, ChatSessionWorkbenchFileDiffResponse } from "@goatcitadel/contracts";
import React, { Activity } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useChatWorkbench as WorkbenchHook } from "./useChatWorkbench";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reads = vi.hoisted(() => ({ loads: 0, status: vi.fn(), other: vi.fn(), tree: vi.fn(), diff: vi.fn(), output: vi.fn(), file: vi.fn(), fileDiff: vi.fn() }));
const code = vi.hoisted(() => ({ loads: 0, gate: Promise.resolve() as Promise<void>, caller: "read-actor", callerRevision: 0, access: 0, gateway: "http://read-gateway" }));
const subscription = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/chat-workbench-operations", () => {
  reads.loads += 1;
  return {
    fetchChatSessionWorkbench: reads.status,
    fetchChatSessionWorkbenchTree: (...args: unknown[]) => { reads.other(...args); return reads.tree(...args); },
    fetchChatSessionWorkbenchDiff: (...args: unknown[]) => { reads.other(...args); return reads.diff(...args); },
    fetchChatSessionWorkbenchOutput: (...args: unknown[]) => { reads.other(...args); return reads.output(...args); },
    fetchChatSessionWorkbenchFile: (...args: unknown[]) => { reads.other(...args); return reads.file(...args); },
    fetchChatSessionWorkbenchFileDiff: (...args: unknown[]) => { reads.other(...args); return reads.fileDiff(...args); },
  };
});
vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: subscription,
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScope: () => code.caller,
  getGatewayCallerScopeRevision: () => code.callerRevision,
  getGatewayAccessRevision: () => code.access,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => code.gateway,
}));
let useChatWorkbench: typeof WorkbenchHook;
let latest: ReturnType<WorkbenchHook>;
let renderer: ReactTestRenderer | undefined;
let enabled: boolean;
let sessionId: string;
let workspaceId: string;
let mode: "visible" | "hidden";
let activeGate: ReturnType<typeof deferred<void>> | undefined;
let draftStore: typeof import("./workbench-session-drafts");
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function holdCode() {
  activeGate = deferred<void>();
  code.gate = activeGate.promise;
  return activeGate;
}
function installCodeMock() {
  vi.doMock("./workbench-read-code.js", async importOriginal => {
    code.loads += 1;
    await code.gate;
    return importOriginal<typeof import("./workbench-read-code.js")>();
  });
}
function readyApi() {
  reads.status.mockImplementation(async (id: string) => ({ state: state(id) }));
  reads.tree.mockImplementation(async (id: string) => treeResponse(id));
  reads.diff.mockImplementation(async (id: string) => diffResponse(id));
  reads.output.mockImplementation(async (id: string) => outputResponse(id));
  reads.file.mockImplementation(async (id: string, path: string) => ({ ...baseFile(id), path }));
  reads.fileDiff.mockImplementation(async (id: string, path: string) => ({ ...fileDiffResponse(id), path }));
}
function Harness() {
  latest = useChatWorkbench({ sessionId, workspaceId, enabled });
  return null;
}
async function draw() {
  await act(async () => {
    const element = <Activity mode={mode}><Harness /></Activity>;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
beforeEach(async () => {
  vi.resetModules();
  vi.doUnmock("./workbench-read-code.js");
  reads.loads = 0;
  reads.status.mockReset();
  reads.other.mockReset();
  for (const name of ["tree", "diff", "output", "file", "fileDiff"] as const) reads[name].mockReset();
  reads.status.mockResolvedValue({ state: { sessionId: "read-owner", worktreeStatus: "missing" } });
  enabled = false;
  sessionId = "read-owner";
  workspaceId = "workspace-a";
  mode = "visible";
  activeGate = undefined;
  code.loads = 0;
  code.gate = Promise.resolve();
  code.caller = "read-actor";
  code.callerRevision = 0;
  code.access = 0;
  code.gateway = "http://read-gateway";
  subscription.mockClear();
  installCodeMock();
  renderer = undefined;
  useChatWorkbench = (await import("./useChatWorkbench")).useChatWorkbench;
  draftStore = await import("./workbench-session-drafts");
  draftStore.__resetWorkbenchSessionDraftsForTests();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  activeGate?.resolve();
  await vi.dynamicImportSettled();
  draftStore.__resetWorkbenchSessionDraftsForTests();
  vi.doUnmock("./workbench-read-code.js");
  vi.unstubAllGlobals();
});
const fixtureTime = "2026-10-14T00:00:00.000Z";
const state = (sessionId: string): ChatSessionWorkbenchRecord => ({
  sessionId,
  worktreeStatus: "ready",
  activeFilePath: "src/a.ts",
  baseRef: "main",
  projectId: "project-a",
  worktreePath: "/work/" + sessionId,
  validationStatus: "idle",
  createdAt: fixtureTime,
  updatedAt: fixtureTime,
});
const baseFile = (sessionId: string): ChatSessionWorkbenchFileResponse => ({
  revision: "a".repeat(64),
  state: state(sessionId),
  path: "src/a.ts",
  content: "original " + sessionId,
  sizeBytes: ("original " + sessionId).length,
  modifiedAt: fixtureTime,
  contentType: "text/plain",
  language: "typescript",
  changed: true,
});
const treeResponse = (sessionId: string): ChatSessionWorkbenchTreeResponse => ({
  state: state(sessionId),
  rootPath: "/work/" + sessionId,
  changedFiles: ["src/a.ts"],
  items: [
    { path: "src", name: "src", kind: "directory", changed: false, depth: 0 },
    { path: "src/a.ts", name: "a.ts", kind: "file", changed: true, depth: 1 },
  ],
});
const diffResponse = (sessionId: string): ChatSessionWorkbenchDiffResponse => ({
  state: state(sessionId),
  scopePath: "/work/" + sessionId,
  changedFiles: ["src/a.ts"],
  summary: { changedFiles: 1, additions: 0, deletions: 0 },
  diff: "reviewed diff",
});
const outputResponse = (sessionId: string, output = "current output"): ChatSessionWorkbenchOutputResponse => ({
  state: state(sessionId),
  helperRuns: [],
  output,
});
const fileDiffResponse = (sessionId: string): ChatSessionWorkbenchFileDiffResponse => ({
  state: state(sessionId),
  path: "src/a.ts",
  language: "typescript",
  changed: true,
  originalContent: "original " + sessionId,
  modifiedContent: "original " + sessionId,
});

describe("Workbench read admission before optional code", () => {
  it("disabled mount does not evaluate canonical read code or issue reads", async () => {
    await draw();
    expect(code.loads).toBe(0);
    expect(reads.loads).toBe(0);
    expect(reads.status).not.toHaveBeenCalled();
    expect(reads.other).not.toHaveBeenCalled();
  });
  it("enabling uses the existing canonical status read", async () => {
    await draw();
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledExactlyOnceWith("read-owner"));
    expect(reads.other).not.toHaveBeenCalled();
  });
  it("an old enabled refresh cannot dispatch after the same mounted owner is disabled", async () => {
    enabled = true;
    await draw();
    const oldRefresh = latest.refreshWorkbench;
    enabled = false;
    await draw();
    const count = reads.status.mock.calls.length;
    await act(async () => oldRefresh());
    expect(reads.status).toHaveBeenCalledTimes(count);
    expect(latest.workbenchState).toBeNull();
  });
});

describe("Workbench reads crossing real optional-code arrival", () => {
  it("shows loading before code and preserves canonical ready reads and subscription options", async () => {
    readyApi();
    const gate = holdCode();
    enabled = true;
    await draw();
    expect(latest.workbenchLoading).toBe(true);
    expect(reads.status).not.toHaveBeenCalled();
    expect(reads.loads).toBe(0);
    expect(subscription).toHaveBeenLastCalledWith("chat", expect.any(Function), {
      enabled: true, coalesceMs: 900, staleMs: 20_000, pollIntervalMs: 15_000,
    });
    gate.resolve();
    await vi.waitFor(() => expect(latest.selectedWorkbenchFile?.path).toBe("src/a.ts"));
    expect(reads.status).toHaveBeenCalledExactlyOnceWith("read-owner");
    expect(reads.tree).toHaveBeenCalledExactlyOnceWith("read-owner");
    expect(reads.diff).toHaveBeenCalledExactlyOnceWith("read-owner");
    expect(reads.output).toHaveBeenCalledExactlyOnceWith("read-owner");
    expect(reads.file).toHaveBeenCalledExactlyOnceWith("read-owner", "src/a.ts");
    expect(reads.fileDiff).toHaveBeenCalledExactlyOnceWith("read-owner", "src/a.ts");
    expect(latest.workbenchLoading).toBe(false);
    expect(code.loads).toBe(1);
  });

  it("shares code across explicit refresh, selection and the existing canonical subscription", async () => {
    const gate = holdCode();
    enabled = true;
    await draw();
    reads.file.mockResolvedValue(baseFile(sessionId));
    reads.fileDiff.mockResolvedValue(fileDiffResponse(sessionId));
    let refresh!: Promise<void>, selection!: Promise<boolean>, subscribed!: Promise<void>;
    await act(async () => {
      refresh = latest.refreshWorkbench();
      selection = latest.openWorkbenchFile("src/a.ts");
      subscribed = subscription.mock.calls.at(-1)![1]();
    });
    expect(latest.workbenchBusy).toBe(true);
    expect(latest.workbenchLoading).toBe(true);
    expect(reads.status).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await Promise.all([refresh, selection, subscribed]); });
    expect(code.loads).toBe(1);
    expect(reads.status).toHaveBeenCalledTimes(3);
    expect(reads.file).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "session", "session-aba", "enabled-aba", "workspace", "workspace-aba", "caller", "access", "gateway", "unmount", "activity"] as const)(
    "does not dispatch a saved read intent after %s replacement", async replacement => {
      const gate = holdCode();
      enabled = true;
      await draw();
      let selection!: Promise<boolean>;
      await act(async () => { selection = latest.openWorkbenchFile("src/old-intent.ts"); });
      if (replacement === "disabled" || replacement === "enabled-aba") enabled = false;
      if (replacement.startsWith("session")) sessionId = "read-owner-B";
      if (replacement.startsWith("workspace")) workspaceId = "workspace-B";
      if (replacement === "caller") { code.caller = "actor-B"; code.callerRevision += 1; }
      if (replacement === "access") code.access += 1;
      if (replacement === "gateway") code.gateway = "http://gateway-B";
      if (replacement === "activity") mode = "hidden";
      if (replacement === "unmount") {
        await act(async () => { renderer!.unmount(); renderer = undefined; });
      } else await draw();
      if (replacement === "session-aba") { sessionId = "read-owner"; await draw(); }
      if (replacement === "workspace-aba") { workspaceId = "workspace-a"; await draw(); }
      if (replacement === "enabled-aba") { enabled = true; await draw(); }
      if (replacement === "activity") { mode = "visible"; await draw(); }
      await act(async () => { gate.resolve(); await selection; });
      await vi.dynamicImportSettled();
      expect(reads.file).not.toHaveBeenCalledWith(expect.anything(), "src/old-intent.ts");
      const freshMountedRead = ["session", "session-aba", "enabled-aba", "activity"].includes(replacement);
      await vi.waitFor(() => expect(reads.status).toHaveBeenCalledTimes(freshMountedRead ? 1 : 0));
      if (freshMountedRead) expect(reads.status).toHaveBeenCalledWith(sessionId);
    },
  );

  it("reports rejected code, retains drafts and unload protection, and retries only on demand", async () => {
    const gate = holdCode();
    const listeners = new Map<string, (event: { preventDefault(): void; returnValue?: string }) => void>();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: vi.fn() },
      addEventListener: (name: string, callback: (event: { preventDefault(): void; returnValue?: string }) => void) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const drafts = await import("./workbench-session-drafts");
    drafts.updateWorkbenchDraft(JSON.stringify([code.caller, sessionId]), baseFile(sessionId), "retained unsaved input");
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(code.loads).toBe(1));
    gate.reject(new Error("read chunk unavailable"));
    await vi.waitFor(() => expect(latest.workbenchError).toBeTruthy());
    expect(latest.workbenchLoading).toBe(false);
    expect(reads.status).not.toHaveBeenCalled();
    expect(latest.workbenchDraftPaths).toEqual(["src/a.ts"]);
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    listeners.get("beforeunload")!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(code.loads).toBe(1);
    vi.resetModules();
    code.gate = Promise.resolve();
    installCodeMock();
    await act(async () => { await latest.refreshWorkbench(); });
    expect(reads.status).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(code.loads).toBe(2);
  });

  it("does not publish an obsolete import rejection into a replacement owner", async () => {
    const gate = holdCode();
    enabled = true;
    await draw();
    code.access += 1;
    await draw();
    await vi.waitFor(() => expect(code.loads).toBe(1));
    gate.reject(new Error("obsolete chunk error"));
    await vi.dynamicImportSettled();
    expect(reads.status).not.toHaveBeenCalled();
    expect(latest.workbenchError).toBeNull();
    expect(latest.workbenchLoading).toBe(false);
  });

  it("fences a dispatched status read before any later tree/file read or publication", async () => {
    readyApi();
    const pending = deferred<{ state: ChatSessionWorkbenchRecord }>();
    reads.status.mockReturnValueOnce(pending.promise);
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    code.access += 1;
    await draw();
    await act(async () => { pending.resolve({ state: state(sessionId) }); });
    expect(reads.tree).not.toHaveBeenCalled();
    expect(reads.file).not.toHaveBeenCalled();
    expect(latest.workbenchState).toBeNull();
    expect(latest.workbenchError).toBeNull();
    expect(latest.workbenchLoading).toBe(false);
    await act(async () => { await latest.refreshWorkbench(); });
    expect(latest.selectedWorkbenchFile?.path).toBe("src/a.ts");
  });

  it("fences dispatched file evidence and prevents its cleanup releasing newer busy ownership", async () => {
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    const oldFile = deferred<ChatSessionWorkbenchFileResponse>();
    const newFile = deferred<ChatSessionWorkbenchFileResponse>();
    reads.file.mockReturnValueOnce(oldFile.promise).mockReturnValueOnce(newFile.promise);
    reads.fileDiff.mockImplementation(async (id: string, path: string) => ({ ...fileDiffResponse(id), path }));
    let oldRead!: Promise<boolean>, newRead!: Promise<boolean>;
    await act(async () => { oldRead = latest.openWorkbenchFile("src/old.ts"); });
    await vi.waitFor(() => expect(reads.file).toHaveBeenCalledOnce());
    code.access += 1;
    await draw();
    await act(async () => { newRead = latest.openWorkbenchFile("src/new.ts"); });
    await vi.waitFor(() => expect(reads.file).toHaveBeenCalledTimes(2));
    await act(async () => { oldFile.resolve({ ...baseFile(sessionId), path: "src/old.ts" }); await oldRead; });
    expect(latest.selectedWorkbenchFile).toBeNull();
    expect(latest.workbenchBusy).toBe(true);
    await act(async () => { newFile.resolve({ ...baseFile(sessionId), path: "src/new.ts" }); await newRead; });
    expect(latest.selectedWorkbenchFile?.path).toBe("src/new.ts");
    expect(latest.workbenchBusy).toBe(false);
  });

  it("does not let an old dispatched session status publish or clear the next session's loading", async () => {
    readyApi();
    const oldStatus = deferred<{ state: ChatSessionWorkbenchRecord }>();
    const newStatus = deferred<{ state: ChatSessionWorkbenchRecord }>();
    reads.status.mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(newStatus.promise);
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    sessionId = "read-owner-B";
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledTimes(2));
    await act(async () => { oldStatus.resolve({ state: state("read-owner") }); });
    expect(latest.workbenchState).toBeNull();
    expect(latest.workbenchLoading).toBe(true);
    expect(reads.tree).not.toHaveBeenCalled();
    await act(async () => { newStatus.resolve({ state: state(sessionId) }); });
    await vi.waitFor(() => expect(latest.selectedWorkbenchFile?.state.sessionId).toBe(sessionId));
    expect(latest.workbenchLoading).toBe(false);
  });

  it("keeps the existing file-read generation when a later file finishes first", async () => {
    enabled = true;
    await draw();
    await vi.waitFor(() => expect(reads.status).toHaveBeenCalledOnce());
    const firstFile = deferred<ChatSessionWorkbenchFileResponse>();
    const secondFile = deferred<ChatSessionWorkbenchFileResponse>();
    reads.file.mockReturnValueOnce(firstFile.promise).mockReturnValueOnce(secondFile.promise);
    reads.fileDiff.mockImplementation(async (id: string, path: string) => ({ ...fileDiffResponse(id), path }));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = latest.openWorkbenchFile("src/first.ts"); });
    await vi.waitFor(() => expect(reads.file).toHaveBeenCalledOnce());
    await act(async () => { second = latest.openWorkbenchFile("src/second.ts"); });
    await vi.waitFor(() => expect(reads.file).toHaveBeenCalledTimes(2));
    await act(async () => { secondFile.resolve({ ...baseFile(sessionId), path: "src/second.ts" }); await second; });
    await act(async () => { firstFile.resolve({ ...baseFile(sessionId), path: "src/first.ts" }); await first; });
    expect(latest.selectedWorkbenchFile?.path).toBe("src/second.ts");
  });

  it("claims explicit file-read order before a shared code import resolves", async () => {
    const gate = holdCode();
    enabled = true;
    await draw();
    reads.file.mockImplementation(async (id: string, path: string) => ({ ...baseFile(id), path }));
    reads.fileDiff.mockImplementation(async (id: string, path: string) => ({ ...fileDiffResponse(id), path }));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => {
      first = latest.openWorkbenchFile("src/first.ts");
      second = latest.openWorkbenchFile("src/second.ts");
    });
    expect(reads.file).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await Promise.all([first, second]); });
    expect(reads.file).toHaveBeenCalledExactlyOnceWith(sessionId, "src/second.ts");
    expect(latest.selectedWorkbenchFile?.path).toBe("src/second.ts");
  });
});
