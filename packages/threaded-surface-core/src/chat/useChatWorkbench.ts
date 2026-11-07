import * as draftOwner from "./workbench-session-drafts.js";
import { scopeWorkbenchDraftSession, useWorkbenchDraftVersion } from "./workbench-session-drafts.js";
import {
  getGatewayCallerScope,
  getGatewayCallerScopeRevision,
  getGatewayAccessRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { WorkbenchReadOwner } from "./workbench-read-code.js";
import type { WorkbenchActionOwner } from "./workbench-action-code.js";
import { useMemo, useCallback, useEffect, useRef, useState } from "react";
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


type WorkbenchReadModule = typeof import("./workbench-read-code.js");
let workbenchReadCode: Promise<WorkbenchReadModule> | undefined;
function loadWorkbenchReadCode(): Promise<WorkbenchReadModule> {
  return workbenchReadCode ??= import("./workbench-read-code.js").catch((cause: unknown) => {
    workbenchReadCode = undefined;
    throw cause;
  });
}

type WorkbenchActionModule = typeof import("./workbench-action-code.js");
let workbenchActionCode: Promise<WorkbenchActionModule> | undefined;
function loadWorkbenchActionCode(): Promise<WorkbenchActionModule> {
  return (workbenchActionCode ??= import("./workbench-action-code.js").catch((cause) => {
    workbenchActionCode = undefined;
    throw cause;
  }));
}

const alwaysCurrent = () => true;

export function useChatWorkbench(input: {
  sessionId: string | null;
  enabled: boolean;
  workspaceId?: string;
  isCurrentOwner?: () => boolean;
}) {
  const { sessionId, enabled, isCurrentOwner = alwaysCurrent } = input;
  const callerScope = getGatewayCallerScope();
  const draftHelpers = useMemo(() => {
    const scoped = (id: string) => scopeWorkbenchDraftSession(callerScope, id);
    return {
      getWorkbenchDraft: (id: string, path: string) => draftOwner.getWorkbenchDraft(scoped(id), path),
      listWorkbenchDrafts: (id: string | null) => draftOwner.listWorkbenchDrafts(id ? scoped(id) : null),
      updateWorkbenchDraft: (id: string, file: ChatSessionWorkbenchFileResponse, content: string) =>
        draftOwner.updateWorkbenchDraft(scoped(id), file, content),
      discardWorkbenchSessionDraft: (id: string, path: string) =>
        draftOwner.discardWorkbenchSessionDraft(scoped(id), path),
      acknowledgeWorkbenchDraft: (id: string, file: ChatSessionWorkbenchFileResponse, content: string) =>
        draftOwner.acknowledgeWorkbenchDraft(scoped(id), file, content),
      rebaseWorkbenchDraft: (id: string, file: ChatSessionWorkbenchFileResponse) =>
        draftOwner.rebaseWorkbenchDraft(scoped(id), file),
    };
  }, [callerScope]);
  const { getWorkbenchDraft, listWorkbenchDrafts } = draftHelpers;
  // Callbacks read the render-current caller-scoped helpers through a synced ref, so a caller-scope
  // change never re-keys refresh/reset effects yet drafts are never written under a stale caller.
  const draftHelpersRef = useRef(draftHelpers);
  draftHelpersRef.current = draftHelpers;
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
  if (ownerRef.current.sessionId !== sessionId || ownerRef.current.enabled !== enabled)
    ownerRef.current = { sessionId, enabled };
  const owner = ownerRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const actionLifetimeRef = useRef(0);
  useEffect(
    () => () => {
      actionLifetimeRef.current += 1;
    },
    [],
  );
  const nextActionView = {
    sessionId,
    enabled,
    workspaceId: input.workspaceId,
    caller: getGatewayCallerScopeRevision(),
    access: getGatewayAccessRevision(),
    gateway: getGatewayApiBaseUrl(),
  };
  const actionViewRef = useRef(nextActionView);
  if (
    Object.keys(nextActionView).some(
      (key) =>
        nextActionView[key as keyof typeof nextActionView] !==
        actionViewRef.current[key as keyof typeof nextActionView],
    )
  )
    actionViewRef.current = nextActionView;
  const actionView = actionViewRef.current;
  type ActionAttempt = { view: typeof actionView; lifetime: number; saving: boolean };
  const busyAttemptRef = useRef<ActionAttempt | null>(null);
  const saveAttemptRef = useRef<ActionAttempt | null>(null);
  const isCurrentAction = useCallback(
    (view: typeof actionView): boolean => {
      return (
        isCurrentOwner() &&
        mountedRef.current &&
        actionViewRef.current === view &&
        ownerRef.current === owner &&
        getGatewayCallerScopeRevision() === view.caller &&
        getGatewayAccessRevision() === view.access &&
        getGatewayApiBaseUrl() === view.gateway
      );
    },
    [isCurrentOwner, owner],
  );
  const claimAction = useCallback((view: typeof actionView, saving: boolean): ActionAttempt => {
    const attempt = { view, saving, lifetime: actionLifetimeRef.current };
    busyAttemptRef.current = attempt;
    if (saving) saveAttemptRef.current = attempt;
    return attempt;
  }, []);
  const savingRef = useRef(false);
  const fileReadRef = useRef(0);
  const draftVersion = useWorkbenchDraftVersion();
  const selectedFileRef = useRef<ChatSessionWorkbenchFileResponse | null>(null);
  const draftContentRef = useRef("");
  const dirtyDraftRef = useRef(false);

  const retainedDraftPaths = useMemo(() => {
    // Re-read the mutable draft store on each published revision.
    void draftVersion;
    return listWorkbenchDrafts(sessionId).map((entry) => entry.base.path);
  }, [draftVersion, listWorkbenchDrafts, sessionId]);
  const activeDraft = sessionId && selectedFile ? getWorkbenchDraft(sessionId, selectedFile.path) : undefined;
  const hasDirtyDraft = Boolean(activeDraft);
  const hasRemoteChanges = Boolean(
    activeDraft &&
    selectedFile &&
    (activeDraft.base.revision !== selectedFile.revision ||
      activeDraft.base.content !== selectedFile.content ||
      activeDraft.base.state.worktreePath !== selectedFile.state.worktreePath ||
      activeDraft.base.state.projectId !== selectedFile.state.projectId),
  );

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
      if (!isCurrentOwner()) return;
      const normalized = normalizeWorkbenchPaths(nextPaths);
      setExpandedPaths(normalized);
      writeWorkbenchUiState(sessionId, { expandedPaths: normalized });
    },
    [isCurrentOwner, sessionId],
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

  const isCurrentSession = useCallback(
    (candidateSessionId: string | null) => {
      return (
        isCurrentOwner() &&
        mountedRef.current &&
        enabled &&
        Boolean(candidateSessionId) &&
        ownerRef.current === owner &&
        owner.sessionId === candidateSessionId
      );
    },
    [enabled, isCurrentOwner, owner],
  );

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
      const retained = sessionId ? draftHelpersRef.current.getWorkbenchDraft(sessionId, nextFile.path) : undefined;
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


  const readLoadingAttemptRef = useRef<{ view: typeof actionView; lifetime: number } | null>(null);
  useEffect(() => {
    const attempt = readLoadingAttemptRef.current;
    if (attempt && (!isCurrentAction(attempt.view) || attempt.lifetime !== actionLifetimeRef.current)) {
      readLoadingAttemptRef.current = null;
      setLoading(false);
    }
  }, [actionView, isCurrentAction]);
  const makeReadOwner = useCallback((view: typeof actionView, lifetime: number, loadingToken?: object): WorkbenchReadOwner => {
    const current = () => isCurrentAction(view) && actionLifetimeRef.current === lifetime;
    return {
      requireCurrent: () => { if (!current()) throw new Error("The workbench read owner changed."); },
      isCurrentSession: candidate => current() && isCurrentSession(candidate),
      selectedFileRef, draftContentRef, fileReadRef, dirtyDraftRef,
      setState, setTree, setDiff, setOutput, setSelectedFile, setSelectedFileDiff, setDraftContent, setError,
      setLoading: value => { if (current() && readLoadingAttemptRef.current === loadingToken) setLoading(value); },
      setPersistedExpandedPaths, deriveDefaultExpandedPaths, readWorkbenchUiState,
      describeWorkbenchActionError, applySelectedFileState,
    };
  }, [applySelectedFileState, isCurrentAction, isCurrentSession, setPersistedExpandedPaths]);
  const loadWorkbenchFileSelection = useCallback(async (
    requestSessionId: string, relativePath: string, options: { preserveDraft?: boolean } = {},
  ): Promise<ChatSessionWorkbenchFileResponse | null> => {
    const view = actionViewRef.current;
    const lifetime = actionLifetimeRef.current;
    if (!isCurrentSession(requestSessionId) || !isCurrentAction(view)) return null;
    const readId = ++fileReadRef.current;
    const readOwner = makeReadOwner(view, lifetime);
    readOwner.fileReadGeneration = readId;
    const code = await loadWorkbenchReadCode();
    if (!readOwner.isCurrentSession(requestSessionId) || readId !== fileReadRef.current) return null;
    return code.createWorkbenchReadCode(readOwner).loadFileSelection(requestSessionId, relativePath, options);
  }, [isCurrentAction, isCurrentSession, makeReadOwner]);
  const refresh = useCallback(async () => {
    // Read attempts capture the live action view without changing the enabled subscription cadence.
    const view = actionViewRef.current;
    if (!enabled || !sessionId || !isCurrentSession(sessionId) || !isCurrentAction(view)) return;
    const lifetime = actionLifetimeRef.current;
    const token = { view, lifetime };
    readLoadingAttemptRef.current = token;
    setLoading(true);
    const readOwner = makeReadOwner(view, lifetime, token);
    try {
      const code = await loadWorkbenchReadCode();
      if (!readOwner.isCurrentSession(sessionId)) return;
      await code.createWorkbenchReadCode(readOwner).refresh(sessionId);
    } catch (cause) {
      if (readOwner.isCurrentSession(sessionId)) setError(describeWorkbenchActionError(cause, "Unable to load workbench."));
    } finally {
      if (readLoadingAttemptRef.current === token) {
        readLoadingAttemptRef.current = null;
        if (readOwner.isCurrentSession(sessionId)) setLoading(false);
      }
    }
  }, [enabled, isCurrentAction, isCurrentSession, makeReadOwner, sessionId]);

  const loadFile = useCallback(
    async (relativePath: string) => {
      const view = actionViewRef.current;
      if (!sessionId || !isCurrentSession(sessionId) || !isCurrentAction(view)) {
        return false;
      }
      const requestSessionId = sessionId;
      const lifetime = actionLifetimeRef.current;
      const current = () => isCurrentSession(requestSessionId) && isCurrentAction(view) && actionLifetimeRef.current === lifetime;
      const attempt = claimAction(view, false);
      setBusy(true);
      try {
        await loadWorkbenchFileSelection(requestSessionId, relativePath);
        if (!current()) {
          return false;
        }
        setError(null);
        return true;
      } catch (cause) {
        if (current()) {
          const retained = draftHelpersRef.current.getWorkbenchDraft(requestSessionId, relativePath);
          if (retained) {
            selectedFileRef.current = retained.base;
            setSelectedFile(retained.base);
            setSelectedFileDiff(null);
            draftContentRef.current = retained.content;
            setDraftContent(retained.content);
          }
          setError(
            retained
              ? "Current file unavailable. This is your retained draft; saving requires a current file read."
              : describeWorkbenchActionError(cause, "Unable to load workbench file."),
          );
        }
        return false;
      } finally {
        if (busyAttemptRef.current === attempt) {
          busyAttemptRef.current = null;
          if (mountedRef.current && actionLifetimeRef.current === lifetime) setBusy(false);
        }
      }
    },
    [claimAction, isCurrentAction, isCurrentSession, loadWorkbenchFileSelection, sessionId],
  );

  const runOptionalAction = useCallback(
    async <Value, Input = undefined>(
      attempt: ActionAttempt,
      execute: (
        actions: ReturnType<WorkbenchActionModule["createWorkbenchActionCode"]>,
        input: Input,
      ) => Promise<Value>,
      fallback: Value,
      fallbackMessage: string,
      input?: Input,
    ): Promise<Value> => {
      const current = () => isCurrentAction(attempt.view) && actionLifetimeRef.current === attempt.lifetime;
      const stillMounted = () => mountedRef.current && actionLifetimeRef.current === attempt.lifetime;
      const ownsBusy = () => busyAttemptRef.current === attempt;
      const ownsSave = () => saveAttemptRef.current === attempt;
      try {
        const serialized = input === undefined ? undefined : JSON.stringify(input);
        const admittedInput = serialized === undefined ? input : (JSON.parse(serialized) as Input);
        if (!current()) return fallback;
        const code = await loadWorkbenchActionCode();
        if (!current()) return fallback;
        const owner: WorkbenchActionOwner = {
          requireCurrent: () => {
            if (!current()) throw new Error("The workbench owner changed before the action could continue.");
          },
          isCurrentSession: (candidate) => current() && isCurrentSession(candidate),
          savingRef,
          selectedFileRef,
          draftContentRef,
          fileReadRef,
          setBusy: (value) => {
            if (stillMounted() && ownsBusy()) setBusy(value);
          },
          setSaving: (value) => {
            if (stillMounted() && ownsSave()) setSaving(value);
          },
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
          refresh,
        };
        return await execute(code.createWorkbenchActionCode(owner), admittedInput as Input);
      } catch (cause) {
        if (current()) setError(describeWorkbenchActionError(cause, fallbackMessage));
        return fallback;
      } finally {
        if (ownsBusy()) {
          busyAttemptRef.current = null;
          if (stillMounted()) setBusy(false);
        }
        if (attempt.saving && ownsSave()) {
          saveAttemptRef.current = null;
          savingRef.current = false;
          if (stillMounted()) setSaving(false);
        }
      }
    },
    [applySelectedFileState, isCurrentAction, isCurrentSession, refresh, setPersistedExpandedPaths],
  );
  const saveFile = useCallback(async () => {
    if (!isCurrentAction(actionView)) return false;

    if (!sessionId || !selectedFileRef.current || savingRef.current) return false;
    const requestSessionId = sessionId,
      activeFile = selectedFileRef.current;
    const draftHelpersAtAdmission = draftHelpersRef.current;
    const draft = draftHelpersRef.current.getWorkbenchDraft(sessionId, activeFile.path);
    if (!draft) return true;
    const submitted = draft.content;
    savingRef.current = true;
    setBusy(true);
    setSaving(true);
    const attempt = claimAction(actionView, true);
    return runOptionalAction(
      attempt,
      (actions) => actions.saveFile({ requestSessionId, activeFile, draft, submitted, draftHelpersAtAdmission }),
      false,
      "Unable to save the active workbench file.",
    );
  }, [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction]);

  const previewFileOperation = useCallback(
    async (input: ChatSessionWorkbenchFileOperationPreviewRequest) => {
      if (!isCurrentAction(actionView)) return null;

      if (!sessionId) return null;
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions, admittedInput) => actions.previewFileOperation({ requestSessionId, input: admittedInput }),
        null,
        "Unable to review this file action.",
        input,
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const runFileOperation = useCallback(
    async (input: ChatSessionWorkbenchFileOperationRequest) => {
      if (!isCurrentAction(actionView)) return false;

      if (!sessionId) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions, admittedInput) => actions.runFileOperation({ requestSessionId, input: admittedInput }),
        false,
        "Unable to update the workbench file tree.",
        input,
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const createWorktree = useCallback(
    async (baseRef?: string) => {
      if (!isCurrentAction(actionView)) return undefined;

      if (!sessionId) {
        return;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions) => actions.createWorktree({ requestSessionId, baseRef }),
        undefined,
        "Unable to create worktree.",
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const discardDraft = useCallback(() => {
    if (!isCurrentOwner()) return;
    const file = selectedFileRef.current;
    if (sessionId && file) draftHelpersRef.current.discardWorkbenchSessionDraft(sessionId, file.path);
    draftContentRef.current = file?.content ?? "";
    setDraftContent(draftContentRef.current);
    setError(null);
  }, [isCurrentOwner, sessionId]);

  const updateDraft = useCallback(
    (content: string) => {
      const file = selectedFileRef.current;
      if (!sessionId || !file || !isCurrentSession(sessionId)) return;
      draftHelpersRef.current.updateWorkbenchDraft(sessionId, file, content);
      draftContentRef.current = content;
      dirtyDraftRef.current = Boolean(draftHelpersRef.current.getWorkbenchDraft(sessionId, file.path));
      setDraftContent(content);
    },
    [isCurrentSession, sessionId],
  );

  const reviewCurrentFile = useCallback(() => {
    if (!isCurrentOwner()) return;
    const file = selectedFileRef.current;
    if (sessionId && file) draftHelpersRef.current.rebaseWorkbenchDraft(sessionId, file);
    setError(null);
  }, [isCurrentOwner, sessionId]);

  const runValidationCommand = useCallback(
    async (input: { command: string; args?: string[]; timeoutMs?: number }) => {
      if (!isCurrentAction(actionView)) return false;

      if (!sessionId) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions, admittedInput) => actions.runValidationCommand({ requestSessionId, input: admittedInput }),
        false,
        "Unable to run workbench validation.",
        input,
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const applyPatch = useCallback(
    async (patch?: string) => {
      if (!isCurrentAction(actionView)) return false;

      if (!sessionId || !patch?.trim()) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions) => actions.applyPatch({ requestSessionId, patch }),
        false,
        "Unable to apply the workbench patch.",
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const exportPatch = useCallback(async () => {
    if (!isCurrentAction(actionView)) return null;

    if (!sessionId) {
      return null;
    }
    const requestSessionId = sessionId;
    setBusy(true);
    const attempt = claimAction(actionView, false);
    return runOptionalAction(
      attempt,
      (actions) => actions.exportPatch({ requestSessionId }),
      null,
      "Unable to export the workbench patch.",
    );
  }, [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction]);

  const revertFile = useCallback(
    async (relativePath?: string) => {
      if (!isCurrentAction(actionView)) return false;

      const pathToRevert = relativePath ?? selectedFileRef.current?.path;
      if (!sessionId || !pathToRevert) {
        return false;
      }
      const requestSessionId = sessionId;
      setBusy(true);
      const attempt = claimAction(actionView, false);
      return runOptionalAction(
        attempt,
        (actions) => actions.revertFile({ requestSessionId, pathToRevert }),
        false,
        "Unable to revert the selected workbench file.",
      );
    },
    [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction],
  );

  const revertAll = useCallback(async () => {
    if (!isCurrentAction(actionView)) return false;

    if (!sessionId) {
      return false;
    }
    const requestSessionId = sessionId;
    setBusy(true);
    const attempt = claimAction(actionView, false);
    return runOptionalAction(
      attempt,
      (actions) => actions.revertAll({ requestSessionId }),
      false,
      "Unable to revert workbench changes.",
    );
  }, [sessionId, actionView, isCurrentAction, claimAction, runOptionalAction]);

  useEffect(() => {
    selectedFileRef.current = null;
    draftContentRef.current = "";
    dirtyDraftRef.current = false;
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
    workbenchDraftPaths: retainedDraftPaths,
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
