import { acknowledgeWorkbenchDraft, discardWorkbenchSessionDraft, getWorkbenchDraft, listWorkbenchDrafts, rebaseWorkbenchDraft, updateWorkbenchDraft, useWorkbenchDraftVersion } from "./workbench-session-drafts.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileDiffResponse,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchFileOperationPreviewRequest,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
} from "@goatcitadel/contracts";
import {
  applyChatSessionWorkbenchPatch,
  createChatSessionWorkbenchWorktree,
  exportChatSessionWorkbenchPatch,
  fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchFileDiff,
  fetchChatSessionWorkbenchOutput,
  fetchChatSessionWorkbenchTree,
  revertChatSessionWorkbenchChanges,
  revertChatSessionWorkbenchFile,
  runChatSessionWorkbenchCommand,
  previewChatSessionWorkbenchFileOperation,
  runChatSessionWorkbenchFileOperation,
  saveChatSessionWorkbenchFile,
} from "@goatcitadel/mission-control-shared/api/chat";
import { useRefreshSubscription } from "@goatcitadel/mission-control-shared/hooks/useRefreshSubscription";

interface StoredWorkbenchUiState {
  expandedPaths: string[];
  selectedFilePath?: string;
}

// Keep workbench refreshes fresh without churning every SSE burst; this matches the current 15s poll cadence.
const WORKBENCH_REFRESH_STALE_MS = 20_000;

export function describeWorkbenchActionError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const WORKBENCH_UI_STORAGE_PREFIX = "goatcitadel.chat.workbench.ui.";

function normalizeWorkbenchPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function buildWorkbenchStorageKey(sessionId: string): string {
  return `${WORKBENCH_UI_STORAGE_PREFIX}${sessionId}`;
}

function readWorkbenchUiState(sessionId: string): StoredWorkbenchUiState {
  if (typeof window === "undefined") {
    return { expandedPaths: [] };
  }
  const storageKey = buildWorkbenchStorageKey(sessionId);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { expandedPaths: [] };
    }
    const parsed = JSON.parse(raw) as Partial<StoredWorkbenchUiState>;
    return {
      expandedPaths: normalizeWorkbenchPaths(Array.isArray(parsed.expandedPaths) ? parsed.expandedPaths : []),
      selectedFilePath:
        typeof parsed.selectedFilePath === "string" ? parsed.selectedFilePath.trim() || undefined : undefined,
    };
  } catch {
    return { expandedPaths: [] };
  }
}

function writeWorkbenchUiState(sessionId: string | null, patch: Partial<StoredWorkbenchUiState>): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!sessionId) {
    return;
  }
  const storageKey = buildWorkbenchStorageKey(sessionId);
  const current = readWorkbenchUiState(sessionId);
  const next: StoredWorkbenchUiState = {
    expandedPaths: normalizeWorkbenchPaths(patch.expandedPaths ?? current.expandedPaths),
    selectedFilePath:
      patch.selectedFilePath === undefined ? current.selectedFilePath : patch.selectedFilePath.trim() || undefined,
  };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Fallback: localStorage may be disabled or quota-exceeded; drop the write rather than crash the UI.
  }
}

function expandAncestorPaths(path: string): string[] {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    return [];
  }
  const ancestors: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join("/"));
  }
  return ancestors;
}

function deriveDefaultExpandedPaths(
  tree: ChatSessionWorkbenchTreeResponse,
  selectedFilePath: string | undefined,
  storedExpandedPaths: string[],
): string[] {
  if (storedExpandedPaths.length > 0) {
    return storedExpandedPaths;
  }
  const nextPaths = new Set<string>();
  for (const changedFile of tree.changedFiles) {
    for (const ancestor of expandAncestorPaths(changedFile)) {
      nextPaths.add(ancestor);
    }
  }
  if (selectedFilePath) {
    for (const ancestor of expandAncestorPaths(selectedFilePath)) {
      nextPaths.add(ancestor);
    }
  }
  return normalizeWorkbenchPaths([...nextPaths]);
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

export function useChatWorkbench(input: { sessionId: string | null; enabled: boolean }) {
  const { sessionId, enabled } = input;
  const [state, setState] = useState<ChatSessionWorkbenchRecord | null>(null);
  const [tree, setTree] = useState<ChatSessionWorkbenchTreeResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<ChatSessionWorkbenchFileResponse | null>(null);
  const [selectedFileDiff, setSelectedFileDiff] = useState<ChatSessionWorkbenchFileDiffResponse | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [diff, setDiff] = useState<ChatSessionWorkbenchDiffResponse | null>(null);
  const [output, setOutput] = useState<ChatSessionWorkbenchOutputResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerRef = useRef({ sessionId, enabled });
  if (ownerRef.current.sessionId !== sessionId || ownerRef.current.enabled !== enabled) ownerRef.current = { sessionId, enabled };
  const owner = ownerRef.current;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const savingRef = useRef(false);
  const fileReadRef = useRef(0);
  useWorkbenchDraftVersion();
  const selectedFileRef = useRef<ChatSessionWorkbenchFileResponse | null>(null);
  const draftContentRef = useRef("");
  const dirtyDraftRef = useRef(false);

  const retainedDrafts = listWorkbenchDrafts(sessionId);
  const activeDraft = sessionId && selectedFile ? getWorkbenchDraft(sessionId, selectedFile.path) : undefined;
  const hasDirtyDraft = Boolean(activeDraft);
  const hasRemoteChanges = Boolean(activeDraft && selectedFile && (activeDraft.base.revision !== selectedFile.revision || activeDraft.base.content !== selectedFile.content || activeDraft.base.state.worktreePath !== selectedFile.state.worktreePath || activeDraft.base.state.projectId !== selectedFile.state.projectId));

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    draftContentRef.current = draftContent;
  }, [draftContent]);

  useEffect(() => {
    dirtyDraftRef.current = hasDirtyDraft;
  }, [hasDirtyDraft]);

  const setPersistedExpandedPaths = useCallback(
    (nextPaths: string[]) => {
      const normalized = normalizeWorkbenchPaths(nextPaths);
      setExpandedPaths(normalized);
      writeWorkbenchUiState(sessionId, { expandedPaths: normalized });
    },
    [sessionId],
  );

  const updateSelectedFilePath = useCallback(
    (path: string | undefined) => {
      writeWorkbenchUiState(sessionId, { selectedFilePath: path });
    },
    [sessionId],
  );

  const resetWorkbench = useCallback(() => {
    setState(null);
    setTree(null);
    setSelectedFile(null);
    setSelectedFileDiff(null);
    setDraftContent("");
    setExpandedPaths([]);
    setDiff(null);
    setOutput(null);
    setLoading(false);
    setBusy(false);
    setSaving(false);
    setError(null);
  }, []);

  const isCurrentSession = useCallback((candidateSessionId: string | null) => {
    return mountedRef.current && enabled && Boolean(candidateSessionId) && ownerRef.current === owner && owner.sessionId === candidateSessionId;
  }, [enabled, owner]);

  const applySelectedFileState = useCallback(
    (
      nextFile: ChatSessionWorkbenchFileResponse,
      nextFileDiff: ChatSessionWorkbenchFileDiffResponse,
      _options: { preserveDraft?: boolean } = {},
    ) => {
      selectedFileRef.current = nextFile;
      setSelectedFile(nextFile);
      setSelectedFileDiff(nextFileDiff);
      setState(nextFile.state);
      const retained = sessionId ? getWorkbenchDraft(sessionId, nextFile.path) : undefined;
      const nextContent = retained?.content ?? nextFile.content;
      draftContentRef.current = nextContent;
      setDraftContent(nextContent);
      updateSelectedFilePath(nextFile.path);
      setExpandedPaths((current) => {
        const merged = normalizeWorkbenchPaths([...current, ...expandAncestorPaths(nextFile.path)]);
        writeWorkbenchUiState(sessionId, { expandedPaths: merged, selectedFilePath: nextFile.path });
        return merged;
      });
    },
    [sessionId, updateSelectedFilePath],
  );

  const loadWorkbenchFileSelection = useCallback(
    async (
      requestSessionId: string,
      relativePath: string,
      options: { preserveDraft?: boolean } = {},
    ): Promise<ChatSessionWorkbenchFileResponse | null> => {
      const readId = ++fileReadRef.current;
      const [nextFile, nextFileDiff] = await Promise.all([
        fetchChatSessionWorkbenchFile(requestSessionId, relativePath),
        fetchChatSessionWorkbenchFileDiff(requestSessionId, relativePath),
      ]);
      if (!isCurrentSession(requestSessionId) || readId !== fileReadRef.current) {
        return null;
      }
      if (nextFile.path !== relativePath || nextFile.state.sessionId !== requestSessionId || nextFileDiff.path !== relativePath || nextFileDiff.state.sessionId !== requestSessionId) throw new Error("File evidence does not match the selected session and path.");
      applySelectedFileState(nextFile, nextFileDiff, options);
      return nextFile;
    },
    [applySelectedFileState, isCurrentSession],
  );

  const loadFile = useCallback(
    async (relativePath: string) => {
      if (!sessionId) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      try {
        await loadWorkbenchFileSelection(requestSessionId, relativePath);
        if (!isCurrentSession(requestSessionId)) {
          return false;
        }
        setError(null);
        return true;
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          const retained = getWorkbenchDraft(requestSessionId, relativePath);
          if (retained) { selectedFileRef.current = retained.base; setSelectedFile(retained.base); setSelectedFileDiff(null); draftContentRef.current = retained.content; setDraftContent(retained.content); }
          setError(retained ? "Current file unavailable. This is your retained draft; saving requires a current file read." : describeWorkbenchActionError(cause, "Unable to load workbench file."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    [isCurrentSession, loadWorkbenchFileSelection, sessionId],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      resetWorkbench();
      return;
    }
    const requestSessionId = sessionId;
    const storedUiState = readWorkbenchUiState(requestSessionId);
    setLoading(true);
    try {
      const workbench = await fetchChatSessionWorkbench(requestSessionId);
      if (!isCurrentSession(requestSessionId)) {
        return;
      }
      setState(workbench.state);
      setError(null);

      if (workbench.state.worktreeStatus !== "ready") {
        setTree(null);
        if (!dirtyDraftRef.current) { setSelectedFile(null); setSelectedFileDiff(null); setDraftContent(""); }
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
        if (dirtyDraftRef.current) setError("The current file is no longer listed. Your draft is preserved; refresh before saving.");
        else { setSelectedFile(null); setSelectedFileDiff(null); setDraftContent(""); }
        return;
      }

      let loaded = false;
      let lastError: unknown;
      for (const candidatePath of candidatePaths) {
        try {
          await loadWorkbenchFileSelection(requestSessionId, candidatePath, {
            preserveDraft: dirtyDraftRef.current && selectedFileRef.current?.path === candidatePath,
          });
          loaded = true;
          break;
        } catch (cause) {
          lastError = cause;
        }
      }

      if (!loaded && isCurrentSession(requestSessionId)) {
        if (!dirtyDraftRef.current) { setSelectedFile(null); setSelectedFileDiff(null); setDraftContent(""); }
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
  }, [enabled, isCurrentSession, loadWorkbenchFileSelection, resetWorkbench, sessionId, setPersistedExpandedPaths]);

  const saveFile = useCallback(async () => {
    if (!sessionId || !selectedFileRef.current || savingRef.current) return false;
    const requestSessionId = sessionId, activeFile = selectedFileRef.current;
    const draft = getWorkbenchDraft(sessionId, activeFile.path);
    if (!draft) return true;
    const submitted = draft.content;
    savingRef.current = true; setBusy(true); setSaving(true);
    try {
      const currentFile = await fetchChatSessionWorkbenchFile(requestSessionId, activeFile.path);
      if (!isCurrentSession(requestSessionId)) return false;
      if (currentFile.path !== activeFile.path || currentFile.state.sessionId !== requestSessionId) throw new Error("The file response does not match this editor. Your draft is preserved.");
      if (currentFile.revision !== draft.base.revision || currentFile.content !== draft.base.content || currentFile.state.worktreePath !== draft.base.state.worktreePath || currentFile.state.projectId !== draft.base.state.projectId) {
        if (selectedFileRef.current?.path === activeFile.path) { selectedFileRef.current = currentFile; setSelectedFile(currentFile); }
        throw new Error("This file changed since editing began. Review the latest version before saving your retained draft.");
      }
      const nextFile = await saveChatSessionWorkbenchFile(requestSessionId, { path: activeFile.path, content: submitted, expectedRevision: draft.base.revision });
      if (nextFile.path !== activeFile.path || nextFile.state.sessionId !== requestSessionId || nextFile.content !== submitted) throw new Error("The Gateway did not confirm the submitted file contents. Your draft is preserved.");
      const clean = acknowledgeWorkbenchDraft(requestSessionId, nextFile, submitted);
      if (isCurrentSession(requestSessionId)) fileReadRef.current += 1;
      if (!isCurrentSession(requestSessionId)) return clean;
      if (selectedFileRef.current?.path === activeFile.path) {
        selectedFileRef.current = nextFile; setSelectedFile(nextFile);
        const nextContent = getWorkbenchDraft(requestSessionId, activeFile.path)?.content ?? nextFile.content;
        draftContentRef.current = nextContent; setDraftContent(nextContent);
      }
      setError(null);
      try {
        const [nextTree, nextDiff, nextOutput, nextFileDiff] = await Promise.all([
          fetchChatSessionWorkbenchTree(requestSessionId), fetchChatSessionWorkbenchDiff(requestSessionId),
          fetchChatSessionWorkbenchOutput(requestSessionId), fetchChatSessionWorkbenchFileDiff(requestSessionId, activeFile.path),
        ]);
        if (isCurrentSession(requestSessionId)) {
          setTree(nextTree); setDiff(nextDiff); setOutput(nextOutput);
          if (selectedFileRef.current?.path === activeFile.path) setSelectedFileDiff(nextFileDiff);
          setPersistedExpandedPaths(deriveDefaultExpandedPaths(nextTree, activeFile.path, readWorkbenchUiState(requestSessionId).expandedPaths));
        }
      } catch { if (isCurrentSession(requestSessionId)) setError("File saved. Updated workbench evidence is unavailable; refresh to retry."); }
      return clean;
    } catch (cause) {
      const isConflict = cause && typeof cause === "object" && "status" in cause && cause.status === 409;
      if (isConflict && isCurrentSession(requestSessionId)) {
        let currentUnavailable = false;
        try {
          const latestFile = await fetchChatSessionWorkbenchFile(requestSessionId, activeFile.path);
          if (latestFile.state.sessionId !== requestSessionId || latestFile.path !== activeFile.path) throw new Error("Mismatched file response", { cause });
          if (isCurrentSession(requestSessionId) && selectedFileRef.current?.path === activeFile.path) {
            selectedFileRef.current = latestFile; setSelectedFile(latestFile);
          }
        } catch { currentUnavailable = true; }
        if (isCurrentSession(requestSessionId)) setError(currentUnavailable
          ? "Save was blocked and the current file is unavailable. Your draft is preserved; reload before trying again."
          : "Save was blocked by a concurrent Workbench operation. Review the latest file before saving your retained draft.");
      } else if (isCurrentSession(requestSessionId)) setError(describeWorkbenchActionError(cause, "Unable to save the active workbench file."));
      return false;
    } finally {
      savingRef.current = false;
      if (isCurrentSession(requestSessionId)) { setBusy(false); setSaving(false); }
    }
  }, [isCurrentSession, sessionId, setPersistedExpandedPaths]);

  const previewFileOperation = useCallback(async (input: ChatSessionWorkbenchFileOperationPreviewRequest) => {
    if (!sessionId) return null;
    const requestSessionId = sessionId;
    setBusy(true);
    try {
      const review = await previewChatSessionWorkbenchFileOperation(requestSessionId, input);
      if (!isCurrentSession(requestSessionId)) return null;
      setError(null);
      return review;
    } catch (cause) {
      if (isCurrentSession(requestSessionId)) setError(describeWorkbenchActionError(cause, "Unable to review this file action."));
      return null;
    } finally { if (isCurrentSession(requestSessionId)) setBusy(false); }
  }, [isCurrentSession, sessionId]);

  const runFileOperation = useCallback(
    async (input: ChatSessionWorkbenchFileOperationRequest) => {
      if (!sessionId) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
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
          setError(isConflict ? "The file action's source, destination or project changed. Review the action again before applying it."
            : describeWorkbenchActionError(cause, "Unable to update the workbench file tree."));
        }
        return false;
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    [applySelectedFileState, isCurrentSession, sessionId, setPersistedExpandedPaths],
  );

  const createWorktree = useCallback(
    async (baseRef?: string) => {
      if (!sessionId) {
        return;
      }
      const requestSessionId = sessionId;
      setBusy(true);
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
    [isCurrentSession, refresh, sessionId],
  );

  const discardDraft = useCallback(() => {
    const file = selectedFileRef.current;
    if (sessionId && file) discardWorkbenchSessionDraft(sessionId, file.path);
    draftContentRef.current = file?.content ?? "";
    setDraftContent(draftContentRef.current);
    setError(null);
  }, [sessionId]);

  const updateDraft = useCallback((content: string) => {
    const file = selectedFileRef.current;
    if (!sessionId || !file || !isCurrentSession(sessionId)) return;
    updateWorkbenchDraft(sessionId, file, content);
    draftContentRef.current = content; dirtyDraftRef.current = Boolean(getWorkbenchDraft(sessionId, file.path));
    setDraftContent(content);
  }, [isCurrentSession, sessionId]);

  const reviewCurrentFile = useCallback(() => {
    const file = selectedFileRef.current;
    if (sessionId && file) rebaseWorkbenchDraft(sessionId, file);
    setError(null);
  }, [sessionId]);

  const runValidationCommand = useCallback(
    async (input: { command: string; args?: string[]; timeoutMs?: number }) => {
      if (!sessionId) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
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
    [isCurrentSession, refresh, sessionId],
  );

  const applyPatch = useCallback(
    async (patch?: string) => {
      if (!sessionId || !patch?.trim()) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
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
    [isCurrentSession, refresh, sessionId],
  );

  const exportPatch = useCallback(async () => {
    if (!sessionId) {
      return null;
    }
    const requestSessionId = sessionId;
    setBusy(true);
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
  }, [isCurrentSession, refresh, sessionId]);

  const revertFile = useCallback(
    async (relativePath?: string) => {
      const pathToRevert = relativePath ?? selectedFileRef.current?.path;
      if (!sessionId || !pathToRevert) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
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
    [isCurrentSession, refresh, sessionId],
  );

  const revertAll = useCallback(async () => {
    if (!sessionId) {
      return false;
    }
    const requestSessionId = sessionId;
    setBusy(true);
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
  }, [isCurrentSession, refresh, sessionId]);

  useEffect(() => {
    selectedFileRef.current = null; draftContentRef.current = ""; dirtyDraftRef.current = false;
    resetWorkbench();
    if (!enabled || !sessionId) {
      resetWorkbench();
      return;
    }
    const storedUiState = readWorkbenchUiState(sessionId);
    setExpandedPaths(storedUiState.expandedPaths);
    void refresh();
  }, [enabled, refresh, resetWorkbench, sessionId]);

  useEffect(() => {
    if (!hasDirtyDraft || typeof window === "undefined") {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasDirtyDraft]);

  useRefreshSubscription(
    "chat",
    async () => {
      await refresh();
    },
    {
      enabled: enabled && Boolean(sessionId),
      coalesceMs: 900,
      staleMs: WORKBENCH_REFRESH_STALE_MS,
      pollIntervalMs: 15_000,
    },
  );

  return {
    workbenchState: state,
    workbenchTree: tree,
    selectedWorkbenchFile: selectedFile,
    selectedWorkbenchFileDiff: selectedFileDiff,
    workbenchDraftContent: draftContent,
    workbenchExpandedPaths: expandedPaths,
    workbenchDiff: diff,
    workbenchOutput: output,
    workbenchLoading: loading,
    workbenchBusy: busy,
    workbenchSaving: saving,
    workbenchError: error,
    hasDirtyWorkbenchDraft: hasDirtyDraft,
    workbenchHasRemoteChanges: hasRemoteChanges,
    workbenchDraftPaths: retainedDrafts.map((entry) => entry.base.path),
    rebaseWorkbenchDraft: reviewCurrentFile,
    setWorkbenchDraftContent: updateDraft,
    setWorkbenchExpandedPaths: setPersistedExpandedPaths,
    refreshWorkbench: refresh,
    createWorkbenchWorktree: createWorktree,
    openWorkbenchFile: loadFile,
    saveWorkbenchFile: saveFile,
    previewWorkbenchFileOperation: previewFileOperation,
    runWorkbenchFileOperation: runFileOperation,
    discardWorkbenchDraft: discardDraft,
    runWorkbenchValidationCommand: runValidationCommand,
    applyWorkbenchPatch: applyPatch,
    exportWorkbenchPatch: exportPatch,
    revertWorkbenchFile: revertFile,
    revertWorkbenchAll: revertAll,
  };
}
