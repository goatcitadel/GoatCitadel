import type { ChatMode, ChatSessionBindingRecord, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  type ChatSessionsResponse,
  archiveChatSession,
  archiveWorkspaceChatSessions,
  assignChatSessionProject,
  createChatProject,
  createChatSession,
  fetchChatSessionStatus,
  fetchChatSessionBinding,
  deleteChatSession,
  importChatProject,
  pinChatSession,
  restoreChatSession,
  setChatSessionBinding,
  unpinChatSession,
  updateChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  assertChatSessionCreated,
  beginChatSessionCreation,
  chatSessionCreationKey,
  publishChatSessionCreation,
  readChatSessionCreation,
  type ChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useChatContextMutationOwner } from "./useChatContextMutationOwner";
import { assertContextRecord } from "./context-mutation-evidence";
import { useManualChatSessionCreation } from "./useManualChatSessionCreation";
import type { ChatHistoryView, ChatSidebarLoadOptions } from "./useChatSessionData";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import { formatSessionLabel } from "./useMissionControlSurfaceState";

/** A conversation left the current list (archived or deleted); the host moves the address and says so. */
export interface SessionRemovedFromView {
  sessionId: string;
  nextSessionId: string | null;
  label: string;
  kind: "archived" | "deleted";
}

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

/** Ephemeral provenance for the automatic session created by the first outbound send. */
export interface InitialOutboundSessionCreation {
  workspaceId: string;
  sessionId: string;
}

function isSessionRevisionConflict(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409;
}

export function useChatSessionControls(input: {
  historicalRevisionRef?: { readonly current: number };
  historicalReadOnly?: boolean;

  selectionRevisionRef?: { readonly current: number };
  sendingRevisionRef?: { readonly current: number };
  workspaceId: string;
  viewIdentity?: string;
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
  setSessions: React.Dispatch<React.SetStateAction<ChatSessionsResponse | null>>;
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  loadSidebar: (nextHistoryView?: ChatHistoryView, options?: ChatSidebarLoadOptions) => Promise<void>;
  onSessionCreated?: (session: ChatSessionRecord) => void;
  initialOutboundSessionCreationRef?: React.MutableRefObject<InitialOutboundSessionCreation | null>;
  refreshSessionAggregate?: (
    sessionId: string,
    options?: Pick<ChatSidebarLoadOptions, "preserveSelection">,
  ) => Promise<void>;
  setSessionMetadataConflictDraft?: (draft: SessionMetadataConflictDraft | null) => void;
  setBinding: React.Dispatch<React.SetStateAction<ChatSessionBindingRecord | null>>;
  /** The conversation to open once `sessionId` leaves the list (the next one down, if any). */
  nextSessionAfterRemoval?: (sessionId: string) => string | null;
  onSessionRemoved?: (removed: SessionRemovedFromView) => void;
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
    setSessions,
    loadSidebar,
    onSessionCreated,
    initialOutboundSessionCreationRef,
    refreshSessionAggregate,
    setSessionMetadataConflictDraft,
    setBinding,
    nextSessionAfterRemoval,
    onSessionRemoved,
  } = input;

  const selectionScopeRef = useRef({ workspaceId, selectedSessionId, viewIdentity: input.viewIdentity });
  if (
    selectionScopeRef.current.workspaceId !== workspaceId ||
    selectionScopeRef.current.selectedSessionId !== selectedSessionId ||
    selectionScopeRef.current.viewIdentity !== input.viewIdentity
  ) {
    selectionScopeRef.current = { workspaceId, selectedSessionId, viewIdentity: input.viewIdentity };
  }
  const renderedSelectionScope = selectionScopeRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("chat/default");
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [sessionControlPending, setSessionControlPendingState] = useState<SessionControlPending>(null);
  const sessionControlRevisionRef = useRef(0);
  const setSessionControlPending = useCallback((next: SessionControlPending) => {
    sessionControlRevisionRef.current += 1;
    setSessionControlPendingState(next);
  }, []);
  const [sessionDeleteConfirm, setSessionDeleteConfirm] = useState<{
    sessionId: string;
    revision: number;
    label: string;
  } | null>(null);
  const [archiveWorkspacePending, setArchiveWorkspacePending] = useState(false);
  const [archiveWorkspaceConfirmOpen, setArchiveWorkspaceConfirmOpen] = useState(false);
  const [integrationConnectionId, setIntegrationConnectionId] = useState("");
  const [integrationTarget, setIntegrationTarget] = useState("");
  const bindingMutationOwner = useChatContextMutationOwner({
    family: "binding",
    workspaceId,
    sessionId: selectedSession?.sessionId ?? null,
    sessionWorkspaceId: selectedSession?.workspaceId,
    historicalRevisionRef: input.historicalRevisionRef,
    historicalReadOnly: input.historicalReadOnly,
    selectionRevisionRef: input.selectionRevisionRef,
    sendingRevisionRef: input.sendingRevisionRef,
    setError,
  });
  const {
    run: runBindingMutation,
    inspect: inspectBindingMutation,
    projection: bindingProjection,
  } = bindingMutationOwner;

  const {
    create: handleCreateSession,
    creatingSessionMode,
    isCurrent: isCreationViewCurrent,
  } = useManualChatSessionCreation({
    workspaceId,
    viewIdentity: input.viewIdentity,
    selectedProjectId,
    selectedSessionId,
    historyView,
    setSessions,
    setHistoryView,
    setSelectedSessionId,
    setError,
    onSessionCreated,
  });

  const ensureSession = useCallback(
    async (onResolved?: (session: ChatSessionRecord) => void): Promise<ChatSessionRecord> => {
      if (selectedSession) return selectedSession;
      if (selectedSessionId) {
        return createSessionPlaceholder({
          sessionId: selectedSessionId,
          workspaceId,
          mode: sessionMode,
          projectId: selectedProjectId !== "all" && selectedProjectId !== "none" ? selectedProjectId : undefined,
        });
      }
      if (!isCreationViewCurrent())
        throw new DOMException("The first-send conversation view changed before creation.", "AbortError");
      const creationScope = selectionScopeRef.current;
      const nextHistoryView: ChatHistoryView = historyView === "archived" ? "active" : historyView;
      const installation = getGatewayApiBaseUrl();
      const creationKey = chatSessionCreationKey(installation, workspaceId);
      const attempt: ChatSessionCreation = {
        state: "pending",
        mode: sessionMode,
        message: "Creating the conversation for this first send…",
      };
      if (!beginChatSessionCreation(creationKey, attempt))
        throw new Error(readChatSessionCreation(creationKey)!.message);
      let created: ChatSessionRecord;
      try {
        const projectId = selectedProjectId !== "all" && selectedProjectId !== "none" ? selectedProjectId : undefined;
        created = await createChatSession(
          projectId ? { workspaceId, projectId, mode: sessionMode } : { workspaceId, mode: sessionMode },
          { originSurface: sessionMode },
        );
        assertChatSessionCreated(created, workspaceId, projectId);
        attempt.sessionId = created.sessionId;
        const saved = await fetchChatSessionStatus(created.sessionId, new AbortController().signal);
        if (
          getGatewayApiBaseUrl() !== installation ||
          saved.sessionId !== created.sessionId ||
          saved.workspaceId !== workspaceId
        ) {
          throw new Error("The independent conversation read does not match the first-send creation owner.");
        }
        attempt.state = "confirmed";
        attempt.message = "Conversation created and independently verified.";
        publishChatSessionCreation(creationKey, attempt);
      } catch (cause) {
        attempt.state = "unknown";
        attempt.message =
          "Creation outcome is unconfirmed. Check conversation history before creating another; this app will not retry.";
        publishChatSessionCreation(creationKey, attempt);
        throw cause;
      }
      if (!mountedRef.current || selectionScopeRef.current !== creationScope || !isCreationViewCurrent()) {
        // A navigation abort must not restore the old draft into the newly selected scope.
        throw new DOMException("Session selection changed while the new conversation was being created.", "AbortError");
      }
      onResolved?.(created);
      if (initialOutboundSessionCreationRef) {
        initialOutboundSessionCreationRef.current = { workspaceId, sessionId: created.sessionId };
      }
      if (nextHistoryView !== historyView) {
        setHistoryView(nextHistoryView);
      }
      setSelectedSessionId(created.sessionId);
      onSessionCreated?.(created);
      await loadSidebar(nextHistoryView, { bypassCache: true, preserveSelection: true });
      return created;
    },
    [
      historyView,
      initialOutboundSessionCreationRef,
      isCreationViewCurrent,
      loadSidebar,
      onSessionCreated,
      selectedProjectId,
      selectedSession,
      selectedSessionId,
      sessionMode,
      setHistoryView,
      setSelectedSessionId,
      workspaceId,
    ],
  );

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
    setSessionControlPending,
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
    setSessionControlPending,
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
  }, [setSessionControlPending, historyView, loadSidebar, refreshSessionAggregate, selectedSession, setError]);

  const handleToggleArchiveSession = useCallback(async () => {
    if (!selectedSession) return;
    setSessionControlPending("archive");
    try {
      const restoring = selectedSession.lifecycleStatus === "archived";
      if (restoring) await restoreChatSession(selectedSession.sessionId, selectedSession.revision);
      else await archiveChatSession(selectedSession.sessionId, selectedSession.revision);
      let nextSessionId: string | null = null;
      if (!restoring && historyView === "active") {
        nextSessionId = nextSessionAfterRemoval?.(selectedSession.sessionId) ?? null;
        setQueuedOutbound((current) => current.filter((item) => item.sessionId !== selectedSession.sessionId));
        setThread(null);
        setSelectedSessionId((current) => (current === selectedSession.sessionId ? nextSessionId : current));
        onSessionRemoved?.({
          sessionId: selectedSession.sessionId,
          nextSessionId,
          label: formatSessionLabel(selectedSession),
          kind: "archived",
        });
      }
      if (restoring && historyView === "archived") {
        setHistoryView("active");
        setSelectedSessionId(selectedSession.sessionId);
        await loadSidebar("active", { bypassCache: true, preferredSessionId: selectedSession.sessionId });
      } else {
        await loadSidebar(historyView, { bypassCache: true, preferredSessionId: nextSessionId ?? undefined });
      }
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
    setSessionControlPending,
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    selectedSession,
    setError,
    setQueuedOutbound,
    setHistoryView,
    setSelectedSessionId,
    setThread,
    nextSessionAfterRemoval,
    onSessionRemoved,
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
      const nextSessionId = nextSessionAfterRemoval?.(sessionDeleteConfirm.sessionId) ?? null;
      setQueuedOutbound((current) => current.filter((item) => item.sessionId !== sessionDeleteConfirm.sessionId));
      setThread(null);
      setSelectedSessionId((current) => (current === sessionDeleteConfirm.sessionId ? nextSessionId : current));
      onSessionRemoved?.({
        sessionId: sessionDeleteConfirm.sessionId,
        nextSessionId,
        label: sessionDeleteConfirm.label,
        kind: "deleted",
      });
      await loadSidebar(undefined, { preferredSessionId: nextSessionId ?? undefined });
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
    setSessionControlPending,
    historyView,
    loadSidebar,
    refreshSessionAggregate,
    sessionDeleteConfirm,
    setError,
    setQueuedOutbound,
    setSelectedSessionId,
    setThread,
    nextSessionAfterRemoval,
    onSessionRemoved,
  ]);

  const handleAssignProject = useCallback(
    async (value: string) => {
      if (!selectedSession) return;
      const assignmentScope = renderedSelectionScope;
      if (selectionScopeRef.current !== assignmentScope) return;
      if (
        assignmentScope.selectedSessionId !== selectedSession.sessionId ||
        assignmentScope.workspaceId !== (selectedSession.workspaceId ?? "default")
      )
        return;
      const installation = getGatewayApiBaseUrl();
      const isCurrent = () =>
        mountedRef.current && selectionScopeRef.current === assignmentScope && getGatewayApiBaseUrl() === installation;
      setSessionControlPending("project");
      try {
        await assignChatSessionProject(
          selectedSession.sessionId,
          value === "none" ? undefined : value,
          selectedSession.revision,
        );
        if (isCurrent()) await loadSidebar(historyView, { bypassCache: true, preserveSelection: true });
      } catch (err) {
        if (!isCurrent()) return;
        if (isSessionRevisionConflict(err)) {
          await (refreshSessionAggregate?.(selectedSession.sessionId, { preserveSelection: true }) ??
            loadSidebar(historyView, { bypassCache: true, preserveSelection: true }));
          if (isCurrent())
            setError("This chat changed elsewhere. Review the latest state, then choose the project again.");
        } else {
          setError((err as Error).message);
        }
      } finally {
        setSessionControlPending(null);
      }
    },
    [
      setSessionControlPending,
      historyView,
      loadSidebar,
      refreshSessionAggregate,
      selectedSession,
      setError,
      renderedSelectionScope,
    ],
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
    [
      setSessionControlPending,
      historyView,
      loadSidebar,
      refreshSessionAggregate,
      selectedSession,
      setError,
      workspaceId,
    ],
  );

  const handleSaveExternalBinding = useCallback(
    async (reviewedDraft?: { connectionId: string; target: string }): Promise<void> => {
      if (!selectedSession || sessionControlPending) return;
      const connectionId = (reviewedDraft?.connectionId ?? integrationConnectionId).trim();
      const target = (reviewedDraft?.target ?? integrationTarget).trim();
      await runBindingMutation(
        "external-binding",
        () =>
          setChatSessionBinding(selectedSession.sessionId, {
            transport: "integration",
            connectionId,
            target,
            writable: true,
          }),
        (next) => {
          const id = assertContextRecord(
            next,
            selectedSession.sessionId,
            workspaceId,
            "sessionId",
            selectedSession.sessionId,
          );
          if (
            next.transport !== "integration" ||
            next.connectionId !== connectionId ||
            next.target !== target ||
            next.writable !== true
          )
            throw new TypeError("The binding receipt does not confirm the reviewed writable integration target.");
          return [id];
        },
        (next, publicationCurrent) => setBinding((current) => (publicationCurrent() ? next : current)),
        {
          begin: () => setSessionControlPending("binding"),
          end: () => setSessionControlPending(null),
          revisionRef: sessionControlRevisionRef,
        },
      );
    },
    [
      integrationConnectionId,
      integrationTarget,
      selectedSession,
      sessionControlPending,
      workspaceId,
      runBindingMutation,
      setBinding,
      setSessionControlPending,
    ],
  );
  const handleInspectExternalBinding = useCallback(async (): Promise<void> => {
    if (!selectedSession) return;
    await inspectBindingMutation(
      () => fetchChatSessionBinding(selectedSession.sessionId),
      (result) => {
        if (result.item !== null)
          assertContextRecord(
            result.item,
            selectedSession.sessionId,
            workspaceId,
            "sessionId",
            selectedSession.sessionId,
          );
      },
      (result, publicationCurrent) => setBinding((current) => (publicationCurrent() ? result.item : current)),
    );
  }, [selectedSession, workspaceId, inspectBindingMutation, setBinding]);

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
    bindingMutation: { ...bindingProjection, onInspect: handleInspectExternalBinding },
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
