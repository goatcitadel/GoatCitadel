import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import { useChatSessionControls } from "./useChatSessionControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
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
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.createChatSession.mockResolvedValue({ ...selectedSession, sessionId: "session-new" });
    apiMocks.createChatProject.mockResolvedValue({ projectId: "project-new", name: "Project" });
    apiMocks.importChatProject.mockResolvedValue({ project: { projectId: "project-imported", name: "Imported" } });
    apiMocks.setChatSessionBinding.mockResolvedValue({ transport: "integration", connectionId: "discord" });
  });

  it("creates and ensures sessions across selected, placeholder, and new-session paths", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <Harness session={null} selectedSessionId={null} historyView="archived" selectedProjectId="project-1" />,
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

    await act(async () => {
      renderer.update(<Harness key="placeholder" session={null} selectedSessionId="session-placeholder" />);
    });
    const placeholder = await latest!.controls.ensureSession();
    expect(placeholder).toMatchObject({
      sessionId: "session-placeholder",
      workspaceId: "workspace-1",
      mode: "chat",
      scope: "mission",
    });

    await act(async () => {
      renderer.update(<Harness key="selected" session={selectedSession} />);
    });
    await expect(latest!.controls.ensureSession()).resolves.toBe(selectedSession);
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
    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", { title: "Renamed session" });
    expect(apiMocks.updateChatSession).toHaveBeenCalledWith("session-1", {
      folderName: "Focus",
      tags: ["alpha", "beta"],
    });
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", undefined);
  });

  it("pins, archives, deletes, imports code projects, and saves external bindings", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness session={selectedSession} />);
    });

    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(apiMocks.pinChatSession).toHaveBeenCalledWith("session-1");

    await act(async () => {
      renderer.update(<Harness session={{ ...selectedSession, pinned: true }} />);
    });
    await act(async () => {
      await latest!.controls.handleTogglePinSession();
    });
    expect(apiMocks.unpinChatSession).toHaveBeenCalledWith("session-1");

    await act(async () => {
      await latest!.controls.handleToggleArchiveSession();
    });
    expect(apiMocks.archiveChatSession).toHaveBeenCalledWith("session-1");
    expect(latest!.snapshot().queuedOutbound).toEqual([]);
    expect(latest!.snapshot().threadCleared).toBe(true);

    await act(async () => {
      renderer.update(<Harness session={{ ...selectedSession, lifecycleStatus: "archived" }} historyView="archived" />);
    });
    await act(async () => {
      await latest!.controls.handleToggleArchiveSession();
    });
    expect(apiMocks.restoreChatSession).toHaveBeenCalledWith("session-1");

    act(() => {
      latest!.controls.handleDeleteSession("Launch Room");
    });
    expect(latest!.controls.sessionDeleteConfirm).toEqual({ sessionId: "session-1", label: "Launch Room" });
    await act(async () => {
      await latest!.controls.confirmDeleteSession();
    });
    expect(apiMocks.deleteChatSession).toHaveBeenCalledWith("session-1");

    await act(async () => {
      await expect(
        latest!.controls.handleImportCodeProject({
          sourceType: "github_repo",
          repoUrl: "https://github.com/example/repo",
          ref: "main",
        }),
      ).resolves.toEqual({ projectId: "project-imported", name: "Imported" });
    });
    expect(apiMocks.assignChatSessionProject).toHaveBeenCalledWith("session-1", "project-imported");

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
});
