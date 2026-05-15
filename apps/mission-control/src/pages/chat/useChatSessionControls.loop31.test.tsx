import React, { useState } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import { useChatSessionControls } from "./useChatSessionControls";

const apiMocks = vi.hoisted(() => ({
  archiveChatSession: vi.fn(),
  archiveWorkspaceChatSessions: vi.fn(),
  assignChatSessionProject: vi.fn(),
  createChatProject: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  pinChatSession: vi.fn(),
  restoreChatSession: vi.fn(),
  setChatSessionBinding: vi.fn(),
  unpinChatSession: vi.fn(),
  updateChatSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  archiveChatSession: apiMocks.archiveChatSession,
  archiveWorkspaceChatSessions: apiMocks.archiveWorkspaceChatSessions,
  assignChatSessionProject: apiMocks.assignChatSessionProject,
  createChatProject: apiMocks.createChatProject,
  createChatSession: apiMocks.createChatSession,
  deleteChatSession: apiMocks.deleteChatSession,
  pinChatSession: apiMocks.pinChatSession,
  restoreChatSession: apiMocks.restoreChatSession,
  setChatSessionBinding: apiMocks.setChatSessionBinding,
  unpinChatSession: apiMocks.unpinChatSession,
  updateChatSession: apiMocks.updateChatSession,
}));

type HookState = ReturnType<typeof useChatSessionControls> & {
  binding: unknown;
  error: string | null;
  historyView: "active" | "archived";
  loadSidebar: ReturnType<typeof vi.fn>;
  queuedSessionIds: string[];
  selectedProjectId: string;
  selectedSessionId: string | null;
  sending: boolean;
  thread: unknown;
};

let latest: HookState | null = null;

function session(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "session-1",
    workspaceId: "default",
    mode: "chat",
    title: "Release checklist",
    lifecycleStatus: "active",
    pinned: false,
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:00:00.000Z",
    ...overrides,
  } as ChatSessionRecord;
}

function Harness(props: {
  historyView?: "active" | "archived";
  selectedProjectId?: string;
  selectedSession?: ChatSessionRecord | null;
  sessionMode?: ChatMode;
}) {
  const [historyView, setHistoryView] = useState<"active" | "archived">(props.historyView ?? "active");
  const [selectedProjectId, setSelectedProjectId] = useState(props.selectedProjectId ?? "all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(props.selectedSession?.sessionId ?? null);
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([
    {
      id: "queue-1",
      action: "send",
      sessionId: "session-1",
      content: "first",
      attachments: [],
      createdAt: "2026-05-14T12:01:00.000Z",
    },
    {
      id: "queue-2",
      action: "send",
      sessionId: "session-2",
      content: "second",
      attachments: [],
      createdAt: "2026-05-14T12:02:00.000Z",
    },
  ]);
  const [thread, setThread] = useState<unknown>({ sessionId: "session-1" });
  const [binding, setBinding] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadSidebar] = useState(() => vi.fn(async () => undefined));

  const hook = useChatSessionControls({
    workspaceId: "default",
    historyView,
    sessionMode: props.sessionMode ?? "code",
    selectedProjectId,
    selectedSession: props.selectedSession ?? null,
    renameTitle: "  ",
    folderName: " Launch ",
    tagsValue: " release, checklist, , ",
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError,
    setSending,
    setQueuedOutbound,
    setThread,
    loadSidebar,
    setBinding,
  });

  latest = {
    ...hook,
    binding,
    error,
    historyView,
    loadSidebar,
    queuedSessionIds: queuedOutbound.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
    selectedProjectId,
    selectedSessionId,
    sending,
    thread,
  };
  return null;
}

async function renderHarness(props: React.ComponentProps<typeof Harness> = {}) {
  await act(async () => {
    create(<Harness {...props} />);
  });
}

describe("useChatSessionControls Loop 31 behavior", () => {
  beforeEach(() => {
    latest = null;
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.archiveChatSession.mockResolvedValue({});
    apiMocks.archiveWorkspaceChatSessions.mockResolvedValue({});
    apiMocks.assignChatSessionProject.mockResolvedValue({});
    apiMocks.createChatProject.mockResolvedValue({ projectId: "project-new" });
    apiMocks.createChatSession.mockResolvedValue({ sessionId: "session-new", mode: "code" });
    apiMocks.deleteChatSession.mockResolvedValue({});
    apiMocks.pinChatSession.mockResolvedValue({});
    apiMocks.restoreChatSession.mockResolvedValue({});
    apiMocks.setChatSessionBinding.mockResolvedValue({ transport: "integration", target: "#ops" });
    apiMocks.unpinChatSession.mockResolvedValue({});
    apiMocks.updateChatSession.mockResolvedValue({});
  });

  it("creates a project-scoped session from archived history and restores the active list", async () => {
    await renderHarness({ historyView: "archived", selectedProjectId: "project-1", selectedSession: null });

    await act(async () => {
      await latest?.handleCreateSession("cowork");
    });

    expect(apiMocks.createChatSession).toHaveBeenCalledWith({
      workspaceId: "default",
      projectId: "project-1",
      mode: "cowork",
    });
    expect(latest?.historyView).toBe("active");
    expect(latest?.selectedSessionId).toBe("session-new");
    expect(latest?.creatingSessionMode).toBeNull();
    expect(latest?.loadSidebar).toHaveBeenCalledWith("active");
  });

  it("ensures existing sessions without creating, and reports create-session failures", async () => {
    await renderHarness({ selectedSession: session() });

    await act(async () => {
      await latest?.ensureSession();
    });

    expect(apiMocks.createChatSession).not.toHaveBeenCalled();

    apiMocks.createChatSession.mockRejectedValueOnce(new Error("session create failed"));
    await act(async () => {
      await latest?.handleCreateSession("code");
    });

    expect(latest?.error).toBe("session create failed");
    expect(latest?.creatingSessionMode).toBeNull();
  });

  it("creates projects with trimmed inputs and ignores blank project names", async () => {
    await renderHarness({ selectedSession: session() });

    await act(async () => {
      latest?.setProjectName("  Ops review  ");
      latest?.setProjectPath("   ");
    });
    await act(async () => {
      await latest?.handleCreateProject();
    });

    expect(apiMocks.createChatProject).toHaveBeenCalledWith({
      workspaceId: "default",
      name: "Ops review",
      workspacePath: "chat/default",
    });
    expect(latest?.selectedProjectId).toBe("project-new");
    expect(latest?.showProjectCreate).toBe(false);
    expect(latest?.sending).toBe(false);

    apiMocks.createChatProject.mockClear();
    await act(async () => {
      latest?.setProjectName("   ");
    });
    await act(async () => {
      await latest?.handleCreateProject();
    });

    expect(apiMocks.createChatProject).not.toHaveBeenCalled();
  });

  it("archives workspace mission chats and keeps failure state visible", async () => {
    await renderHarness({ historyView: "archived", selectedSession: session() });

    await act(async () => {
      await latest?.handleArchiveWorkspaceMissionChats();
    });

    expect(apiMocks.archiveWorkspaceChatSessions).toHaveBeenCalledWith({
      workspaceId: "default",
      scope: "mission",
    });
    expect(latest?.historyView).toBe("active");
    expect(latest?.selectedSessionId).toBeNull();

    apiMocks.archiveWorkspaceChatSessions.mockRejectedValueOnce(new Error("archive failed"));
    await act(async () => {
      await latest?.handleArchiveWorkspaceMissionChats();
    });

    expect(latest?.error).toBe("archive failed");
    expect(latest?.archiveWorkspacePending).toBe(false);
  });

  it("saves organization metadata and toggles pin/archive/project assignment", async () => {
    await renderHarness({ selectedSession: session() });

    await act(async () => {
      await latest?.handleRenameSession();
      await latest?.handleSaveOrganization();
      await latest?.handleTogglePinSession();
      await latest?.handleToggleArchiveSession();
      await latest?.handleAssignProject("none");
      await latest?.handleAssignProject("project-2");
    });

    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", { title: undefined });
    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", {
      folderName: "Launch",
      tags: ["release", "checklist"],
    });
    expect(apiMocks.pinChatSession).toHaveBeenCalledWith("session-1");
    expect(apiMocks.archiveChatSession).toHaveBeenCalledWith("session-1");
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", undefined);
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", "project-2");

    await renderHarness({ selectedSession: session({ pinned: true, lifecycleStatus: "archived" }) });
    await act(async () => {
      await latest?.handleTogglePinSession();
      await latest?.handleToggleArchiveSession();
    });

    expect(apiMocks.unpinChatSession).toHaveBeenCalledWith("session-1");
    expect(apiMocks.restoreChatSession).toHaveBeenCalledWith("session-1");
  });

  it("clears delete-confirm no-ops and surfaces binding failures with trimmed payloads", async () => {
    await renderHarness({ selectedSession: session() });

    await act(async () => {
      await latest?.confirmDeleteSession();
    });
    expect(apiMocks.deleteChatSession).not.toHaveBeenCalled();

    await act(async () => {
      latest?.handleDeleteSession("Release checklist");
    });
    await act(async () => {
      await latest?.confirmDeleteSession();
    });

    expect(apiMocks.deleteChatSession).toHaveBeenCalledWith("session-1");
    expect(latest?.queuedSessionIds).toEqual(["session-2"]);
    expect(latest?.thread).toBeNull();

    apiMocks.setChatSessionBinding.mockRejectedValueOnce(new Error("binding failed"));
    await act(async () => {
      latest?.setIntegrationConnectionId(" slack:workspace ");
      latest?.setIntegrationTarget(" #ops ");
    });
    await act(async () => {
      await latest?.handleSaveExternalBinding();
    });

    expect(apiMocks.setChatSessionBinding).toHaveBeenCalledWith("session-1", {
      transport: "integration",
      connectionId: "slack:workspace",
      target: "#ops",
      writable: true,
    });
    expect(latest?.error).toBe("binding failed");
    expect(latest?.sessionControlPending).toBeNull();
  });
});
