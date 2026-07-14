import type { ChatMode, ChatSessionBindingRecord, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useState } from "react";
import {
  ApiRequestError,
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
    revision: 1,
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

export type SessionMetadataConflictDraft =
  | { sessionId: string; kind: "rename"; renameTitle: string }
  | { sessionId: string; kind: "organization"; folderName: string; tagsValue: string };

function isSessionRevisionConflict(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409;
}

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
  refreshSessionAggregate?: (sessionId: string) => Promise<void>;
  setSessionMetadataConflictDraft?: (draft: SessionMetadataConflictDraft | null) => void;
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
    refreshSessionAggregate,
    setSessionMetadataConflictDraft,
    setBinding,
  } = input;

  const [creatingSessionMode, setCreatingSessionMode] = useState<ChatMode | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("chat/default");
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [sessionControlPending, setSessionControlPending] = useState<SessionControlPending>(null);
  const [sessionDeleteConfirm, setSessionDeleteConfirm] = useState<{
    sessionId: string;
    revision: number;
    label: string;
  } | null>(null);
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
          { originSurface: mode },
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
      { originSurface: sessionMode },
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
        expectedRevision: selectedSession.revision,
        title: renameTitle.trim() || undefined,
      });
      setSessionMetadataConflictDraft?.(null);
      await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId });
    } catch (err) {
      if (isSessionRevisionConflict(err)) {
        setSessionMetadataConflictDraft?.({
          sessionId: selectedSession.sessionId,
          kind: "rename",
          renameTitle,
        });
        await (refreshSessionAggregate?.(selectedSession.sessionId) ??
          loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
        setError("This chat changed elsewhere. Your rename draft is preserved; review it and retry.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSessionControlPending(null);
    }
  }, [
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    renameTitle,
    selectedSession,
    setError,
    setSessionMetadataConflictDraft,
  ]);

  const handleSaveOrganization = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("organization");
    try {
      await updateChatSession(selectedSession.sessionId, {
        expectedRevision: selectedSession.revision,
        folderName: folderName.trim() || "",
        tags: tagsValue
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setSessionMetadataConflictDraft?.(null);
      await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId });
    } catch (err) {
      if (isSessionRevisionConflict(err)) {
        setSessionMetadataConflictDraft?.({
          sessionId: selectedSession.sessionId,
          kind: "organization",
          folderName,
          tagsValue,
        });
        await (refreshSessionAggregate?.(selectedSession.sessionId) ??
          loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
        setError("This chat changed elsewhere. Your organization draft is preserved; review it and retry.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSessionControlPending(null);
    }
  }, [
    folderName,
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    selectedSession,
    setError,
    setSessionMetadataConflictDraft,
    tagsValue,
  ]);

  const handleTogglePinSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("pin");
    try {
      if (selectedSession.pinned) await unpinChatSession(selectedSession.sessionId, selectedSession.revision);
      else await pinChatSession(selectedSession.sessionId, selectedSession.revision);
      await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId });
    } catch (err) {
      if (isSessionRevisionConflict(err)) {
        await (refreshSessionAggregate?.(selectedSession.sessionId) ??
          loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
        setError("This chat changed elsewhere. Review the latest state, then click pin again.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSessionControlPending(null);
    }
  }, [historyView, loadSidebar, refreshSessionAggregate, selectedSession, setError]);

  const handleToggleArchiveSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("archive");
    try {
      const restoring = selectedSession.lifecycleStatus === "archived";
      if (restoring) await restoreChatSession(selectedSession.sessionId, selectedSession.revision);
      else await archiveChatSession(selectedSession.sessionId, selectedSession.revision);
      const sessionLeavesView = (!restoring && historyView === "active") || (restoring && historyView === "archived");
      if (sessionLeavesView) {
        setQueuedOutbound((current) => current.filter((item) => item.sessionId !== selectedSession.sessionId));
        setThread(null);
        setSelectedSessionId((current) => (current === selectedSession.sessionId ? null : current));
      }
      await loadSidebar(historyView, { bypassCache: true });
    } catch (err) {
      if (isSessionRevisionConflict(err)) {
        await (refreshSessionAggregate?.(selectedSession.sessionId) ??
          loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
        setError("This chat changed elsewhere. Review the latest state, then click archive or restore again.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSessionControlPending(null);
    }
  }, [
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    selectedSession,
    setError,
    setQueuedOutbound,
    setSelectedSessionId,
    setThread,
  ]);

  const handleDeleteSession = useCallback(
    (label: string) => {
      if (!selectedSession) return;
      setSessionDeleteConfirm({
        sessionId: selectedSession.sessionId,
        revision: selectedSession.revision,
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
      await deleteChatSession(sessionDeleteConfirm.sessionId, sessionDeleteConfirm.revision);
      setQueuedOutbound((current) => current.filter((item) => item.sessionId !== sessionDeleteConfirm.sessionId));
      setThread(null);
      setSelectedSessionId((current) => (current === sessionDeleteConfirm.sessionId ? null : current));
      await loadSidebar();
    } catch (err) {
      if (isSessionRevisionConflict(err)) {
        await (refreshSessionAggregate?.(sessionDeleteConfirm.sessionId) ??
          loadSidebar(historyView, { bypassCache: true, preferredSessionId: sessionDeleteConfirm.sessionId }));
        setError("This chat changed elsewhere. Review the latest state, then request deletion again.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSessionControlPending(null);
      setSessionDeleteConfirm(null);
    }
  }, [
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    sessionDeleteConfirm,
    setError,
    setQueuedOutbound,
    setSelectedSessionId,
    setThread,
  ]);

  const handleAssignProject = useCallback(
    async (value: string) => {
      if (!selectedSession) return;
      setSessionControlPending("project");
      try {
        await assignChatSessionProject(
          selectedSession.sessionId,
          value === "none" ? undefined : value,
          selectedSession.revision,
        );
        await loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId });
      } catch (err) {
        if (isSessionRevisionConflict(err)) {
          await (refreshSessionAggregate?.(selectedSession.sessionId) ??
            loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
          setError("This chat changed elsewhere. Review the latest state, then choose the project again.");
        } else {
          setError((err as Error).message);
        }
      } finally {
        setSessionControlPending(null);
      }
    },
    [historyView, loadSidebar, refreshSessionAggregate, selectedSession, setError],
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
        await assignChatSessionProject(selectedSession.sessionId, result.project.projectId, selectedSession.revision);
        await loadSidebar();
        return result.project;
      } catch (err) {
        if (isSessionRevisionConflict(err)) {
          await (refreshSessionAggregate?.(selectedSession.sessionId) ??
            loadSidebar(historyView, { bypassCache: true, preferredSessionId: selectedSession.sessionId }));
        }
        const message = isSessionRevisionConflict(err)
          ? "This chat changed elsewhere. The imported project is available; review the latest state and assign it again."
          : (err as Error).message;
        setError(message);
        throw err;
      } finally {
        setSessionControlPending(null);
      }
    },
    [historyView, loadSidebar, refreshSessionAggregate, selectedSession, setError, workspaceId],
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
