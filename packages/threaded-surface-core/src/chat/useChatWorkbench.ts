import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileDiffResponse,
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
  const activeSessionRef = useRef<string | null>(null);
  const selectedFileRef = useRef<ChatSessionWorkbenchFileResponse | null>(null);
  const draftContentRef = useRef("");
  const dirtyDraftRef = useRef(false);

  const hasDirtyDraft = Boolean(selectedFile && draftContent !== selectedFile.content);

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
    return Boolean(candidateSessionId) && activeSessionRef.current === candidateSessionId;
  }, []);

  const applySelectedFileState = useCallback(
    (
      nextFile: ChatSessionWorkbenchFileResponse,
      nextFileDiff: ChatSessionWorkbenchFileDiffResponse,
      options: { preserveDraft?: boolean } = {},
    ) => {
      setSelectedFile(nextFile);
      setSelectedFileDiff(nextFileDiff);
      setState(nextFile.state);
      if (!options.preserveDraft) {
        setDraftContent(nextFile.content);
      }
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
      const [nextFile, nextFileDiff] = await Promise.all([
        fetchChatSessionWorkbenchFile(requestSessionId, relativePath),
        fetchChatSessionWorkbenchFileDiff(requestSessionId, relativePath),
      ]);
      if (!isCurrentSession(requestSessionId)) {
        return null;
      }
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
          setError(describeWorkbenchActionError(cause, "Unable to load workbench file."));
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
        setSelectedFile(null);
        setSelectedFileDiff(null);
        setDraftContent("");
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
        setSelectedFile(null);
        setSelectedFileDiff(null);
        setDraftContent("");
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
        setSelectedFile(null);
        setSelectedFileDiff(null);
        setDraftContent("");
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
    if (!sessionId || !selectedFileRef.current) {
      return false;
    }
    const requestSessionId = sessionId;
    const activeFile = selectedFileRef.current;
    setBusy(true);
    setSaving(true);
    try {
      const nextFile = await saveChatSessionWorkbenchFile(requestSessionId, {
        path: activeFile.path,
        content: draftContentRef.current,
      });
      if (!isCurrentSession(requestSessionId)) {
        return false;
      }

      const [nextTree, nextDiff, nextOutput, nextFileDiff] = await Promise.all([
        fetchChatSessionWorkbenchTree(requestSessionId),
        fetchChatSessionWorkbenchDiff(requestSessionId),
        fetchChatSessionWorkbenchOutput(requestSessionId),
        fetchChatSessionWorkbenchFileDiff(requestSessionId, activeFile.path),
      ]);
      if (!isCurrentSession(requestSessionId)) {
        return false;
      }

      setTree(nextTree);
      setDiff(nextDiff);
      setOutput(nextOutput);
      setPersistedExpandedPaths(
        deriveDefaultExpandedPaths(nextTree, activeFile.path, readWorkbenchUiState(requestSessionId).expandedPaths),
      );
      applySelectedFileState(nextFile, nextFileDiff, { preserveDraft: false });
      setError(null);
      return true;
    } catch (cause) {
      if (isCurrentSession(requestSessionId)) {
        setError(describeWorkbenchActionError(cause, "Unable to save the active workbench file."));
      }
      return false;
    } finally {
      if (isCurrentSession(requestSessionId)) {
        setBusy(false);
        setSaving(false);
      }
    }
  }, [applySelectedFileState, isCurrentSession, sessionId, setPersistedExpandedPaths]);

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
    setDraftContent(selectedFileRef.current?.content ?? "");
    setError(null);
  }, []);

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
    activeSessionRef.current = enabled ? sessionId : null;
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
    setWorkbenchDraftContent: setDraftContent,
    setWorkbenchExpandedPaths: setPersistedExpandedPaths,
    refreshWorkbench: refresh,
    createWorkbenchWorktree: createWorktree,
    openWorkbenchFile: loadFile,
    saveWorkbenchFile: saveFile,
    discardWorkbenchDraft: discardDraft,
    runWorkbenchValidationCommand: runValidationCommand,
    applyWorkbenchPatch: applyPatch,
    exportWorkbenchPatch: exportPatch,
    revertWorkbenchFile: revertFile,
    revertWorkbenchAll: revertAll,
  };
}
