import type { ChatMode, ChatSessionBindingRecord, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useState } from "react";
import {
  archiveChatSession,
  archiveWorkspaceChatSessions,
  assignChatSessionProject,
  createChatProject,
  createChatSession,
  deleteChatSession,
  importChatProject,
  pinChatSession,
  restoreChatSession,
  setChatSessionBinding,
  unpinChatSession,
  updateChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatHistoryView, ChatSidebarLoadOptions } from "./useChatSessionData";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

function createSessionPlaceholder(input: {
  sessionId: string;
  workspaceId: string;
  mode: ChatMode;
  projectId?: string;
}): ChatSessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId: input.sessionId,
    sessionKey: input.sessionId,
    workspaceId: input.workspaceId,
    scope: "mission",
    mode: input.mode,
    includeInHistory: true,
    pinned: false,
    lifecycleStatus: "active",
    projectId: input.projectId,
    channel: "mission",
    account: "local",
    updatedAt: now,
    lastActivityAt: now,
    tokenTotal: 0,
    costUsdTotal: 0,
  };
}

export type SessionControlPending =
  | null
  | "rename"
  | "organization"
  | "pin"
  | "archive"
  | "delete"
  | "project"
  | "binding"
  | "code_source";

export function useChatSessionControls(input: {
  workspaceId: string;
  historyView: ChatHistoryView;
  sessionMode: ChatMode;
  selectedProjectId: string;
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  renameTitle: string;
  folderName: string;
  tagsValue: string;
  setSelectedProjectId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setHistoryView: React.Dispatch<React.SetStateAction<ChatHistoryView>>;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setQueuedOutbound: React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>;
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  loadSidebar: (nextHistoryView?: ChatHistoryView, options?: ChatSidebarLoadOptions) => Promise<void>;
  setBinding: React.Dispatch<React.SetStateAction<ChatSessionBindingRecord | null>>;
}) {
  const {
    workspaceId,
    historyView,
    sessionMode,
    selectedProjectId,
    selectedSessionId,
    selectedSession,
    renameTitle,
    folderName,
    tagsValue,
    setSelectedProjectId,
    setSelectedSessionId,
    setHistoryView,
    setError,
    setSending,
    setQueuedOutbound,
    setThread,
    loadSidebar,
    setBinding,
  } = input;

  const [creatingSessionMode, setCreatingSessionMode] = useState<ChatMode | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("chat/default");
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [sessionControlPending, setSessionControlPending] = useState<SessionControlPending>(null);
  const [sessionDeleteConfirm, setSessionDeleteConfirm] = useState<{ sessionId: string; label: string } | null>(null);
  const [archiveWorkspacePending, setArchiveWorkspacePending] = useState(false);
  const [archiveWorkspaceConfirmOpen, setArchiveWorkspaceConfirmOpen] = useState(false);
  const [integrationConnectionId, setIntegrationConnectionId] = useState("");
  const [integrationTarget, setIntegrationTarget] = useState("");

  const handleCreateSession = useCallback(
    async (mode: ChatMode) => {
      const nextHistoryView: ChatHistoryView = historyView === "archived" ? "active" : historyView;
      setCreatingSessionMode(mode);
      setError(null);
      try {
        const created = await createChatSession(
          selectedProjectId !== "all" && selectedProjectId !== "none"
            ? { workspaceId, projectId: selectedProjectId, mode }
            : { workspaceId, mode },
        );
        if (nextHistoryView !== historyView) {
          setHistoryView(nextHistoryView);
        }
        setSelectedSessionId(created.sessionId);
        await loadSidebar(nextHistoryView, { bypassCache: true, preferredSessionId: created.sessionId });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setCreatingSessionMode(null);
      }
    },
    [historyView, loadSidebar, selectedProjectId, setError, setHistoryView, setSelectedSessionId, workspaceId],
  );

  const ensureSession = useCallback(async (): Promise<ChatSessionRecord> => {
    if (selectedSession) return selectedSession;
    if (selectedSessionId) {
      return createSessionPlaceholder({
        sessionId: selectedSessionId,
        workspaceId,
        mode: sessionMode,
        projectId: selectedProjectId !== "all" && selectedProjectId !== "none" ? selectedProjectId : undefined,
      });
    }
    const nextHistoryView: ChatHistoryView = historyView === "archived" ? "active" : historyView;
    const created = await createChatSession(
      selectedProjectId !== "all" && selectedProjectId !== "none"
        ? { workspaceId, projectId: selectedProjectId, mode: sessionMode }
        : { workspaceId, mode: sessionMode },
    );
    if (nextHistoryView !== historyView) {
      setHistoryView(nextHistoryView);
    }
    setSelectedSessionId(created.sessionId);
    await loadSidebar(nextHistoryView, { bypassCache: true, preferredSessionId: created.sessionId });
    return created;
  }, [
    historyView,
    loadSidebar,
    selectedProjectId,
    selectedSession,
    selectedSessionId,
    sessionMode,
    setHistoryView,
    setSelectedSessionId,
    workspaceId,
  ]);

  const handleCreateProject = useCallback(async () => {
    const name = projectName.trim();
    if (!name) return;
    setSending(true);
    void createChatProject({
      workspaceId,
      name,
      workspacePath: projectPath.trim() || "chat/default",
    })
      .then(async (created) => {
        setProjectName("");
        setShowProjectCreate(false);
        setSelectedProjectId(created.projectId);
        await loadSidebar();
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setSending(false));
  }, [loadSidebar, projectName, projectPath, setError, setSelectedProjectId, setSending, workspaceId]);

  const handleArchiveWorkspaceMissionChats = useCallback(async () => {
    setArchiveWorkspacePending(true);
    setError(null);
    try {
      await archiveWorkspaceChatSessions({ workspaceId, scope: "mission" });
      setHistoryView("active");
      await loadSidebar("active");
      setSelectedSessionId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setArchiveWorkspacePending(false);
    }
  }, [loadSidebar, setError, setHistoryView, setSelectedSessionId, workspaceId]);

  const handleRenameSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("rename");
    try {
      await updateChatSession(selectedSession.sessionId, {
        title: renameTitle.trim() || undefined,
      });
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
    }
  }, [loadSidebar, renameTitle, selectedSession, setError]);

  const handleSaveOrganization = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("organization");
    try {
      await updateChatSession(selectedSession.sessionId, {
        folderName: folderName.trim() || "",
        tags: tagsValue
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      });
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
    }
  }, [folderName, loadSidebar, selectedSession, setError, tagsValue]);

  const handleTogglePinSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("pin");
    try {
      if (selectedSession.pinned) await unpinChatSession(selectedSession.sessionId);
      else await pinChatSession(selectedSession.sessionId);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
    }
  }, [loadSidebar, selectedSession, setError]);

  const handleToggleArchiveSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("archive");
    try {
      if (selectedSession.lifecycleStatus === "archived") await restoreChatSession(selectedSession.sessionId);
      else await archiveChatSession(selectedSession.sessionId);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
    }
  }, [loadSidebar, selectedSession, setError]);

  const handleDeleteSession = useCallback(
    (label: string) => {
      if (!selectedSession) return;
      setSessionDeleteConfirm({
        sessionId: selectedSession.sessionId,
        label,
      });
    },
    [selectedSession],
  );

  const confirmDeleteSession = useCallback(async () => {
    if (!sessionDeleteConfirm) {
      return;
    }
    setSessionControlPending("delete");
    try {
      await deleteChatSession(sessionDeleteConfirm.sessionId);
      setQueuedOutbound((current) => current.filter((item) => item.sessionId !== sessionDeleteConfirm.sessionId));
      setThread(null);
      setSelectedSessionId((current) => (current === sessionDeleteConfirm.sessionId ? null : current));
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
      setSessionDeleteConfirm(null);
    }
  }, [loadSidebar, sessionDeleteConfirm, setError, setQueuedOutbound, setSelectedSessionId, setThread, workspaceId]);

  const handleAssignProject = useCallback(
    async (value: string) => {
      if (!selectedSession) return;
      setSessionControlPending("project");
      try {
        await assignChatSessionProject(selectedSession.sessionId, value === "none" ? undefined : value);
        await loadSidebar();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSessionControlPending(null);
      }
    },
    [loadSidebar, selectedSession, setError],
  );

  const handleImportCodeProject = useCallback(
    async (input: {
      sourceType: "local_folder" | "github_repo";
      name?: string;
      sourcePath?: string;
      repoUrl?: string;
      ref?: string;
    }) => {
      if (!selectedSession) {
        throw new Error("Select a Code session before importing a project source.");
      }
      setSessionControlPending("code_source");
      setError(null);
      try {
        const result = await importChatProject({
          workspaceId,
          ...input,
        });
        await assignChatSessionProject(selectedSession.sessionId, result.project.projectId);
        await loadSidebar();
        return result.project;
      } catch (err) {
        const message = (err as Error).message;
        setError(message);
        throw err;
      } finally {
        setSessionControlPending(null);
      }
    },
    [loadSidebar, selectedSession, setError, workspaceId],
  );

  const handleSaveExternalBinding = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("binding");
    try {
      const next = await setChatSessionBinding(selectedSession.sessionId, {
        transport: "integration",
        connectionId: integrationConnectionId.trim(),
        target: integrationTarget.trim(),
        writable: true,
      });
      setBinding(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSessionControlPending(null);
    }
  }, [integrationConnectionId, integrationTarget, selectedSession, setBinding, setError]);

  return {
    creatingSessionMode,
    projectName,
    setProjectName,
    projectPath,
    setProjectPath,
    showProjectCreate,
    setShowProjectCreate,
    sessionControlPending,
    sessionDeleteConfirm,
    setSessionDeleteConfirm,
    archiveWorkspacePending,
    archiveWorkspaceConfirmOpen,
    setArchiveWorkspaceConfirmOpen,
    integrationConnectionId,
    setIntegrationConnectionId,
    integrationTarget,
    setIntegrationTarget,
    handleCreateSession,
    ensureSession,
    handleCreateProject,
    handleArchiveWorkspaceMissionChats,
    handleRenameSession,
    handleSaveOrganization,
    handleTogglePinSession,
    handleToggleArchiveSession,
    handleDeleteSession,
    confirmDeleteSession,
    handleAssignProject,
    handleImportCodeProject,
    handleSaveExternalBinding,
  };
}
