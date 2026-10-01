// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionStatusResponse, ChatSessionWorkbenchFileResponse, ChatSessionWorkbenchRecord } from "@goatcitadel/contracts";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { RunWorkspaceContext } from "./RunWorkspaceContext";

const api = vi.hoisted(() => ({
  fetchChatSessionStatus: vi.fn(), fetchChatSessionWorkbench: vi.fn(),
  fetchChatSessionWorkbenchTree: vi.fn(), fetchChatSessionWorkbenchFile: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => api);
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, title, children, onOpenChange, sideOnDesktop }: {
    open: boolean; title: string; children: ReactNode; onOpenChange: (open: boolean) => void; sideOnDesktop?: boolean;
  }) => open ? <section role="dialog" aria-label={title} data-side={sideOnDesktop}>
    <button type="button" onClick={() => onOpenChange(false)}>Close preview</button>{children}
  </section> : null,
}));

const workbench: ChatSessionWorkbenchRecord = {
  sessionId: "session-a", projectId: "project-a", baseRef: "main", worktreePath: "worktrees/session-a",
  worktreeStatus: "ready", validationStatus: "idle", createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
};
const file: ChatSessionWorkbenchFileResponse = {
  state: workbench, path: "src/index.ts", revision: "a".repeat(64), sizeBytes: 32,
  modifiedAt: workbench.updatedAt, contentType: "text/typescript", language: "ts", changed: true,
  content: "const token = '[REDACTED]';",
};
const session = { sessionId: "session-a", workspaceId: "workspace-a" } as ChatSessionStatusResponse;
function trace(): ObserveRunTraceResponse {
  return {
    version: "observe.run_trace.v1", generatedAt: workbench.updatedAt, runId: "run-a",
    run: { runId: "run-a", workflowKey: "chat.turn.execute", status: "completed", version: 1,
      attemptCount: 1, maxAttempts: 3, createdAt: workbench.createdAt, updatedAt: workbench.updatedAt,
      payload: { workspaceId: "workspace-a", sessionId: "session-a" } },
    lifecycle: { state: "available", response: {
      query: { runId: "run-a" }, canonical: { runId: "run-a", sessionId: "session-a" },
      linked: { sessionIds: ["session-a"], turnIds: [], runIds: ["run-a"], proactiveRunIds: [], approvalIds: [], taskIds: [], workspaceIds: ["workspace-a"] },
      turns: [], toolRuns: [],
    } },
    session: { state: "not_available" }, thread: { state: "not_available", turns: [] },
    durable: { checkpoints: { state: "not_available", items: [] }, timeline: { state: "not_available", items: [] } },
    approvals: { state: "not_available", items: [], missingIds: [] }, toolCalls: { state: "not_available", items: [] },
    memoryContext: { state: "not_available", items: [] }, providerUsage: { state: "not_available", items: [], totals: {} },
    artifacts: { state: "not_available", items: [] }, errors: { state: "not_available", items: [] },
    posture: { readOnly: true, sideEffectPosture: "audit_only", audit: { state: "available", note: "Read only" },
      replay: { state: "not_available", checkpointIds: [], note: "No replay" }, resume: { state: "not_available", eligible: false, note: "No resume" } },
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchChatSessionStatus.mockResolvedValue(session);
  api.fetchChatSessionWorkbench.mockResolvedValue({ state: workbench });
  api.fetchChatSessionWorkbenchTree.mockResolvedValue({ state: workbench, rootPath: "project-a", changedFiles: [file.path],
    items: [{ path: "src", name: "src", kind: "directory", depth: 0, changed: true },
      { path: file.path, name: "index.ts", kind: "file", depth: 1, changed: true }] });
  api.fetchChatSessionWorkbenchFile.mockResolvedValue(file);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render(value = trace(), workspaceId = "workspace-a") {
  await act(async () => root.render(<RunWorkspaceContext trace={value} workspaceId={workspaceId} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function inspectFiles() {
  await render();
  await click("Inspect current worktree");
  await click("Inspect files");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Run current workspace inspection", () => {
  it("reads context, tree, and plain text only after each explicit inspection", async () => {
    await render();
    expect(api.fetchChatSessionStatus).not.toHaveBeenCalled();
    expect(api.fetchChatSessionWorkbench).not.toHaveBeenCalled();
    await click("Inspect current worktree");
    expect(api.fetchChatSessionStatus).toHaveBeenCalledWith("session-a");
    expect(api.fetchChatSessionWorkbench).toHaveBeenCalledWith("session-a", { preview: true });
    expect(container.textContent).toContain("main");
    expect(container.textContent).toContain("worktrees/session-a");
    expect(api.fetchChatSessionWorkbenchTree).not.toHaveBeenCalled();
    await click("Inspect files");
    expect(api.fetchChatSessionWorkbenchTree).toHaveBeenCalledWith("session-a", { preview: true });
    expect(api.fetchChatSessionWorkbenchFile).not.toHaveBeenCalled();
    await click(`Preview ${file.path}`);
    expect(api.fetchChatSessionWorkbenchFile).toHaveBeenCalledWith("session-a", file.path, { preview: true });
    expect(container.querySelector("code")?.textContent).toBe(file.content);
    expect(container.querySelector('[role="dialog"]')?.getAttribute("data-side")).toBe("true");
    expect(container.textContent).toContain("does not identify which changes the run made");
    expect(container.querySelector("textarea,iframe")).toBeNull();
  });

  it.each(["foreign workspace", "missing workspace", "unavailable lifecycle", "different canonical run", "conflicting session"])(
    "withholds inspection with %s evidence", async (reason) => {
      const value = trace();
      if (reason === "foreign workspace") value.run.payload.workspaceId = "workspace-b";
      if (reason === "missing workspace") delete value.run.payload.workspaceId;
      if (reason === "unavailable lifecycle") value.lifecycle.state = "unknown";
      if (reason === "different canonical run") value.lifecycle.response!.canonical.runId = "other";
      if (reason === "conflicting session") value.run.payload.sessionId = "other";
      await render(value);
      expect(container.textContent).toContain("Worktree context unavailable");
      expect(container.querySelector("button")).toBeNull();
      expect(api.fetchChatSessionStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["workspaceId", "sessionId"])("does not read a workbench when current session %s mismatches", async (key) => {
    api.fetchChatSessionStatus.mockResolvedValue({ ...session, [key]: "other" });
    await render();
    await click("Inspect current worktree");
    expect(api.fetchChatSessionWorkbench).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no longer has matching workspace evidence");
  });

  it("withholds a mismatched workbench record and a workspace change during the read", async () => {
    api.fetchChatSessionWorkbench.mockResolvedValueOnce({ state: { ...workbench, sessionId: "other", worktreePath: "PRIVATE" } });
    await render();
    await click("Inspect current worktree");
    expect(container.textContent).not.toContain("PRIVATE");
    api.fetchChatSessionStatus.mockResolvedValueOnce(session).mockResolvedValueOnce({ ...session, workspaceId: "other" });
    await click("Refresh worktree context");
    expect(container.textContent).not.toContain(workbench.worktreePath);
  });

  it("keeps unavailable worktree status distinct from a clean file result", async () => {
    api.fetchChatSessionWorkbench.mockResolvedValue({ state: { ...workbench, worktreeStatus: "missing" } });
    await render();
    await click("Inspect current worktree");
    expect(container.textContent).toContain("Missing");
    expect(container.textContent).toContain("needs a ready worktree");
    expect(container.textContent).not.toContain("No changed paths");
    expect(api.fetchChatSessionWorkbenchTree).not.toHaveBeenCalled();
  });

  it("rejects changed project identity before reading a file", async () => {
    await inspectFiles();
    api.fetchChatSessionWorkbench.mockResolvedValue({ state: { ...workbench, projectId: "project-b" } });
    await click(`Preview ${file.path}`);
    expect(api.fetchChatSessionWorkbenchFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("project or worktree changed");
    expect(container.querySelector('[aria-label="Current file tree"]')).toBeNull();
  });

  it.each(["projectId", "worktreePath", "baseRef", "sessionId"])("withholds file content if returned %s changed", async (key) => {
    await inspectFiles();
    api.fetchChatSessionWorkbenchFile.mockResolvedValue({ ...file, state: { ...workbench, [key]: "other" }, content: "PRIVATE CONTENT" });
    await click(`Preview ${file.path}`);
    expect(container.textContent).not.toContain("PRIVATE CONTENT");
    expect(container.textContent).toContain("project or worktree changed");
  });

  it("detects a project change after the file read before rendering it", async () => {
    await inspectFiles();
    api.fetchChatSessionWorkbench.mockResolvedValueOnce({ state: workbench }).mockResolvedValueOnce({ state: { ...workbench, projectId: "new-project" } });
    await click(`Preview ${file.path}`);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain("project or worktree changed");
  });

  it("clears old content immediately on refresh and ignores late reads after scope change", async () => {
    await inspectFiles();
    await click(`Preview ${file.path}`);
    expect(container.querySelector("code")).not.toBeNull();
    const pending = deferred<ChatSessionStatusResponse>();
    api.fetchChatSessionStatus.mockReturnValueOnce(pending.promise);
    const calls = api.fetchChatSessionWorkbench.mock.calls.length;
    await click("Refresh worktree context");
    expect(container.querySelector("code")).toBeNull();
    expect(container.querySelector('[aria-label="Current file tree"]')).toBeNull();
    await render(trace(), "workspace-b");
    await act(async () => pending.resolve(session));
    expect(api.fetchChatSessionWorkbench).toHaveBeenCalledTimes(calls);
    expect(container.textContent).not.toContain(workbench.worktreePath);
  });

  it("ignores a file read after its preview is closed", async () => {
    await inspectFiles();
    const pending = deferred<ChatSessionWorkbenchFileResponse>();
    api.fetchChatSessionWorkbenchFile.mockReturnValue(pending.promise);
    await click(`Preview ${file.path}`);
    await click("Close preview");
    await act(async () => pending.resolve(file));
    expect(container.querySelector("code")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("bounds displayed lists and rejects an oversized preview", async () => {
    const paths = Array.from({ length: 80 }, (_, index) => `file-${index}.ts`);
    api.fetchChatSessionWorkbenchTree.mockResolvedValue({ state: workbench, rootPath: "project-a", changedFiles: paths,
      items: paths.map((path) => ({ path, name: path, kind: "file", depth: 0, changed: true })) });
    await inspectFiles();
    expect(container.querySelectorAll('[aria-label="Current changed files"] li')).toHaveLength(40);
    expect(container.querySelectorAll('[aria-label="Current file tree"] li')).toHaveLength(60);
    api.fetchChatSessionWorkbenchFile.mockResolvedValue({ ...file, path: paths[0], content: "x".repeat(64 * 1024 + 1) });
    await click(`Preview ${paths[0]}`);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain("64 KiB preview limit");
  });

  it("surfaces owner failures without rendering stale context or file content", async () => {
    await inspectFiles();
    api.fetchChatSessionWorkbenchFile.mockRejectedValue(new Error("Path is outside the project root."));
    await click(`Preview ${file.path}`);
    expect(container.textContent).toContain("Path is outside the project root");
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain(workbench.worktreePath);
  });
});
