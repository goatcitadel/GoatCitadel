import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import { useChatSessionControls } from "./useChatSessionControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  ApiRequestError: class ApiRequestError extends Error {
    public readonly status?: number;
    public constructor(message: string, options: { status?: number }) {
      super(message);
      this.status = options.status;
    }
  },
  archiveChatSession: vi.fn(),
  archiveWorkspaceChatSessions: vi.fn(),
  assignChatSessionProject: vi.fn(),
  createChatProject: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  importChatProject: vi.fn(),
  pinChatSession: vi.fn(),
  restoreChatSession: vi.fn(),
  setChatSessionBinding: vi.fn(),
  unpinChatSession: vi.fn(),
  updateChatSession: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ApiRequestError: apiMocks.ApiRequestError,
  archiveChatSession: apiMocks.archiveChatSession,
  archiveWorkspaceChatSessions: apiMocks.archiveWorkspaceChatSessions,
  assignChatSessionProject: apiMocks.assignChatSessionProject,
  createChatProject: apiMocks.createChatProject,
  createChatSession: apiMocks.createChatSession,
  deleteChatSession: apiMocks.deleteChatSession,
  importChatProject: apiMocks.importChatProject,
  pinChatSession: apiMocks.pinChatSession,
  restoreChatSession: apiMocks.restoreChatSession,
  setChatSessionBinding: apiMocks.setChatSessionBinding,
  unpinChatSession: apiMocks.unpinChatSession,
  updateChatSession: apiMocks.updateChatSession,
}));

const selectedSession = {
  sessionId: "session-1",
  revision: 7,
  sessionKey: "session-1",
  workspaceId: "workspace-1",
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  projectId: "project-1",
  channel: "mission",
  account: "local",
  updatedAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  tokenTotal: 0,
  costUsdTotal: 0,
} as ChatSessionRecord;

interface HarnessApi {
  controls: ReturnType<typeof useChatSessionControls>;
  loadSidebar: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
  setSending: ReturnType<typeof vi.fn>;
  snapshot: () => {
    selectedSessionId: string | null;
    selectedProjectId: string;
    historyView: "active" | "archived";
    queuedOutbound: OutboundQueueItem[];
    threadCleared: boolean;
    binding: unknown;
  };
}

let latest: HarnessApi | null = null;

function Harness(props: {
  session?: ChatSessionRecord | null;
  selectedSessionId?: string | null;
  historyView?: "active" | "archived";
  selectedProjectId?: string;
  onSessionCreated?: (session: ChatSessionRecord) => void;
  refreshSessionAggregate?: (sessionId: string) => Promise<void>;
  setSessionMetadataConflictDraft?: Parameters<typeof useChatSessionControls>[0]["setSessionMetadataConflictDraft"];
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(props.selectedProjectId ?? "all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    props.selectedSessionId === undefined ? (props.session?.sessionId ?? null) : props.selectedSessionId,
  );
  const [historyView, setHistoryView] = useState<"active" | "archived">(props.historyView ?? "active");
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([
    {
      id: "queue-1",
      action: "send",
      sessionId: "session-1",
      content: "queued",
      attachments: [],
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ]);
  const [threadCleared, setThreadCleared] = useState(false);
  const [binding, setBinding] = useState<unknown>(null);
  const loadSidebar = React.useRef(vi.fn(async () => undefined));
  const setError = React.useRef(vi.fn());
  const setSending = React.useRef(vi.fn());
  const controls = useChatSessionControls({
    workspaceId: "workspace-1",
    historyView,
    sessionMode: "chat",
    selectedProjectId,
    selectedSessionId,
    selectedSession: props.session ?? null,
    renameTitle: "  Renamed session  ",
    folderName: "  Focus  ",
    tagsValue: " alpha, beta, , ",
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError: setError.current,
    setSending: setSending.current,
    setQueuedOutbound,
    setThread: (value) => {
      setThreadCleared(value === null);
    },
    loadSidebar: loadSidebar.current,
    onSessionCreated: props.onSessionCreated,
    refreshSessionAggregate: props.refreshSessionAggregate,
    setSessionMetadataConflictDraft: props.setSessionMetadataConflictDraft,
    setBinding,
  });

  latest = {
    controls,
    loadSidebar: loadSidebar.current,
    setError: setError.current,
    setSending: setSending.current,
    snapshot: () => ({
      selectedSessionId,
      selectedProjectId,
      historyView,
      queuedOutbound,
      threadCleared,
      binding,
    }),
  };
  return null;
}

describe("useChatSessionControls", () => {
  beforeEach(() => {
    latest = null;
    Object.values(apiMocks).forEach((mock) => {
      if ("mockReset" in mock) {
        mock.mockReset();
      }
    });
    apiMocks.createChatSession.mockResolvedValue({ ...selectedSession, sessionId: "session-new" });
    apiMocks.createChatProject.mockResolvedValue({ projectId: "project-new", name: "Project" });
    apiMocks.importChatProject.mockResolvedValue({ project: { projectId: "project-imported", name: "Imported" } });
    apiMocks.setChatSessionBinding.mockResolvedValue({ transport: "integration", connectionId: "discord" });
  });

  it("creates and ensures sessions across selected, placeholder, and new-session paths", async () => {
    const onSessionCreated = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness
          session={null}
          selectedSessionId={null}
          historyView="archived"
          selectedProjectId="project-1"
          onSessionCreated={onSessionCreated}
        />,
      );
    });

    await act(async () => {
      await latest!.controls.handleCreateSession("chat");
    });
    expect(apiMocks.createChatSession).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", projectId: "project-1", mode: "chat" },
      { originSurface: "chat" },
    );
    expect(latest!.snapshot()).toMatchObject({ selectedSessionId: "session-new", historyView: "active" });
    expect(latest!.loadSidebar).toHaveBeenCalledWith("active", {
      bypassCache: true,
      preferredSessionId: "session-new",
    });
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-new" }));

    await act(async () => {
      renderer.update(
        <Harness
          key="placeholder"
          session={null}
          selectedSessionId="session-placeholder"
          onSessionCreated={onSessionCreated}
        />,
      );
    });
    const placeholder = await latest!.controls.ensureSession();
    expect(placeholder).toMatchObject({
      sessionId: "session-placeholder",
      workspaceId: "workspace-1",
      mode: "chat",
      scope: "mission",
    });
    expect(onSessionCreated).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<Harness key="selected" session={selectedSession} onSessionCreated={onSessionCreated} />);
    });
    await expect(latest!.controls.ensureSession()).resolves.toBe(selectedSession);
    expect(onSessionCreated).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(
        <Harness
          key="new"
          session={null}
          selectedSessionId={null}
          historyView="archived"
          onSessionCreated={onSessionCreated}
        />,
      );
    });
    let created: ChatSessionRecord | null = null;
    await act(async () => {
      created = await latest!.controls.ensureSession();
    });
    expect(created).toMatchObject({ sessionId: "session-new" });
    expect(apiMocks.createChatSession).toHaveBeenLastCalledWith(
      { workspaceId: "workspace-1", mode: "chat" },
      { originSurface: "chat" },
    );
    expect(latest!.snapshot()).toMatchObject({ selectedSessionId: "session-new", historyView: "active" });
    expect(onSessionCreated).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer.update(
        <Harness
          key="new-project"
          session={null}
          selectedSessionId={null}
          selectedProjectId="project-1"
          onSessionCreated={onSessionCreated}
        />,
      );
    });
    await act(async () => {
      created = await latest!.controls.ensureSession();
    });
    expect(created).toMatchObject({ sessionId: "session-new" });
    expect(apiMocks.createChatSession).toHaveBeenLastCalledWith(
      { workspaceId: "workspace-1", projectId: "project-1", mode: "chat" },
      { originSurface: "chat" },
    );
    expect(onSessionCreated).toHaveBeenCalledTimes(3);
  });

  it("creates projects, archives workspace chats, and persists session metadata controls", async () => {
    await act(async () => {
      create(<Harness session={selectedSession} />);
    });

    await act(async () => {
      latest!.controls.setProjectName("  Project One  ");
      latest!.controls.setProjectPath("  ");
    });
    await act(async () => {
      latest!.controls.handleCreateProject();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.createChatProject).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      name: "Project One",
      workspacePath: "chat/default",
    });
    expect(latest!.snapshot().selectedProjectId).toBe("project-new");
    expect(latest!.setSending).toHaveBeenCalledWith(false);

    await act(async () => {
      await latest!.controls.handleArchiveWorkspaceMissionChats();
    });
    expect(apiMocks.archiveWorkspaceChatSessions).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scope: "mission",
    });
    expect(latest!.snapshot().selectedSessionId).toBeNull();

    await act(async () => {
      await latest!.controls.handleRenameSession();
      await latest!.controls.handleSaveOrganization();
      await latest!.controls.handleAssignProject("none");
    });
    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", {
      expectedRevision: 7,
      title: "Renamed session",
    });
    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", {
      expectedRevision: 7,
      folderName: "Focus",
      tags: ["alpha", "beta"],
    });
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", undefined, 7);
  });

  it("pins, archives, deletes, imports code projects, and saves external bindings", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness session={selectedSession} />);
    });

    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(apiMocks.pinChatSession).toHaveBeenCalledWith("session-1", 7);

    await act(async () => {
      renderer.update(<Harness session={{ ...selectedSession, pinned: true }} />);
    });
    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(apiMocks.unpinChatSession).toHaveBeenCalledWith("session-1", 7);

    await act(async () => {
      await latest!.controls.handleToggleArchiveSession();
    });
    expect(apiMocks.archiveChatSession).toHaveBeenCalledWith("session-1", 7);
    expect(latest!.snapshot().queuedOutbound).toEqual([]);
    expect(latest!.snapshot().threadCleared).toBe(true);

    await act(async () => {
      renderer.update(<Harness session={{ ...selectedSession, lifecycleStatus: "archived" }} historyView="archived" />);
    });
    await act(async () => {
      await latest!.controls.handleToggleArchiveSession();
    });
    expect(apiMocks.restoreChatSession).toHaveBeenCalledWith("session-1", 7);

    act(() => {
      latest!.controls.handleDeleteSession("Launch Room");
    });
    expect(latest!.controls.sessionDeleteConfirm).toEqual({
      sessionId: "session-1",
      revision: 7,
      label: "Launch Room",
    });
    await act(async () => {
      await latest!.controls.confirmDeleteSession();
    });
    expect(apiMocks.deleteChatSession).toHaveBeenCalledWith("session-1", 7);

    await act(async () => {
      await expect(
        latest!.controls.handleImportCodeProject({
          sourceType: "github_repo",
          repoUrl: "https://github.com/example/repo",
          ref: "main",
        }),
      ).resolves.toEqual({ projectId: "project-imported", name: "Imported" });
    });
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", "project-imported", 7);

    await act(async () => {
      latest!.controls.setIntegrationConnectionId(" discord ");
      latest!.controls.setIntegrationTarget(" channel-1 ");
    });
    await act(async () => {
      await latest!.controls.handleSaveExternalBinding();
    });
    expect(apiMocks.setChatSessionBinding).toHaveBeenCalledWith("session-1", {
      transport: "integration",
      connectionId: "discord",
      target: "channel-1",
      writable: true,
    });
    expect(latest!.snapshot().binding).toEqual({ transport: "integration", connectionId: "discord" });
  });

  it("surfaces errors for failed controls and missing code session imports", async () => {
    apiMocks.createChatSession.mockRejectedValueOnce(new Error("create failed"));
    await act(async () => {
      create(<Harness session={null} selectedSessionId={null} />);
    });
    await act(async () => {
      await latest!.controls.handleCreateSession("chat");
    });
    expect(latest!.setError).toHaveBeenCalledWith("create failed");

    await expect(
      latest!.controls.handleImportCodeProject({ sourceType: "local_folder", sourcePath: "F:/code/repo" }),
    ).rejects.toThrow("Select a Code session before importing a project source.");
  });

  it("surfaces repository failures for session organization controls", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness session={selectedSession} />);
    });

    await act(async () => {
      latest!.controls.handleCreateProject();
      await Promise.resolve();
    });
    expect(apiMocks.createChatProject).not.toHaveBeenCalled();

    await act(async () => {
      latest!.controls.setProjectName("Broken Project");
      await Promise.resolve();
    });
    apiMocks.createChatProject.mockRejectedValueOnce(new Error("project failed"));
    await act(async () => {
      latest!.controls.handleCreateProject();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest!.setError).toHaveBeenCalledWith("project failed");

    apiMocks.archiveWorkspaceChatSessions.mockRejectedValueOnce(new Error("workspace archive failed"));
    await act(async () => {
      await latest!.controls.handleArchiveWorkspaceMissionChats();
    });
    expect(latest!.setError).toHaveBeenCalledWith("workspace archive failed");

    apiMocks.updateChatSession.mockRejectedValueOnce(new Error("rename failed"));
    await act(async () => {
      await latest!.controls.handleRenameSession();
    });
    expect(latest!.setError).toHaveBeenCalledWith("rename failed");

    apiMocks.updateChatSession.mockRejectedValueOnce(new Error("organization failed"));
    await act(async () => {
      await latest!.controls.handleSaveOrganization();
    });
    expect(latest!.setError).toHaveBeenCalledWith("organization failed");

    apiMocks.pinChatSession.mockRejectedValueOnce(new Error("pin failed"));
    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(latest!.setError).toHaveBeenCalledWith("pin failed");

    apiMocks.archiveChatSession.mockRejectedValueOnce(new Error("archive failed"));
    await act(async () => {
      await latest!.controls.handleToggleArchiveSession();
    });
    expect(latest!.setError).toHaveBeenCalledWith("archive failed");

    act(() => {
      latest!.controls.handleDeleteSession("Launch Room");
    });
    apiMocks.deleteChatSession.mockRejectedValueOnce(new Error("delete failed"));
    await act(async () => {
      await latest!.controls.confirmDeleteSession();
    });
    expect(latest!.setError).toHaveBeenCalledWith("delete failed");

    apiMocks.assignChatSessionProject.mockRejectedValueOnce(new Error("assign failed"));
    await act(async () => {
      await latest!.controls.handleAssignProject("project-2");
    });
    expect(latest!.setError).toHaveBeenCalledWith("assign failed");

    apiMocks.importChatProject.mockRejectedValueOnce(new Error("import failed"));
    await act(async () => {
      await expect(
        latest!.controls.handleImportCodeProject({ sourceType: "local_folder", sourcePath: "F:/code/repo" }),
      ).rejects.toThrow("import failed");
    });
    expect(latest!.setError).toHaveBeenCalledWith("import failed");

    apiMocks.setChatSessionBinding.mockRejectedValueOnce(new Error("binding failed"));
    await act(async () => {
      await latest!.controls.handleSaveExternalBinding();
    });
    expect(latest!.setError).toHaveBeenCalledWith("binding failed");

    await act(async () => {
      renderer.update(<Harness session={null} selectedSessionId={null} />);
    });
    act(() => {
      latest!.controls.handleDeleteSession("No session");
    });
    await act(async () => {
      await latest!.controls.confirmDeleteSession();
      await latest!.controls.handleRenameSession();
      await latest!.controls.handleSaveOrganization();
      await latest!.controls.handleTogglePinSession();
      await latest!.controls.handleToggleArchiveSession();
      await latest!.controls.handleAssignProject("project-2");
      await latest!.controls.handleSaveExternalBinding();
    });
  });

  it("refreshes actual 409 conflicts, preserves editable drafts, and does not replay non-draft actions", async () => {
    const refreshSessionAggregate = vi.fn(async () => undefined);
    const setSessionMetadataConflictDraft = vi.fn();
    await act(async () => {
      create(
        <Harness
          session={selectedSession}
          refreshSessionAggregate={refreshSessionAggregate}
          setSessionMetadataConflictDraft={setSessionMetadataConflictDraft}
        />,
      );
    });

    apiMocks.updateChatSession.mockRejectedValueOnce(new apiMocks.ApiRequestError("stale rename", { status: 409 }));
    await act(async () => {
      await latest!.controls.handleRenameSession();
    });
    expect(refreshSessionAggregate).toHaveBeenCalledWith("session-1");
    expect(setSessionMetadataConflictDraft).toHaveBeenCalledWith({
      sessionId: "session-1",
      kind: "rename",
      renameTitle: "  Renamed session  ",
    });
    expect(setSessionMetadataConflictDraft.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSessionAggregate.mock.invocationCallOrder[0]!,
    );
    expect(apiMocks.updateChatSession).toHaveBeenCalledTimes(1);
    expect(latest!.setError).toHaveBeenCalledWith(
      "This chat changed elsewhere. Your rename draft is preserved; review it and retry.",
    );

    apiMocks.updateChatSession.mockRejectedValueOnce(
      new apiMocks.ApiRequestError("stale organization", { status: 409 }),
    );
    await act(async () => {
      await latest!.controls.handleSaveOrganization();
    });
    expect(setSessionMetadataConflictDraft).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      kind: "organization",
      folderName: "  Focus  ",
      tagsValue: " alpha, beta, , ",
    });
    expect(setSessionMetadataConflictDraft.mock.invocationCallOrder[1]).toBeLessThan(
      refreshSessionAggregate.mock.invocationCallOrder[1]!,
    );

    apiMocks.pinChatSession.mockRejectedValueOnce(new apiMocks.ApiRequestError("stale pin", { status: 409 }));
    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(refreshSessionAggregate).toHaveBeenCalledTimes(3);
    expect(apiMocks.pinChatSession).toHaveBeenCalledTimes(1);
    expect(latest!.setError).toHaveBeenCalledWith(
      "This chat changed elsewhere. Review the latest state, then click pin again.",
    );
  });
});
