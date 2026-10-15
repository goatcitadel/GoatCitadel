import React, { Activity } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useChatWorkbench as WorkbenchHook } from "./useChatWorkbench";
import type * as DraftOwner from "./workbench-session-drafts";
import type {
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchCommandRunResponse,
} from "@goatcitadel/contracts";
let useChatWorkbench: typeof WorkbenchHook;
let drafts: typeof DraftOwner;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const code = vi.hoisted(() => ({
  caller: "actor-a",
  callerRevision: 0,
  access: 0,
  gateway: "http://gateway-a",
  loads: 0,
  gate: Promise.resolve() as Promise<void>,
}));
const api = vi.hoisted(() => ({
  status: vi.fn(),
  tree: vi.fn(),
  diff: vi.fn(),
  output: vi.fn(),
  file: vi.fn(),
  fileDiff: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  operation: vi.fn(),
  create: vi.fn(),
  command: vi.fn(),
  patch: vi.fn(),
  export: vi.fn(),
  revert: vi.fn(),
  revertAll: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({
  getGatewayCallerScope: () => code.caller,
  getGatewayCallerScopeRevision: () => code.callerRevision,
  getGatewayAccessRevision: () => code.access,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => code.gateway }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChatSessionWorkbench: api.status,
  fetchChatSessionWorkbenchTree: api.tree,
  fetchChatSessionWorkbenchDiff: api.diff,
  fetchChatSessionWorkbenchOutput: api.output,
  fetchChatSessionWorkbenchFile: api.file,
  fetchChatSessionWorkbenchFileDiff: api.fileDiff,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat-workbench-operations", () => ({
  saveChatSessionWorkbenchFile: api.save,
  previewChatSessionWorkbenchFileOperation: api.preview,
  runChatSessionWorkbenchFileOperation: api.operation,
  createChatSessionWorkbenchWorktree: api.create,
  runChatSessionWorkbenchCommand: api.command,
  applyChatSessionWorkbenchPatch: api.patch,
  exportChatSessionWorkbenchPatch: api.export,
  revertChatSessionWorkbenchFile: api.revert,
  revertChatSessionWorkbenchChanges: api.revertAll,
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn(),
}));
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
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
const commandResponse = (sessionId: string, output = "validation done"): ChatSessionWorkbenchCommandRunResponse => ({
  state: state(sessionId),
  run: {
    commandRunId: "command-" + sessionId,
    sessionId,
    command: "pnpm",
    args: [],
    status: "passed",
    startedAt: fixtureTime,
    completedAt: fixtureTime,
    validationStatus: "passed",
  },
  output: outputResponse(sessionId, output),
});
type FileRecord = ChatSessionWorkbenchFileResponse;
let files: Map<string, FileRecord>, view: ReactTestRenderer | undefined, latest: ReturnType<WorkbenchHook>;
let props = { sessionId: "session-1", enabled: true, workspaceId: "workspace-a" };
let mode: "visible" | "hidden" = "visible",
  activeCodeGate: ReturnType<typeof deferred<void>> | undefined;
function Harness() {
  latest = useChatWorkbench(props);
  return null;
}
function element() {
  return (
    <Activity mode={mode}>
      <Harness />
    </Activity>
  );
}
async function draw() {
  await act(async () => {
    if (view) view.update(element());
    else view = create(element());
  });
}
async function ready() {
  await vi.waitFor(() => expect(latest.selectedWorkbenchFile?.state.sessionId).toBe(props.sessionId));
}
function scoped(caller: string, sessionId = "session-1") {
  return JSON.stringify([caller, sessionId]);
}
function currentFile(sessionId: string) {
  if (!files.has(sessionId)) files.set(sessionId, baseFile(sessionId));
  return files.get(sessionId)!;
}
function commit(sessionId: string, content: string): FileRecord {
  const value = { ...currentFile(sessionId), content, sizeBytes: content.length, revision: "b".repeat(64) };
  files.set(sessionId, value);
  return value;
}
function holdCode() {
  activeCodeGate = deferred<void>();
  code.gate = activeCodeGate.promise;
  return activeCodeGate;
}
function installCodeMock() {
  vi.doMock("./workbench-action-code.js", async () => {
    code.loads += 1;
    await code.gate;
    return vi.importActual("./workbench-action-code.js");
  });
}
async function beginSave() {
  let attempt!: Promise<boolean>;
  await act(async () => {
    attempt = latest.saveWorkbenchFile();
  });
  await vi.waitFor(() => expect(code.loads).toBeGreaterThan(0));
  return { attempt };
}
async function edit(content: string) {
  await act(async () => latest.setWorkbenchDraftContent(content));
}
beforeEach(async () => {
  vi.doUnmock("./workbench-action-code.js");
  vi.resetModules();
  vi.clearAllMocks();
  code.caller = "actor-a";
  code.callerRevision = 0;
  code.access = 0;
  code.gateway = "http://gateway-a";
  code.loads = 0;
  code.gate = Promise.resolve();
  activeCodeGate = undefined;
  view = undefined;
  props = { sessionId: "session-1", enabled: true, workspaceId: "workspace-a" };
  mode = "visible";
  files = new Map();
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockImplementation(async (sessionId: string) => ({ state: state(sessionId) }));
  api.tree.mockImplementation(async (sessionId: string) => treeResponse(sessionId));
  api.diff.mockImplementation(async (sessionId: string) => diffResponse(sessionId));
  api.output.mockImplementation(async (sessionId: string) => outputResponse(sessionId));
  api.file.mockImplementation(async (sessionId: string) => currentFile(sessionId));
  api.fileDiff.mockImplementation(async (sessionId: string) => fileDiffResponse(sessionId));
  api.save.mockImplementation(async (sessionId: string, input: { content: string }) =>
    commit(sessionId, input.content),
  );
  api.command.mockImplementation(async (sessionId: string) => commandResponse(sessionId));
  installCodeMock();
  useChatWorkbench = (await import("./useChatWorkbench")).useChatWorkbench;
  drafts = await import("./workbench-session-drafts");
  drafts.__resetWorkbenchSessionDraftsForTests();
});
afterEach(async () => {
  await act(async () => view?.unmount());
  activeCodeGate?.resolve();
  await vi.dynamicImportSettled();
  drafts.__resetWorkbenchSessionDraftsForTests();
  vi.doUnmock("./workbench-action-code.js");
  vi.resetModules();
  vi.unstubAllGlobals();
});
describe("Workbench optional action code with actual mounted owner", () => {
  it("hydrates status/file evidence without importing action code", async () => {
    await draw();
    await ready();
    expect(latest.workbenchState?.worktreeStatus).toBe("ready");
    expect(api.status).toHaveBeenCalledWith("session-1");
    expect(api.file).toHaveBeenCalled();
    expect(code.loads).toBe(0);
    expect(api.save).not.toHaveBeenCalled();
  });
  it("claims save synchronously, excludes a second save and preserves newer input around the original submitted snapshot", async () => {
    await draw();
    await ready();
    await edit("submitted");
    const gate = holdCode(),
      { attempt } = await beginSave();
    expect(latest.workbenchBusy).toBe(true);
    expect(latest.workbenchSaving).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
    let second!: boolean;
    await act(async () => {
      second = await latest.saveWorkbenchFile();
    });
    expect(second).toBe(false);
    await edit("newer input");
    await act(async () => {
      gate.resolve();
      await attempt;
    });
    expect(api.save).toHaveBeenCalledExactlyOnceWith("session-1", {
      path: "src/a.ts",
      content: "submitted",
      expectedRevision: "a".repeat(64),
    });
    expect(latest.workbenchDraftContent).toBe("newer input");
    expect(latest.hasDirtyWorkbenchDraft).toBe(true);
    expect(latest.workbenchBusy).toBe(false);
    expect(latest.workbenchSaving).toBe(false);
  });
  it.each(["session ABA", "workspace ABA", "caller ABA", "access ABA", "Gateway ABA", "disabled", "unmount"])(
    "withholds a delayed save before preflight/PUT after %s",
    async (change) => {
      await draw();
      await ready();
      await edit("held draft");
      const gate = holdCode(),
        { attempt } = await beginSave();
      if (change === "session ABA") {
        props.sessionId = "session-2";
        await draw();
        await ready();
        props.sessionId = "session-1";
        await draw();
        await ready();
      } else if (change === "workspace ABA") {
        props.workspaceId = "workspace-b";
        await draw();
        props.workspaceId = "workspace-a";
        await draw();
      } else if (change === "caller ABA") {
        code.caller = "actor-b";
        code.callerRevision += 1;
        await draw();
        code.caller = "actor-a";
        code.callerRevision += 1;
        await draw();
      } else if (change === "access ABA") {
        code.access += 2;
        await draw();
      } else if (change === "Gateway ABA") {
        code.gateway = "http://gateway-b";
        code.access += 1;
        await draw();
        code.gateway = "http://gateway-a";
        code.access += 1;
        await draw();
      } else if (change === "disabled") {
        props.enabled = false;
        await draw();
      } else await act(async () => view!.unmount());
      const reads = api.file.mock.calls.length;
      await act(async () => {
        gate.resolve();
        expect(await attempt).toBe(false);
      });
      expect(api.file).toHaveBeenCalledTimes(reads);
      expect(api.save).not.toHaveBeenCalled();
      expect(drafts.getWorkbenchDraft(scoped("actor-a"), "src/a.ts")?.content).toBe("held draft");
    },
  );
  it.each(["workspace", "caller", "session"])(
    "rejects a saved old callback before admission after %s ABA",
    async (change) => {
      await draw();
      await ready();
      const saved = latest.saveWorkbenchFile;
      if (change === "workspace") {
        props.workspaceId = "workspace-b";
        await draw();
        props.workspaceId = "workspace-a";
        await draw();
      } else if (change === "caller") {
        code.callerRevision += 1;
        code.caller = "actor-b";
        await draw();
        code.callerRevision += 1;
        code.caller = "actor-a";
        await draw();
      } else {
        props.sessionId = "session-2";
        await draw();
        await ready();
        props.sessionId = "session-1";
        await draw();
        await ready();
      }
      await edit("current draft");
      await act(async () => expect(await saved()).toBe(false));
      expect(code.loads).toBe(0);
      expect(api.save).not.toHaveBeenCalled();
      expect(latest.workbenchBusy).toBe(false);
    },
  );
  it("fences code held across Activity hide/reveal and admits a new intentional save afterward", async () => {
    await draw();
    await ready();
    await edit("retained draft");
    const gate = holdCode(),
      { attempt } = await beginSave();
    mode = "hidden";
    await draw();
    mode = "visible";
    await draw();
    await ready();
    await act(async () => {
      gate.resolve();
      expect(await attempt).toBe(false);
    });
    expect(api.save).not.toHaveBeenCalled();
    expect(latest.hasDirtyWorkbenchDraft).toBe(true);
    await act(async () => expect(await latest.saveWorkbenchFile()).toBe(true));
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("releases import-failed admission without dispatch or draft loss and permits a new explicit loader attempt", async () => {
    await draw();
    await ready();
    await edit("retained draft");
    const gate = holdCode(),
      { attempt } = await beginSave(),
      reads = api.file.mock.calls.length;
    await act(async () => {
      gate.reject(new Error("Action code unavailable"));
      expect(await attempt).toBe(false);
    });
    await expect(gate.promise).rejects.toThrow("Action code unavailable");
    expect(latest.workbenchError).toContain("[vitest] There was an error when mocking a module");
    expect(api.file).toHaveBeenCalledTimes(reads);
    expect(api.save).not.toHaveBeenCalled();
    expect(latest.workbenchDraftContent).toBe("retained draft");
    expect(latest.hasDirtyWorkbenchDraft).toBe(true);
    expect(latest.workbenchBusy).toBe(false);
    expect(latest.workbenchSaving).toBe(false);
    code.gate = Promise.resolve();
    vi.doUnmock("./workbench-action-code.js");
    installCodeMock();
    await act(async () => expect(await latest.saveWorkbenchFile()).toBe(true));
    expect(code.loads).toBe(2);
    expect(api.save).toHaveBeenCalledOnce();
  });
  it("captures the original serialized command intent before action code can be delayed", async () => {
    await draw();
    await ready();
    const gate = holdCode();
    const input = { command: "pnpm", args: ["test"], timeoutMs: 1000 };
    let attempt!: Promise<boolean>;
    await act(async () => {
      attempt = latest.runWorkbenchValidationCommand(input);
    });
    await vi.waitFor(() => expect(code.loads).toBeGreaterThan(0));
    input.command = "other";
    input.args.push("changed");
    input.timeoutMs = 2000;
    await act(async () => {
      gate.resolve();
      expect(await attempt).toBe(true);
    });
    expect(api.command).toHaveBeenCalledExactlyOnceWith("session-1", {
      command: "pnpm",
      args: ["test"],
      timeoutMs: 1000,
    });
  });
  it("acknowledges a confirmed save only in its admitted caller cache after caller replacement", async () => {
    await draw();
    await ready();
    await edit("actor A submitted");
    const response = deferred<FileRecord>();
    api.save.mockImplementationOnce(() => response.promise);
    const { attempt } = await beginSave();
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    code.caller = "actor-b";
    code.callerRevision += 1;
    await draw();
    await edit("actor B draft");
    await act(async () => {
      response.resolve(commit("session-1", "actor A submitted"));
      await attempt;
    });
    expect(drafts.getWorkbenchDraft(scoped("actor-a"), "src/a.ts")).toBeUndefined();
    expect(drafts.getWorkbenchDraft(scoped("actor-b"), "src/a.ts")?.content).toBe("actor B draft");
    expect(latest.workbenchDraftContent).toBe("actor B draft");
    expect(latest.hasDirtyWorkbenchDraft).toBe(true);
    expect(latest.workbenchSaving).toBe(false);
  });
  it("does not let an old save response clear a newer scope's pending validation state", async () => {
    await draw();
    await ready();
    await edit("old submitted");
    const response = deferred<FileRecord>();
    api.save.mockImplementationOnce(() => response.promise);
    const { attempt } = await beginSave();
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    props.sessionId = "session-2";
    await draw();
    await ready();
    const command = deferred<ChatSessionWorkbenchCommandRunResponse>();
    api.command.mockImplementationOnce(() => command.promise);
    let newer!: Promise<boolean>;
    await act(async () => {
      newer = latest.runWorkbenchValidationCommand({ command: "pnpm" });
    });
    await vi.waitFor(() => expect(api.command).toHaveBeenCalledOnce());
    await act(async () => {
      response.resolve(commit("session-1", "old submitted"));
      await attempt;
    });
    expect(latest.workbenchBusy).toBe(true);
    expect(latest.selectedWorkbenchFile?.state.sessionId).toBe("session-2");
    await act(async () => {
      command.resolve(commandResponse("session-2", "new result"));
      expect(await newer).toBe(true);
    });
    expect(latest.workbenchBusy).toBe(false);
    expect(latest.workbenchOutput?.output).toBe("new result");
  });
  it("preserves an uncertain write outcome and dispatches no automatic retry", async () => {
    await draw();
    await ready();
    await edit("possibly saved");
    api.save.mockImplementationOnce(async (sessionId: string, input: { content: string }) => {
      commit(sessionId, input.content);
      throw new Error("Write response lost");
    });
    await act(async () => expect(await latest.saveWorkbenchFile()).toBe(false));
    expect(api.save).toHaveBeenCalledOnce();
    expect(latest.hasDirtyWorkbenchDraft).toBe(true);
    expect(drafts.getWorkbenchDraft(scoped("actor-a"), "src/a.ts")?.content).toBe("possibly saved");
    await act(async () => expect(await latest.saveWorkbenchFile()).toBe(false));
    expect(api.save).toHaveBeenCalledOnce();
    expect(latest.workbenchError).toContain("changed");
  });
});
