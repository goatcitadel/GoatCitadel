import { useCallback, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { ChatAttachmentRecord, ChatMode, ChatSessionPrefsPatch, ChatSessionRecord } from "@goatcitadel/contracts";
import { uploadChatAttachment } from "@goatcitadel/mission-control-shared/api/client";
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
  draft: string;
  lastEditableDraft?: string | null;
  commandSuggestions: CommandSuggestionItem[];
  commandIndex: number;
  error: string | null;
  dockOpen: boolean;
  sending: boolean;
  selectedSession: ChatSessionRecord | null;
  messageMode: ChatMode;
  ensureSession: () => Promise<ChatSessionRecord>;
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
  } = input;

  const dragDepthRef = useRef(0);

  const uploadAttachments = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || sending) return;
      const session = await ensureSession();
      setSending(true);
      try {
        const uploaded = await Promise.all(
          files.map((file) =>
            uploadChatAttachment({
              sessionId: session.sessionId,
              projectId: selectedSession?.projectId ?? undefined,
              file,
            }),
          ),
        );
        setPendingAttachments((current) => [...current, ...uploaded]);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    },
    [ensureSession, selectedSession?.projectId, sending, setError, setPendingAttachments, setSending],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
          if (suggestion) setDraft((current) => applyComposerSuggestion(current, suggestion.applyValue));
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
    void handleCreateSession(messageMode);
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
