import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { ChatAttachmentRecord, ChatMode, ChatSessionPrefsPatch, ChatSessionRecord } from "@goatcitadel/contracts";
import { uploadChatAttachment } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayAccessRevision, getGatewayCallerScope, getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { UploadAttachmentOptions } from "./multimodal-action-types";
import type { CommandSuggestionItem } from "../chat-command-suggestions";

export function isPlanningModeToggleShortcut(input: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  return input.key === "Tab" && Boolean(input.shiftKey) && !input.altKey && !input.ctrlKey && !input.metaKey;
}

export function applyComposerSuggestion(currentDraft: string, suggestion: string): string {
  if (suggestion.startsWith("$")) {
    const replaced = currentDraft.replace(/(^|\s)\$[^\s]*$/, `$1${suggestion}`);
    return `${replaced === currentDraft ? suggestion : replaced} `;
  }
  return `${suggestion} `;
}

export function useChatComposerInteractions(input: {
  workspaceId?: string;
  selectedSessionId?: string | null;
  selectionRevisionRef?: { readonly current: number };
  draft: string;
  lastEditableDraft?: string | null;
  commandSuggestions: CommandSuggestionItem[];
  commandIndex: number;
  error: string | null;
  dockOpen: boolean;
  sending: boolean;
  selectedSession: ChatSessionRecord | null;
  messageMode: ChatMode;
  ensureSession: (onResolved?: (session: ChatSessionRecord) => void) => Promise<ChatSessionRecord>;
  handleSend: () => Promise<void>;
  handleCreateSession: (mode: ChatMode) => Promise<void>;
  handleArchiveWorkspaceMissionChats: () => Promise<void>;
  handleRunQuickResearch: () => Promise<void>;
  handlePrefPatch: (patch: ChatSessionPrefsPatch) => Promise<void>;
  handleTogglePlanningMode: () => void;
  handleRevealSelectedTurnDetails: () => void;
  confirmCapabilitySuggestionAction: () => Promise<void>;
  confirmDeleteSession: () => Promise<void>;
  setSending: (value: boolean) => void;
  setError: (value: string | null) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setCommandIndex: React.Dispatch<React.SetStateAction<number>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setIsDragActive: (value: boolean) => void;
  setEditingTurnId: (value: string | null) => void;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArchiveWorkspaceConfirmOpen: (value: boolean) => void;
  onApplySuggestion?: (item: CommandSuggestionItem) => void;
}) {
  const {
    commandSuggestions,
    commandIndex,
    error,
    dockOpen,
    draft,
    lastEditableDraft,
    sending,
    selectedSession,
    messageMode,
    ensureSession,
    handleSend,
    handleCreateSession,
    handleArchiveWorkspaceMissionChats,
    handleRunQuickResearch: runQuickResearch,
    handlePrefPatch,
    handleTogglePlanningMode,
    handleRevealSelectedTurnDetails,
    confirmCapabilitySuggestionAction,
    confirmDeleteSession,
    setSending,
    setError,
    setDraft,
    setCommandIndex,
    setPendingAttachments,
    setIsDragActive,
    setEditingTurnId,
    setDockOpen,
    setArchiveWorkspaceConfirmOpen,
    onApplySuggestion,
  } = input;

  const dragDepthRef = useRef(0);

  const [attachmentUpload, setAttachmentUpload] = useState<{ pending: number; error: string | null }>({ pending: 0, error: null });
  const workspace = input.workspaceId ?? selectedSession?.workspaceId;
  const selectedId = input.selectedSessionId === undefined ? selectedSession?.sessionId ?? null : input.selectedSessionId;
  const selectionRevision = input.selectionRevisionRef?.current ?? 0;
  const uploadBase = JSON.stringify([getGatewayApiBaseUrl(), getGatewayAccessRevision(),
    getGatewayCallerScopeRevision(), getGatewayCallerScope(), workspace]);
  type UploadTicket = {
    generation: number; base: string; revision: number; selectedId: string | null;
    workspace: string | undefined; recordSeen: boolean; destination?: string;
    selectionSeen: boolean; confirmationOpen: boolean; revoked: boolean;
  };
  const observed = { base: uploadBase, selectedId, revision: selectionRevision,
    recordId: selectedSession?.sessionId ?? null, recordWorkspace: selectedSession?.workspaceId };
  const observedKey = JSON.stringify(observed);
  const ownerStateRef = useRef({ key: observedKey, generation: 0, observed });
  const uploadOwnerRef = useRef<UploadTicket | null>(null);
  const latestUploadRef = useRef<UploadTicket | null>(null);
  const revokedActiveRef = useRef(false);
  const resetUploadStateRef = useRef(false);
  const mountedRef = useRef(true);
  const [, refreshMountGeneration] = useState(0);
  if (ownerStateRef.current.key !== observedKey) {
    const generation = ownerStateRef.current.generation + 1;
    const ticket = latestUploadRef.current;
    let allowed = Boolean(ticket && !ticket.revoked && ticket.base === uploadBase);
    if (ticket && allowed) {
      const target = ticket.destination ?? ticket.selectedId;
      const expectedRevision = ticket.revision + (ticket.destination ? 1 : 0);
      const waitingForOwnSelection = Boolean(ticket.destination && !ticket.selectionSeen &&
        selectedId === null && selectionRevision === ticket.revision);
      allowed = waitingForOwnSelection || (selectedId === target && selectionRevision === expectedRevision);
      if (allowed && !waitingForOwnSelection && ticket.destination) ticket.selectionSeen = true;
      if (observed.recordId !== null) {
        allowed = allowed && observed.recordId === target && observed.recordWorkspace === ticket.workspace;
        if (allowed) ticket.recordSeen = true;
      } else if (ticket.recordSeen) allowed = false;
      if (allowed) ticket.generation = generation;
    }
    if (ticket && !allowed) {
      resetUploadStateRef.current = true;
      ticket.revoked = true;
      if (uploadOwnerRef.current === ticket) { uploadOwnerRef.current = null; revokedActiveRef.current = true; }
    }
    ownerStateRef.current = { key: observedKey, generation, observed };
  }
  const renderedGeneration = ownerStateRef.current.generation;
  const renderedGenerationRef = useRef(renderedGeneration);
  renderedGenerationRef.current = renderedGeneration;
  const liveInputRef = useRef(input);
  liveInputRef.current = input;
  const currentUpload = useCallback((ticket: UploadTicket, publication = false) => {
    const revision = liveInputRef.current.selectionRevisionRef?.current ?? ownerStateRef.current.observed.revision;
    return mountedRef.current && (publication || latestUploadRef.current === ticket) && !ticket.revoked &&
      ticket.generation === ownerStateRef.current.generation &&
      ticket.base === JSON.stringify([getGatewayApiBaseUrl(), getGatewayAccessRevision(),
        getGatewayCallerScopeRevision(), getGatewayCallerScope(), ticket.workspace]) &&
      (revision === ticket.revision + (ticket.destination ? 1 : 0) ||
        Boolean(ticket.destination && !ticket.selectionSeen && revision === ticket.revision));
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    if (ownerStateRef.current.generation !== renderedGenerationRef.current) refreshMountGeneration((value) => value + 1);
    return () => {
      mountedRef.current = false;
      ownerStateRef.current.generation += 1;
      if (latestUploadRef.current) latestUploadRef.current.revoked = true;
      if (uploadOwnerRef.current) { revokedActiveRef.current = true; uploadOwnerRef.current = null; liveInputRef.current.setSending(false); }
    };
  }, []);
  useEffect(() => {
    if (resetUploadStateRef.current && !uploadOwnerRef.current) {
      resetUploadStateRef.current = false;
      setAttachmentUpload((state) => state.pending || state.error ? { pending: 0, error: null } : state);
    }
    if (revokedActiveRef.current && !uploadOwnerRef.current) {
      revokedActiveRef.current = false;
      setAttachmentUpload({ pending: 0, error: null });
      setSending(false);
    }
  }, [renderedGeneration, setSending]);
  const uploadAttachments = useCallback(
    async (files: File[], options?: UploadAttachmentOptions): Promise<boolean> => {
      if (!mountedRef.current || uploadBase !== JSON.stringify([getGatewayApiBaseUrl(), getGatewayAccessRevision(),
        getGatewayCallerScopeRevision(), getGatewayCallerScope(), workspace]) || ownerStateRef.current.generation !== renderedGeneration ||
        (input.selectionRevisionRef?.current ?? selectionRevision) !== selectionRevision ||
        files.length === 0 || sending || uploadOwnerRef.current) return false;
      const owner: UploadTicket = { generation: renderedGeneration, base: uploadBase,
        revision: selectionRevision, selectedId, workspace, recordSeen: Boolean(selectedSession),
        selectionSeen: false, confirmationOpen: true, revoked: false };
      uploadOwnerRef.current = owner;
      latestUploadRef.current = owner;
      resetUploadStateRef.current = false;
      revokedActiveRef.current = false;
      setSending(true);
      setAttachmentUpload({ pending: files.length, error: null });
      try {
        const session = await ensureSession((created) => {
          if (!owner.confirmationOpen) return;
          if (!currentUpload(owner) || owner.destination || owner.selectedId !== null ||
            owner.recordSeen || !input.selectionRevisionRef || !owner.workspace || created.workspaceId !== owner.workspace || !created.sessionId.trim()) {
            owner.revoked = true; return;
          }
          const destination = created.sessionId;
          if (options?.onCreatedSession && options.onCreatedSession({ ...created }) !== true) { owner.revoked = true; return; }
          owner.destination = destination;
        });
        owner.confirmationOpen = false;
        if (owner.destination && input.selectionRevisionRef?.current !== owner.revision + 1) return false;
        const target = owner.destination ?? owner.selectedId;
        if (!currentUpload(owner) || !target || session.sessionId !== target || session.workspaceId !== owner.workspace) return false;
        const uploaded = await Promise.all(files.map((file) => uploadChatAttachment({
          sessionId: session.sessionId, projectId: session.projectId ?? selectedSession?.projectId ?? undefined, file,
        })));
        if (!currentUpload(owner)) return false;
        setPendingAttachments((attachments) => currentUpload(owner, true) ? [...attachments, ...uploaded] : attachments);
        setAttachmentUpload({ pending: 0, error: null });
        return true;
      } catch (err) {
        owner.confirmationOpen = false;
        if (currentUpload(owner)) setAttachmentUpload({ pending: 0, error: (err as Error).message });
        return false;
      } finally {
        owner.confirmationOpen = false;
        if (uploadOwnerRef.current === owner) {
          uploadOwnerRef.current = null;
          setSending(false);
          setAttachmentUpload((state) => state.pending ? { ...state, pending: 0 } : state);
        }
      }
    },
    [currentUpload, ensureSession, input.selectionRevisionRef, renderedGeneration, selectedSession, selectedId,
      selectionRevision, sending, setPendingAttachments, setSending, uploadBase, workspace],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // IME owns confirmation and navigation keys until composition ends.
      // keyCode 229 covers engines that clear isComposing on the confirmation key.
      if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || event.keyCode === 229) return;
      if (isPlanningModeToggleShortcut(event)) {
        event.preventDefault();
        handleTogglePlanningMode();
        return;
      }
      if (event.key === "Escape") {
        const hasSuggestionsOpen = commandSuggestions.length > 0;
        const hasError = error !== null;
        const hasDockOpen = dockOpen;
        if (!hasSuggestionsOpen && !hasError && !hasDockOpen) {
          // Nothing in the composer for Escape to close: leave the event alone so it
          // bubbles to the document-level useEscapeToStopStream listener, which stops
          // the active stream. Do NOT preventDefault or call a stop handler here — that
          // hook is the single owner of the stream-stop shortcut.
          return;
        }
        event.preventDefault();
        if (hasSuggestionsOpen) setCommandIndex(0);
        if (hasError) setError(null);
        if (hasDockOpen) setDockOpen(false);
        return;
      }
      if (commandSuggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setCommandIndex((current) => Math.min(current + 1, commandSuggestions.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setCommandIndex((current) => Math.max(current - 1, 0));
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const suggestion = commandSuggestions[commandIndex];
          if (suggestion) {
            if (onApplySuggestion) onApplySuggestion(suggestion);
            else setDraft((current) => applyComposerSuggestion(current, suggestion.applyValue));
          }
          return;
        }
      }
      if (event.key === "ArrowUp" && draft.trim().length === 0 && lastEditableDraft?.trim()) {
        event.preventDefault();
        setDraft(lastEditableDraft);
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
        event.preventDefault();
        void handleSend();
      }
    },
    [
      commandIndex,
      commandSuggestions,
      dockOpen,
      draft,
      error,
      handleSend,
      handleTogglePlanningMode,
      lastEditableDraft,
      onApplySuggestion,
      setCommandIndex,
      setDockOpen,
      setDraft,
      setError,
    ],
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void uploadAttachments(files);
        return;
      }
      const itemFiles = Array.from(event.clipboardData.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (itemFiles.length > 0) {
        event.preventDefault();
        void uploadAttachments(itemFiles);
      }
    },
    [uploadAttachments],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [setIsDragActive],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragActive(false);
    },
    [setIsDragActive],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) void uploadAttachments(files);
    },
    [setIsDragActive, uploadAttachments],
  );

  const handleDismissError = useCallback(() => setError(null), [setError]);
  const handleCancelEdit = useCallback(() => setEditingTurnId(null), [setEditingTurnId]);
  const handleToggleDock = useCallback(() => setDockOpen((current) => !current), [setDockOpen]);
  const handleCreateCurrentModeSession = useCallback(() => {
    return handleCreateSession(messageMode);
  }, [handleCreateSession, messageMode]);
  const handleArchiveWorkspace = useCallback(
    () => setArchiveWorkspaceConfirmOpen(true),
    [setArchiveWorkspaceConfirmOpen],
  );
  const handleConfirmCapabilitySuggestion = useCallback(() => {
    void confirmCapabilitySuggestionAction();
  }, [confirmCapabilitySuggestionAction]);
  const handleConfirmDeleteSession = useCallback(() => {
    void confirmDeleteSession();
  }, [confirmDeleteSession]);
  const handleConfirmArchiveWorkspace = useCallback(() => {
    void handleArchiveWorkspaceMissionChats().finally(() => setArchiveWorkspaceConfirmOpen(false));
  }, [handleArchiveWorkspaceMissionChats, setArchiveWorkspaceConfirmOpen]);
  const handleSetDeepMode = useCallback(() => {
    void handlePrefPatch({ webMode: "deep" });
  }, [handlePrefPatch]);
  const handleRunQuickResearch = useCallback(() => {
    void runQuickResearch();
  }, [runQuickResearch]);
  const handleApplyDraftCommand = useCallback(
    (command: string) => setDraft((current) => applyComposerSuggestion(current, command)),
    [setDraft],
  );
  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      setPendingAttachments((current) => current.filter((entry) => entry.attachmentId !== attachmentId));
    },
    [setPendingAttachments],
  );
  const handleUploadFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      void uploadAttachments(Array.from(files));
    },
    [uploadAttachments],
  );

  return {
    attachmentUpload,
    uploadAttachments,
    handleComposerKeyDown,
    handleComposerPaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDismissError,
    handleCancelEdit,
    handleToggleDock,
    handleCreateCurrentModeSession,
    handleArchiveWorkspace,
    handleConfirmCapabilitySuggestion,
    handleConfirmDeleteSession,
    handleConfirmArchiveWorkspace,
    handleSetDeepMode,
    handleRunQuickResearch,
    handleRevealSelectedTurnDetails,
    handleApplyDraftCommand,
    handleRemoveAttachment,
    handleUploadFiles,
  };
}
