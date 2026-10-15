import type {
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchFileOperationPreviewRequest,
  ChatSessionWorkbenchFileOperationRequest,
} from "@goatcitadel/contracts";
import {
  fetchChatSessionWorkbenchFile as canonicalFetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchFileDiff as canonicalFetchChatSessionWorkbenchFileDiff,
  fetchChatSessionWorkbenchTree as canonicalFetchChatSessionWorkbenchTree,
  fetchChatSessionWorkbenchDiff as canonicalFetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchOutput as canonicalFetchChatSessionWorkbenchOutput,
} from "@goatcitadel/mission-control-shared/api/chat";
import {
  createChatSessionWorkbenchWorktree as canonicalCreateChatSessionWorkbenchWorktree,
  saveChatSessionWorkbenchFile as canonicalSaveChatSessionWorkbenchFile,
  previewChatSessionWorkbenchFileOperation as canonicalPreviewChatSessionWorkbenchFileOperation,
  runChatSessionWorkbenchFileOperation as canonicalRunChatSessionWorkbenchFileOperation,
  runChatSessionWorkbenchCommand as canonicalRunChatSessionWorkbenchCommand,
  applyChatSessionWorkbenchPatch as canonicalApplyChatSessionWorkbenchPatch,
  exportChatSessionWorkbenchPatch as canonicalExportChatSessionWorkbenchPatch,
  revertChatSessionWorkbenchFile as canonicalRevertChatSessionWorkbenchFile,
  revertChatSessionWorkbenchChanges as canonicalRevertChatSessionWorkbenchChanges,
} from "@goatcitadel/mission-control-shared/api/chat-workbench-operations";

export type WorkbenchDraftHelpers = Pick<
  typeof import("./workbench-session-drafts.js"),
  "getWorkbenchDraft" | "acknowledgeWorkbenchDraft"
>;
type Ref<Value> = { current: Value };
type Setter<Value> = (value: Value) => void;
export interface WorkbenchActionOwner {
  requireCurrent: () => void;
  isCurrentSession: (sessionId: string | null) => boolean;
  savingRef: Ref<boolean>;
  selectedFileRef: Ref<ChatSessionWorkbenchFileResponse | null>;
  draftContentRef: Ref<string>;
  fileReadRef: Ref<number>;
  setBusy: Setter<boolean>;
  setSaving: Setter<boolean>;
  setState: Setter<ChatSessionWorkbenchRecord | null>;
  setTree: Setter<ChatSessionWorkbenchTreeResponse | null>;
  setDiff: Setter<ChatSessionWorkbenchDiffResponse | null>;
  setOutput: Setter<ChatSessionWorkbenchOutputResponse | null>;
  setSelectedFile: Setter<ChatSessionWorkbenchFileResponse | null>;
  setSelectedFileDiff: Setter<ChatSessionWorkbenchFileDiffResponse | null>;
  setDraftContent: Setter<string>;
  setError: Setter<string | null>;
  setPersistedExpandedPaths: (paths: string[]) => void;
  deriveDefaultExpandedPaths: (
    tree: ChatSessionWorkbenchTreeResponse,
    selectedFilePath: string | undefined,
    expandedPaths: string[],
  ) => string[];
  readWorkbenchUiState: (sessionId: string) => { expandedPaths: string[] };
  describeWorkbenchActionError: (cause: unknown, fallback: string) => string;
  applySelectedFileState: (
    file: ChatSessionWorkbenchFileResponse,
    diff: ChatSessionWorkbenchFileDiffResponse,
    options?: { preserveDraft?: boolean },
  ) => void;
  refresh: () => Promise<void>;
}

/** Optional implementations; all state, admission and canonical draft ownership remain mounted. */
export function createWorkbenchActionCode(owner: WorkbenchActionOwner) {
  const {
    isCurrentSession,
    savingRef,
    selectedFileRef,
    draftContentRef,
    fileReadRef,
    setBusy,
    setSaving,
    setState,
    setTree,
    setDiff,
    setOutput,
    setSelectedFile,
    setSelectedFileDiff,
    setDraftContent,
    setError,
    setPersistedExpandedPaths,
    deriveDefaultExpandedPaths,
    readWorkbenchUiState,
    describeWorkbenchActionError,
    applySelectedFileState,
  } = owner;
  const guarded =
    <Args extends unknown[], Result>(operation: (...args: Args) => Result) =>
    (...args: Args): Result => {
      owner.requireCurrent();
      return operation(...args);
    };
  const fetchChatSessionWorkbenchFile = guarded(canonicalFetchChatSessionWorkbenchFile);
  const fetchChatSessionWorkbenchFileDiff = guarded(canonicalFetchChatSessionWorkbenchFileDiff);
  const fetchChatSessionWorkbenchTree = guarded(canonicalFetchChatSessionWorkbenchTree);
  const fetchChatSessionWorkbenchDiff = guarded(canonicalFetchChatSessionWorkbenchDiff);
  const fetchChatSessionWorkbenchOutput = guarded(canonicalFetchChatSessionWorkbenchOutput);
  const createChatSessionWorkbenchWorktree = guarded(canonicalCreateChatSessionWorkbenchWorktree);
  const saveChatSessionWorkbenchFile = guarded(canonicalSaveChatSessionWorkbenchFile);
  const previewChatSessionWorkbenchFileOperation = guarded(canonicalPreviewChatSessionWorkbenchFileOperation);
  const runChatSessionWorkbenchFileOperation = guarded(canonicalRunChatSessionWorkbenchFileOperation);
  const runChatSessionWorkbenchCommand = guarded(canonicalRunChatSessionWorkbenchCommand);
  const applyChatSessionWorkbenchPatch = guarded(canonicalApplyChatSessionWorkbenchPatch);
  const exportChatSessionWorkbenchPatch = guarded(canonicalExportChatSessionWorkbenchPatch);
  const revertChatSessionWorkbenchFile = guarded(canonicalRevertChatSessionWorkbenchFile);
  const revertChatSessionWorkbenchChanges = guarded(canonicalRevertChatSessionWorkbenchChanges);
  const refresh = guarded(owner.refresh);
  return {
    saveFile: async ({
      requestSessionId,
      activeFile,
      draft,
      submitted,
      draftHelpersAtAdmission,
    }: {
      requestSessionId: string;
      activeFile: ChatSessionWorkbenchFileResponse;
      draft: NonNullable<ReturnType<WorkbenchDraftHelpers["getWorkbenchDraft"]>>;
      submitted: string;
      draftHelpersAtAdmission: WorkbenchDraftHelpers;
    }) => {
      const draftHelpersRef = { current: draftHelpersAtAdmission };
      try {
        const currentFile = await fetchChatSessionWorkbenchFile(requestSessionId, activeFile.path);
        if (!isCurrentSession(requestSessionId)) return false;
        if (currentFile.path !== activeFile.path || currentFile.state.sessionId !== requestSessionId)
          throw new Error("The file response does not match this editor. Your draft is preserved.");
        if (
          currentFile.revision !== draft.base.revision ||
          currentFile.content !== draft.base.content ||
          currentFile.state.worktreePath !== draft.base.state.worktreePath ||
          currentFile.state.projectId !== draft.base.state.projectId
        ) {
          if (selectedFileRef.current?.path === activeFile.path) {
            selectedFileRef.current = currentFile;
            setSelectedFile(currentFile);
          }
          throw new Error(
            "This file changed since editing began. Review the latest version before saving your retained draft.",
          );
        }
        const nextFile = await saveChatSessionWorkbenchFile(requestSessionId, {
          path: activeFile.path,
          content: submitted,
          expectedRevision: draft.base.revision,
        });
        if (
          nextFile.path !== activeFile.path ||
          nextFile.state.sessionId !== requestSessionId ||
          nextFile.content !== submitted
        )
          throw new Error("The Gateway did not confirm the submitted file contents. Your draft is preserved.");
        const clean = draftHelpersRef.current.acknowledgeWorkbenchDraft(requestSessionId, nextFile, submitted);
        if (isCurrentSession(requestSessionId)) fileReadRef.current += 1;
        if (!isCurrentSession(requestSessionId)) return clean;
        if (selectedFileRef.current?.path === activeFile.path) {
          selectedFileRef.current = nextFile;
          setSelectedFile(nextFile);
          const nextContent =
            draftHelpersRef.current.getWorkbenchDraft(requestSessionId, activeFile.path)?.content ?? nextFile.content;
          draftContentRef.current = nextContent;
          setDraftContent(nextContent);
        }
        setError(null);
        try {
          const [nextTree, nextDiff, nextOutput, nextFileDiff] = await Promise.all([
            fetchChatSessionWorkbenchTree(requestSessionId),
            fetchChatSessionWorkbenchDiff(requestSessionId),
            fetchChatSessionWorkbenchOutput(requestSessionId),
            fetchChatSessionWorkbenchFileDiff(requestSessionId, activeFile.path),
          ]);
          if (isCurrentSession(requestSessionId)) {
            setTree(nextTree);
            setDiff(nextDiff);
            setOutput(nextOutput);
            if (selectedFileRef.current?.path === activeFile.path) setSelectedFileDiff(nextFileDiff);
            setPersistedExpandedPaths(
              deriveDefaultExpandedPaths(
                nextTree,
                activeFile.path,
                readWorkbenchUiState(requestSessionId).expandedPaths,
              ),
            );
          }
        } catch {
          if (isCurrentSession(requestSessionId))
            setError("File saved. Updated workbench evidence is unavailable; refresh to retry.");
        }
        return clean;
      } catch (cause) {
        const isConflict = cause && typeof cause === "object" && "status" in cause && cause.status === 409;
        if (isConflict && isCurrentSession(requestSessionId)) {
          let currentUnavailable = false;
          try {
            const latestFile = await fetchChatSessionWorkbenchFile(requestSessionId, activeFile.path);
            if (latestFile.state.sessionId !== requestSessionId || latestFile.path !== activeFile.path)
              throw new Error("Mismatched file response", { cause });
            if (isCurrentSession(requestSessionId) && selectedFileRef.current?.path === activeFile.path) {
              selectedFileRef.current = latestFile;
              setSelectedFile(latestFile);
            }
          } catch {
            currentUnavailable = true;
          }
          if (isCurrentSession(requestSessionId))
            setError(
              currentUnavailable
                ? "Save was blocked and the current file is unavailable. Your draft is preserved; reload before trying again."
                : "Save was blocked by a concurrent Workbench operation. Review the latest file before saving your retained draft.",
            );
        } else if (isCurrentSession(requestSessionId))
          setError(describeWorkbenchActionError(cause, "Unable to save the active workbench file."));
        return false;
      } finally {
        savingRef.current = false;
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
          setSaving(false);
        }
      }
    },
    previewFileOperation: async ({
      requestSessionId,
      input,
    }: {
      requestSessionId: string;
      input: ChatSessionWorkbenchFileOperationPreviewRequest;
    }) => {
      try {
        const review = await previewChatSessionWorkbenchFileOperation(requestSessionId, input);
        if (!isCurrentSession(requestSessionId)) return null;
        setError(null);
        return review;
      } catch (cause) {
        if (isCurrentSession(requestSessionId))
          setError(describeWorkbenchActionError(cause, "Unable to review this file action."));
        return null;
      } finally {
        if (isCurrentSession(requestSessionId)) setBusy(false);
      }
    },
    runFileOperation: async ({
      requestSessionId,
      input,
    }: {
      requestSessionId: string;
      input: ChatSessionWorkbenchFileOperationRequest;
    }) => {
      try {
        const response = await runChatSessionWorkbenchFileOperation(requestSessionId, input);
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }

        const nextDiff = await fetchChatSessionWorkbenchDiff(requestSessionId);
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }

        setState(response.state);
        setTree(response.tree);
        setDiff(nextDiff);
        setOutput(response.output);
        setPersistedExpandedPaths(
          deriveDefaultExpandedPaths(
            response.tree,
            response.targetPath ?? response.path,
            readWorkbenchUiState(requestSessionId).expandedPaths,
          ),
        );

        const candidatePathAfterOperation =
          input.operation === "create_file" || input.operation === "duplicate" || input.operation === "rename"
            ? (response.targetPath ?? response.path)
            : input.operation === "move"
              ? (response.targetPath ?? response.path)
              : undefined;
        const selectedPathAfterOperation =
          candidatePathAfterOperation &&
          response.tree.items.some((item) => item.kind === "file" && item.path === candidatePathAfterOperation)
            ? candidatePathAfterOperation
            : undefined;
        if (selectedPathAfterOperation) {
          const nextFileDiff = await fetchChatSessionWorkbenchFileDiff(requestSessionId, selectedPathAfterOperation);
          const nextFile = await fetchChatSessionWorkbenchFile(requestSessionId, selectedPathAfterOperation);
          if (!isCurrentSession(requestSessionId)) {
            return false;
          }
          applySelectedFileState(nextFile, nextFileDiff, { preserveDraft: false });
        } else if (
          input.operation === "delete" &&
          selectedFileRef.current &&
          (selectedFileRef.current.path === response.path ||
            selectedFileRef.current.path.startsWith(`${response.path}/`))
        ) {
          setSelectedFile(null);
          setSelectedFileDiff(null);
          setDraftContent("");
        }

        setError(null);
        return true;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          const isConflict = cause && typeof cause === "object" && "status" in cause && cause.status === 409;
          setError(
            isConflict
              ? "The file action's source, destination or project changed. Review the action again before applying it."
              : describeWorkbenchActionError(cause, "Unable to update the workbench file tree."),
          );
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    createWorktree: async ({ requestSessionId, baseRef }: { requestSessionId: string; baseRef?: string }) => {
      try {
        const nextState = await createChatSessionWorkbenchWorktree(requestSessionId, { baseRef });
        if (!isCurrentSession(requestSessionId)) {
          return;
        }
        setState(nextState.state);
        setError(null);
        await refresh();
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to create worktree."));
        }
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    runValidationCommand: async ({
      requestSessionId,
      input,
    }: {
      requestSessionId: string;
      input: { command: string; args?: string[]; timeoutMs?: number };
    }) => {
      try {
        const response = await runChatSessionWorkbenchCommand(requestSessionId, input);
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setState(response.state);
        setError(null);
        await refresh();
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setOutput(response.output);
        return true;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to run workbench validation."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    applyPatch: async ({ requestSessionId, patch }: { requestSessionId: string; patch: string }) => {
      try {
        const response = await applyChatSessionWorkbenchPatch(requestSessionId, { patch });
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setState(response.state);
        setError(null);
        await refresh();
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setOutput(response.output);
        return response.applied;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to apply the workbench patch."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    exportPatch: async ({ requestSessionId }: { requestSessionId: string }) => {
      try {
        const response = await exportChatSessionWorkbenchPatch(requestSessionId);
        if (!isCurrentSession(requestSessionId)) {
          return null;
        }
        setState(response.state);
        setError(null);
        await refresh();
        return response;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to export the workbench patch."));
        }
        return null;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    revertFile: async ({ requestSessionId, pathToRevert }: { requestSessionId: string; pathToRevert: string }) => {
      try {
        const response = await revertChatSessionWorkbenchFile(requestSessionId, { path: pathToRevert });
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setState(response.state);
        setError(null);
        await refresh();
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setOutput(response.output);
        return true;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to revert the selected workbench file."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    revertAll: async ({ requestSessionId }: { requestSessionId: string }) => {
      try {
        const response = await revertChatSessionWorkbenchChanges(requestSessionId);
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setState(response.state);
        setError(null);
        await refresh();
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setOutput(response.output);
        return true;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(describeWorkbenchActionError(cause, "Unable to revert workbench changes."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
  };
}
