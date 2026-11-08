import type { ChatSessionWorkbenchFileResponse, ChatSessionWorkbenchTreeResponse } from "@goatcitadel/contracts";
import type { WorkbenchActionOwner } from "./workbench-action-code.js";
import {
  fetchChatSessionWorkbench, fetchChatSessionWorkbenchTree, fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchOutput, fetchChatSessionWorkbenchFile, fetchChatSessionWorkbenchFileDiff,
} from "@goatcitadel/mission-control-shared/api/chat-workbench-operations";

export interface WorkbenchReadOwner extends Pick<WorkbenchActionOwner,
  "requireCurrent" | "isCurrentSession" | "selectedFileRef" | "draftContentRef" | "fileReadRef" |
  "setState" | "setTree" | "setDiff" | "setOutput" | "setSelectedFile" | "setSelectedFileDiff" |
  "setDraftContent" | "setError" | "setPersistedExpandedPaths" | "deriveDefaultExpandedPaths" |
  "describeWorkbenchActionError" | "applySelectedFileState"> {
  dirtyDraftRef: { current: boolean };
  fileReadGeneration?: number;
  setLoading(value: boolean): void;
  readWorkbenchUiState(sessionId: string): { expandedPaths: string[]; selectedFilePath?: string };
}
export interface WorkbenchReads {
  refresh(sessionId: string): Promise<void>;
  loadFileSelection(sessionId: string, relativePath: string, options?: { preserveDraft?: boolean }): Promise<ChatSessionWorkbenchFileResponse | null>;
}

function resolveWorkbenchFileCandidates(input: {
  currentSelectedFilePath?: string;
  storedSelectedFilePath?: string;
  activeFilePath?: string;
  changedFiles: string[];
  items: ChatSessionWorkbenchTreeResponse["items"];
}): string[] {
  const filePaths = new Set(input.items.filter((item) => item.kind === "file").map((item) => item.path));
  const candidates = [
    input.currentSelectedFilePath,
    input.storedSelectedFilePath,
    input.activeFilePath,
    ...input.changedFiles,
    ...input.items.filter((item) => item.kind === "file").map((item) => item.path),
  ];
  return [...new Set(candidates.map((path) => path?.trim()).filter(Boolean) as string[])].filter((path) =>
    filePaths.has(path),
  );
}

/** Canonical read implementations only. Drafts, admission and all React state stay mounted. */
export function createWorkbenchReadCode(owner: WorkbenchReadOwner): WorkbenchReads {
  const { isCurrentSession, selectedFileRef, fileReadRef, dirtyDraftRef,
    setState, setTree, setDiff, setOutput, setSelectedFile, setSelectedFileDiff, setDraftContent,
    setError, setLoading, setPersistedExpandedPaths, deriveDefaultExpandedPaths,
    readWorkbenchUiState, describeWorkbenchActionError, applySelectedFileState } = owner;
  const loadFileSelection = async (
      requestSessionId: string,
      relativePath: string,
      options: { preserveDraft?: boolean } = {},
    ): Promise<ChatSessionWorkbenchFileResponse | null> => {
      owner.requireCurrent();
      if (!isCurrentSession(requestSessionId)) return null;
      const readId = owner.fileReadGeneration ?? ++fileReadRef.current;
      if (readId !== fileReadRef.current) return null;
      const [nextFile, nextFileDiff] = await Promise.all([
        fetchChatSessionWorkbenchFile(requestSessionId, relativePath),
        fetchChatSessionWorkbenchFileDiff(requestSessionId, relativePath),
      ]);
      if (!isCurrentSession(requestSessionId) || readId !== fileReadRef.current) {
        return null;
      }
      if (
        nextFile.path !== relativePath ||
        nextFile.state.sessionId !== requestSessionId ||
        nextFileDiff.path !== relativePath ||
        nextFileDiff.state.sessionId !== requestSessionId
      )
        throw new Error("File evidence does not match the selected session and path.");
      applySelectedFileState(nextFile, nextFileDiff, options);
      return nextFile;
    };
  const refresh = async (requestSessionId: string) => {
    owner.requireCurrent();
    if (!isCurrentSession(requestSessionId)) return;
    const storedUiState = readWorkbenchUiState(requestSessionId);
    try {
      const workbench = await fetchChatSessionWorkbench(requestSessionId);
      if (!isCurrentSession(requestSessionId)) {
        return;
      }
      setState(workbench.state);
      setError(null);

      if (workbench.state.worktreeStatus !== "ready") {
        setTree(null);
        if (!dirtyDraftRef.current) {
          setSelectedFile(null);
          setSelectedFileDiff(null);
          setDraftContent("");
        }
        setDiff(null);
        setOutput(null);
        return;
      }

      const [nextTree, nextDiff, nextOutput] = await Promise.all([
        fetchChatSessionWorkbenchTree(requestSessionId),
        fetchChatSessionWorkbenchDiff(requestSessionId),
        fetchChatSessionWorkbenchOutput(requestSessionId),
      ]);
      if (!isCurrentSession(requestSessionId)) {
        return;
      }

      const currentSelectedPath = selectedFileRef.current?.path;
      const candidatePaths = resolveWorkbenchFileCandidates({
        currentSelectedFilePath: currentSelectedPath,
        storedSelectedFilePath: storedUiState.selectedFilePath,
        activeFilePath: nextOutput.state.activeFilePath,
        changedFiles: nextTree.changedFiles,
        items: nextTree.items,
      });
      const preferredSelectedPath = candidatePaths[0];

      setTree(nextTree);
      setDiff(nextDiff);
      setOutput(nextOutput);
      setState(nextOutput.state);
      setPersistedExpandedPaths(
        deriveDefaultExpandedPaths(nextTree, preferredSelectedPath, storedUiState.expandedPaths),
      );

      if (candidatePaths.length === 0) {
        if (dirtyDraftRef.current)
          setError("The current file is no longer listed. Your draft is preserved; refresh before saving.");
        else {
          setSelectedFile(null);
          setSelectedFileDiff(null);
          setDraftContent("");
        }
        return;
      }

      let loaded = false;
      let lastError: unknown;
      for (const candidatePath of candidatePaths) {
        if (!isCurrentSession(requestSessionId)) return;
        try {
          await loadFileSelection(requestSessionId, candidatePath, {
            preserveDraft: dirtyDraftRef.current && selectedFileRef.current?.path === candidatePath,
          });
          loaded = true;
          break;
        } catch (cause) {
          lastError = cause;
        }
      }

      if (!loaded && isCurrentSession(requestSessionId)) {
        if (!dirtyDraftRef.current) {
          setSelectedFile(null);
          setSelectedFileDiff(null);
          setDraftContent("");
        }
        setError(describeWorkbenchActionError(lastError, "Unable to load the active workbench file."));
      }
    } catch (cause) {
      if (isCurrentSession(requestSessionId)) {
        setError(describeWorkbenchActionError(cause, "Unable to load workbench."));
      }
    } finally {
      if (isCurrentSession(requestSessionId)) {
        setLoading(false);
      }
    }
  };
  return { refresh, loadFileSelection };
}
