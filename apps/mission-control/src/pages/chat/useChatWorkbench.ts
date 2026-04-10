import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatSessionWorkbenchDiffResponse,
  ChatSessionWorkbenchFileResponse,
  ChatSessionWorkbenchOutputResponse,
  ChatSessionWorkbenchRecord,
  ChatSessionWorkbenchTreeResponse,
} from "@goatcitadel/contracts";
import {
  createChatSessionWorkbenchWorktree,
  fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchDiff,
  fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchOutput,
  fetchChatSessionWorkbenchTree,
} from "../../api/chat";

export function useChatWorkbench(input: { sessionId: string | null; enabled: boolean }) {
  const { sessionId, enabled } = input;
  const [state, setState] = useState<ChatSessionWorkbenchRecord | null>(null);
  const [tree, setTree] = useState<ChatSessionWorkbenchTreeResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<ChatSessionWorkbenchFileResponse | null>(null);
  const [diff, setDiff] = useState<ChatSessionWorkbenchDiffResponse | null>(null);
  const [output, setOutput] = useState<ChatSessionWorkbenchOutputResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  const resetWorkbench = useCallback(() => {
    setState(null);
    setTree(null);
    setSelectedFile(null);
    setDiff(null);
    setOutput(null);
    setLoading(false);
    setBusy(false);
    setError(null);
  }, []);

  const isCurrentSession = useCallback((candidateSessionId: string | null) => {
    return Boolean(candidateSessionId) && activeSessionRef.current === candidateSessionId;
  }, []);

  const loadFile = useCallback(
    async (relativePath: string) => {
      if (!sessionId) {
        return;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      try {
        const nextFile = await fetchChatSessionWorkbenchFile(requestSessionId, relativePath);
        if (!isCurrentSession(requestSessionId)) {
          return;
        }
        setSelectedFile(nextFile);
        setState(nextFile.state);
        setError(null);
      } catch (cause) {
        if (isCurrentSession(requestSessionId)) {
          setError(cause instanceof Error ? cause.message : "Unable to load workbench file.");
        }
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    [isCurrentSession, sessionId],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) {
      resetWorkbench();
      return;
    }
    const requestSessionId = sessionId;
    setLoading(true);
    try {
      const workbench = await fetchChatSessionWorkbench(requestSessionId);
      if (!isCurrentSession(requestSessionId)) {
        return;
      }
      setState(workbench.state);
      setError(null);

      if (workbench.state.worktreeStatus === "ready") {
        const [nextTree, nextDiff, nextOutput] = await Promise.all([
          fetchChatSessionWorkbenchTree(requestSessionId),
          fetchChatSessionWorkbenchDiff(requestSessionId),
          fetchChatSessionWorkbenchOutput(requestSessionId),
        ]);
        if (!isCurrentSession(requestSessionId)) {
          return;
        }
        setTree(nextTree);
        setDiff(nextDiff);
        setOutput(nextOutput);
        setState(nextOutput.state);
        const nextFilePath =
          nextOutput.state.activeFilePath ??
          nextTree.changedFiles[0] ??
          nextTree.items.find((item) => item.kind === "file")?.path;
        if (nextFilePath) {
          const nextFile = await fetchChatSessionWorkbenchFile(requestSessionId, nextFilePath);
          if (!isCurrentSession(requestSessionId)) {
            return;
          }
          setSelectedFile(nextFile);
          setState(nextFile.state);
        } else {
          setSelectedFile(null);
        }
      } else {
        setTree(null);
        setSelectedFile(null);
        setDiff(null);
        setOutput(null);
      }
    } catch (cause) {
      if (isCurrentSession(requestSessionId)) {
        setError(cause instanceof Error ? cause.message : "Unable to load workbench.");
      }
    } finally {
      if (isCurrentSession(requestSessionId)) {
        setLoading(false);
      }
    }
  }, [enabled, isCurrentSession, resetWorkbench, sessionId]);

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
          setError(cause instanceof Error ? cause.message : "Unable to create worktree.");
        }
      } finally {
        if (isCurrentSession(requestSessionId)) {
          setBusy(false);
        }
      }
    },
    [isCurrentSession, refresh, sessionId],
  );

  useEffect(() => {
    activeSessionRef.current = enabled ? sessionId : null;
    if (!enabled || !sessionId) {
      resetWorkbench();
      return;
    }
    void refresh();
  }, [enabled, refresh, resetWorkbench, sessionId]);

  return {
    workbenchState: state,
    workbenchTree: tree,
    selectedWorkbenchFile: selectedFile,
    workbenchDiff: diff,
    workbenchOutput: output,
    workbenchLoading: loading,
    workbenchBusy: busy,
    workbenchError: error,
    refreshWorkbench: refresh,
    createWorkbenchWorktree: createWorktree,
    openWorkbenchFile: loadFile,
  };
}
