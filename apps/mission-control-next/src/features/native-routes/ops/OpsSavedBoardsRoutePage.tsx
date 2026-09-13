import { useSessionDraft, hasSessionDraft } from "../library/session-drafts";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { DetailInspector } from "../../../components/DetailInspector";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SetStateAction } from "react";
import { Archive, PanelsTopLeft, Pencil, Plus, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import {
  archiveOpsSavedBoard,
  createOpsSavedBoard,
  fetchOpsSavedBoard,
  fetchOpsSavedBoards,
  restoreOpsSavedBoard,
  updateOpsSavedBoard,
} from "@goatcitadel/mission-control-shared/api/ops-saved-boards";
import {
  OPS_SAVED_BOARD_REALTIME_COALESCE_MS,
  OpsSavedBoardRealtimeCursor,
  subscribeOpsSavedBoardRealtime,
} from "@next/app/ops-saved-board-realtime";
import { getRouteReleaseScope, routeKicker } from "@next/app/route-model";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import { presentNativeRouteError } from "../shared/native-route-errors";
import { OpsSavedBoardsEditor, type OpsSavedBoardsEditorSession } from "./OpsSavedBoardsEditor";
import { createOpsSavedBoardsDraft } from "./OpsSavedBoardsModel";
import { OpsSavedBoardsWidget } from "./OpsSavedBoardsWidgets";
import "../native-routes.css";

type PendingTransition = "archive" | "restore" | null;

export function OpsSavedBoardsRoutePage(props: NativeRoutePagesProps) {
  const [stateWorkspaceId, setStateWorkspaceId] = useState(props.activeWorkspaceId);
  const [boards, setBoards] = useState<OpsSavedBoardRecord[] | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<OpsSavedBoardRecord | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardGeneration, setBoardGeneration] = useState(0);
  const leave = useDraftLeave();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState("create");
  const [createEpoch, setCreateEpoch] = useState(0);
  const createSeed = useMemo(
    () => ({
      workspaceId: props.activeWorkspaceId,
      epoch: createEpoch,
      value: {
        mode: "create",
        idempotencyKey: createRequestIdentity(),
        draft: createOpsSavedBoardsDraft(),
      } as OpsSavedBoardsEditorSession,
    }),
    [props.activeWorkspaceId, createEpoch],
  );
  const canonicalEditor: OpsSavedBoardsEditorSession =
    editorTarget === "create"
      ? createSeed.value
      : {
          mode: "edit",
          boardId: editorTarget,
          expectedRevision: selectedBoard?.boardId === editorTarget ? selectedBoard.revision : undefined,
          draft: createOpsSavedBoardsDraft(selectedBoard?.boardId === editorTarget ? selectedBoard : undefined),
        };
  const editorStore = useSessionDraft(
    "ops-board:" + props.activeWorkspaceId + ":" + editorTarget,
    canonicalEditor,
    canonicalEditor.expectedRevision,
    {
      label: "Board layout",
      active: editorOpen,
      available: editorTarget === "create" || selectedBoard?.boardId === editorTarget,
      onSave: () => saveEditor(),
    },
  );
  const editor = editorOpen ? editorStore.value : null;
  const setEditor = (update: SetStateAction<OpsSavedBoardsEditorSession | null>) => {
    const value = typeof update === "function" ? update(editor) : update;
    if (value) {
      editorStore.setValue(value);
      setEditorOpen(true);
    } else setEditorOpen(false);
  };
  const mutationBusyRef = useRef(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorConflict, setEditorConflict] = useState<OpsSavedBoardRecord | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition>(null);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const activeWorkspaceRef = useRef(props.activeWorkspaceId);
  activeWorkspaceRef.current = props.activeWorkspaceId;
  const selectedBoardIdRef = useRef<string | null>(selectedBoardId);
  selectedBoardIdRef.current = selectedBoardId;
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const realtimeCursorRef = useRef(new OpsSavedBoardRealtimeCursor());
  const realtimeReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadBoard = useCallback(
    async (boardId: string, workspaceId = props.activeWorkspaceId) => {
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      setBoardLoading(true);
      setBoardError(null);
      try {
        const board = await fetchOpsSavedBoard(workspaceId, boardId);
        if (!isCurrentRequest(mountedRef, activeWorkspaceRef, detailRequestRef, workspaceId, requestId)) return;
        setSelectedBoard(board);
        setBoardGeneration((generation) => generation + 1);
      } catch (error) {
        if (!isCurrentRequest(mountedRef, activeWorkspaceRef, detailRequestRef, workspaceId, requestId)) return;
        setSelectedBoard(null);
        setBoardError(errorMessage(error, "Could not load the selected board."));
      } finally {
        if (isCurrentRequest(mountedRef, activeWorkspaceRef, detailRequestRef, workspaceId, requestId)) {
          setBoardLoading(false);
        }
      }
    },
    [props.activeWorkspaceId],
  );

  const loadBoards = useCallback(
    async (preferredBoardId?: string, archivedOverride?: boolean) => {
      const workspaceId = props.activeWorkspaceId;
      const requestId = listRequestRef.current + 1;
      listRequestRef.current = requestId;
      setListLoading(true);
      setListError(null);
      try {
        const result = await fetchOpsSavedBoards({
          workspaceId,
          includeArchived: archivedOverride ?? includeArchived,
        });
        if (!isCurrentRequest(mountedRef, activeWorkspaceRef, listRequestRef, workspaceId, requestId)) return;
        realtimeCursorRef.current.replaceCanonicalRecords(result.items);
        setBoards(result.items);
        const preferred =
          preferredBoardId && result.items.some((board) => board.boardId === preferredBoardId)
            ? preferredBoardId
            : undefined;
        const retained =
          selectedBoardIdRef.current && result.items.some((board) => board.boardId === selectedBoardIdRef.current)
            ? selectedBoardIdRef.current
            : undefined;
        const nextBoardId = preferred ?? retained ?? result.items[0]?.boardId ?? null;
        setSelectedBoardId(nextBoardId);
        selectedBoardIdRef.current = nextBoardId;
        if (nextBoardId) {
          await loadBoard(nextBoardId, workspaceId);
        } else {
          detailRequestRef.current += 1;
          setSelectedBoard(null);
          setBoardLoading(false);
          setBoardError(null);
        }
      } catch (error) {
        if (!isCurrentRequest(mountedRef, activeWorkspaceRef, listRequestRef, workspaceId, requestId)) return;
        setListError(errorMessage(error, "Could not load saved Ops boards."));
      } finally {
        if (isCurrentRequest(mountedRef, activeWorkspaceRef, listRequestRef, workspaceId, requestId)) {
          setListLoading(false);
        }
      }
    },
    [includeArchived, loadBoard, props.activeWorkspaceId],
  );

  useEffect(() => {
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    mutationRequestRef.current += 1;
    mutationBusyRef.current = false;
    setStateWorkspaceId(props.activeWorkspaceId);
    setBoards(null);
    setSelectedBoardId(null);
    selectedBoardIdRef.current = null;
    setSelectedBoard(null);
    setEditorOpen(false);
    setEditorBusy(false);
    setEditorError(null);
    setEditorConflict(null);
    setTransitionBusy(false);
    setTransitionError(null);
    setPendingTransition(null);
    realtimeCursorRef.current.reset();
    if (realtimeReloadTimerRef.current !== null) {
      clearTimeout(realtimeReloadTimerRef.current);
      realtimeReloadTimerRef.current = null;
    }
  }, [props.activeWorkspaceId]);

  useEffect(() => {
    void loadBoards();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadBoards]);

  useEffect(() => {
    const workspaceId = props.activeWorkspaceId;
    const unsubscribe = subscribeOpsSavedBoardRealtime((signal) => {
      if (signal.kind === "change" && signal.workspaceId !== workspaceId) return;
      const decision = realtimeCursorRef.current.decide(signal);
      if (!decision.reload) return;

      // Reject every in-flight read before coalescing the canonical reload.
      // Mutations keep their own CAS/request identity and are never replayed.
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
      if (realtimeReloadTimerRef.current !== null) return;
      realtimeReloadTimerRef.current = setTimeout(() => {
        realtimeReloadTimerRef.current = null;
        if (!mountedRef.current || activeWorkspaceRef.current !== workspaceId) return;
        void loadBoards(selectedBoardIdRef.current ?? undefined);
      }, OPS_SAVED_BOARD_REALTIME_COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (realtimeReloadTimerRef.current !== null) {
        clearTimeout(realtimeReloadTimerRef.current);
        realtimeReloadTimerRef.current = null;
      }
    };
  }, [loadBoards, props.activeWorkspaceId]);

  useEffect(() => {
    const realtimeCursor = realtimeCursorRef.current;
    // React Strict Mode probes effect cleanup before the live development
    // setup. Reassert liveness here so that probe cannot permanently fence
    // every canonical response for this mounted route.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
      mutationRequestRef.current += 1;
      realtimeCursor.reset();
      if (realtimeReloadTimerRef.current !== null) clearTimeout(realtimeReloadTimerRef.current);
      realtimeReloadTimerRef.current = null;
    };
  }, []);

  const selectBoard = (boardId: string) => {
    setSelectedBoardId(boardId);
    selectedBoardIdRef.current = boardId;
    setEditor(null);
    setEditorError(null);
    setEditorConflict(null);
    setTransitionError(null);
    setPendingTransition(null);
    void loadBoard(boardId);
  };

  const beginCreate = () =>
    leave.request(() => {
      setEditorTarget("create");
      setEditorOpen(true);
      setEditorError(null);
      setEditorConflict(null);
      setTransitionError(null);
    });
  const beginEdit = () => {
    if (!selectedBoard || selectedBoard.status !== "active") return;
    leave.request(() => {
      setEditorTarget(selectedBoard.boardId);
      setEditorOpen(true);
      setEditorError(null);
      setEditorConflict(null);
      setTransitionError(null);
    });
  };

  const saveEditor = async (): Promise<boolean> => {
    const currentEditor = editor;
    if (!currentEditor || mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    const workspaceId = props.activeWorkspaceId;
    const requestId = mutationRequestRef.current + 1;
    mutationRequestRef.current = requestId;
    setEditorBusy(true);
    setEditorError(null);
    setEditorConflict(null);
    try {
      const description = currentEditor.draft.description.normalize("NFKC").trim();
      const common = {
        workspaceId,
        name: currentEditor.draft.name,
        placements: currentEditor.draft.placements,
      };
      const saved =
        currentEditor.mode === "create"
          ? await createOpsSavedBoard({
              ...common,
              ...(description ? { description: currentEditor.draft.description } : {}),
              idempotencyKey: currentEditor.idempotencyKey ?? createRequestIdentity(),
            })
          : await updateOpsSavedBoard(requireValue(currentEditor.boardId, "board identity"), {
              ...common,
              description: description ? currentEditor.draft.description : null,
              expectedRevision: requireValue(currentEditor.expectedRevision, "board revision"),
            });
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return false;
      const cleared = editorStore.acceptSaved(
        { ...currentEditor, expectedRevision: saved.revision, draft: createOpsSavedBoardsDraft(saved) },
        saved.revision,
        currentEditor,
      );
      if (cleared) {
        editorStore.discard();
        setEditor(null);
        if (currentEditor.mode === "create") setCreateEpoch((value) => value + 1);
      }
      setEditorError(null);
      setEditorConflict(null);
      await loadBoards(saved.boardId);
      return cleared;
    } catch (error) {
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return false;
      if (errorStatus(error) === 409) {
        if (currentEditor.mode === "edit" && currentEditor.boardId) {
          await refreshEditConflict(currentEditor.boardId, workspaceId, requestId);
        } else {
          setEditorError(
            "This create identity already committed different content. Canonical boards were refreshed; review them or start a fresh create request.",
          );
          setIncludeArchived(true);
          await loadBoards(undefined, true);
        }
      } else {
        setEditorError(errorMessage(error, "The board could not be saved."));
      }
    } finally {
      if (isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) {
        mutationBusyRef.current = false;
        setEditorBusy(false);
      }
    }
    return false;
  };

  const refreshEditConflict = async (boardId: string, workspaceId: string, mutationRequestId: number) => {
    try {
      const canonical = await fetchOpsSavedBoard(workspaceId, boardId);
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, mutationRequestId))
        return;
      detailRequestRef.current += 1;
      setSelectedBoard(canonical);
      setBoardGeneration((generation) => generation + 1);
      setEditorConflict(canonical);
      setEditorError("The board changed before this save. Canonical truth was reloaded and your draft was preserved.");
    } catch (error) {
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, mutationRequestId))
        return;
      setEditorError(errorMessage(error, "The board changed and canonical truth could not be reloaded."));
    }
  };

  const requestTransition = (operation: Exclude<PendingTransition, null>) => {
    setPendingTransition(operation);
    setTransitionError(null);
  };

  const performTransition = async () => {
    const operation = pendingTransition;
    const board = selectedBoard;
    if (!operation || !board || mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    const workspaceId = props.activeWorkspaceId;
    const requestId = mutationRequestRef.current + 1;
    mutationRequestRef.current = requestId;
    setTransitionBusy(true);
    setTransitionError(null);
    try {
      const transitioned =
        operation === "archive"
          ? await archiveOpsSavedBoard(board.boardId, { workspaceId, expectedRevision: board.revision })
          : await restoreOpsSavedBoard(board.boardId, { workspaceId, expectedRevision: board.revision });
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return;
      setPendingTransition(null);
      if (operation === "archive") setIncludeArchived(true);
      await loadBoards(transitioned.boardId, operation === "archive" ? true : undefined);
    } catch (error) {
      if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return;
      if (errorStatus(error) === 409) {
        try {
          const canonical = await fetchOpsSavedBoard(workspaceId, board.boardId);
          if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return;
          detailRequestRef.current += 1;
          setSelectedBoard(canonical);
          setBoardGeneration((generation) => generation + 1);
          setTransitionError(
            "The board changed before this transition. Canonical truth was reloaded; review it and retry explicitly.",
          );
        } catch (refreshError) {
          if (!isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) return;
          setTransitionError(errorMessage(refreshError, "The board changed and could not be reloaded."));
        }
      } else {
        setTransitionError(errorMessage(error, `The board could not be ${operation}d.`));
      }
    } finally {
      if (isCurrentMutation(mountedRef, activeWorkspaceRef, mutationRequestRef, workspaceId, requestId)) {
        mutationBusyRef.current = false;
        setTransitionBusy(false);
      }
    }
  };

  const stateMatchesWorkspace = stateWorkspaceId === props.activeWorkspaceId;
  const visibleBoards = stateMatchesWorkspace ? boards : null;
  const visibleSelectedBoardId = stateMatchesWorkspace ? selectedBoardId : null;
  const visibleSelectedBoard = stateMatchesWorkspace ? selectedBoard : null;
  const visibleEditor = stateMatchesWorkspace ? editor : null;
  const activeCount = visibleBoards?.filter((board) => board.status === "active").length ?? 0;
  const archivedCount = visibleBoards?.filter((board) => board.status === "archived").length ?? 0;
  const fatalListError = visibleBoards === null && stateMatchesWorkspace ? listError : null;
  const fatalErrorPresentation = fatalListError
    ? presentNativeRouteError(fatalListError, {
        resourceLabel: "Saved boards",
        authenticationDescription:
          "Saved boards require a specific authenticated operator identity so ownership and audit evidence remain trustworthy. Configure operator access, then retry.",
      })
    : null;

  return (
    <NativePageFrame
      icon={PanelsTopLeft}
      area="ops"
      kicker={routeKicker(props.route)}
      title="Saved boards"
      description={`Trusted operational layouts for ${props.activeWorkspaceName}; every widget reloads its canonical source independently.`}
      loading={!stateMatchesWorkspace || (listLoading && visibleBoards === null)}
      error={fatalErrorPresentation}
      onRetry={() => void loadBoards()}
      errorSecondaryAction={
        fatalErrorPresentation?.category === "authentication-required" ? (
          <NativeButton
            variant="outline"
            onClick={() => props.navigate({ area: "settings", section: "access", theme: props.route.theme })}
          >
            <ShieldCheck size={16} /> Configure access
          </NativeButton>
        ) : undefined
      }
      releaseStatus={getRouteReleaseScope(props.route).status}
      metrics={[
        { label: "Visible boards", value: String(visibleBoards?.length ?? 0) },
        { label: "Active", value: String(activeCount) },
        { label: "Archived", value: String(archivedCount) },
      ]}
      actions={
        <div className="mc-next-ops-board-head-actions">
          <NativeButton variant="outline" onClick={() => void loadBoards()} disabled={listLoading || editorBusy}>
            <RefreshCw size={14} /> Refresh
          </NativeButton>
          <NativeButton onClick={beginCreate} disabled={!stateMatchesWorkspace || editorBusy || transitionBusy}>
            <Plus size={14} /> New board
            {hasSessionDraft("ops-board:" + props.activeWorkspaceId + ":create") ? " · Unsaved" : ""}
          </NativeButton>
        </div>
      }
      className="mc-next-ops-saved-boards-page"
    >
      {listError && visibleBoards !== null ? <NoticeBanner tone="error" message={listError} /> : null}
      {!visibleEditor ? (
        <BoardSelector
          boards={visibleBoards ?? []}
          selectedBoardId={visibleSelectedBoardId}
          includeArchived={includeArchived}
          disabled={editorBusy || transitionBusy}
          onSelect={(boardId) => leave.request(() => selectBoard(boardId))}
          onIncludeArchived={(checked) => setIncludeArchived(checked)}
        />
      ) : null}

      {visibleEditor ? (
        <OpsSavedBoardsEditor
          session={visibleEditor}
          busy={editorBusy}
          error={editorError}
          conflict={editorConflict}
          onChange={(session) => {
            setEditor(session);
            if (!editorConflict) setEditorError(null);
          }}
          onSave={() => void saveEditor()}
          onCancel={() =>
            leave.request(() => {
              mutationRequestRef.current++;
              mutationBusyRef.current = false;
              setEditorBusy(false);
              setEditor(null);
              setEditorError(null);
              setEditorConflict(null);
            }, [editorStore.key])
          }
          onAdoptConflictRevision={() => {
            if (!editorConflict) return;
            editorStore.rebaseToCurrent();
            setEditor((current) => (current ? { ...current, expectedRevision: editorConflict.revision } : current));
            setEditorConflict(null);
            setEditorError(null);
          }}
          onDiscardForCanonical={() => {
            if (!editorConflict) return;
            editorStore.discard();
            setEditor({
              mode: "edit",
              boardId: editorConflict.boardId,
              expectedRevision: editorConflict.revision,
              draft: createOpsSavedBoardsDraft(editorConflict),
            });
            setEditorConflict(null);
            setEditorError(null);
          }}
          onUseFreshCreateIdentity={() => {
            setEditor((current) =>
              current?.mode === "create" ? { ...current, idempotencyKey: createRequestIdentity() } : current,
            );
            setEditorError(null);
          }}
        />
      ) : visibleBoards?.length === 0 ? (
        <EmptyState
          icon={<PanelsTopLeft size={24} />}
          title="No saved boards yet"
          description="Create a trusted layout from the five compiled Ops widgets. Runtime data remains owned by each source route."
          primaryAction={<NativeButton onClick={beginCreate}>Create first board</NativeButton>}
          tone="accent"
        />
      ) : (
        <BoardViewer
          board={visibleSelectedBoard}
          boardLoading={!stateMatchesWorkspace || boardLoading}
          boardError={boardError}
          boardGeneration={boardGeneration}
          workspaceId={props.activeWorkspaceId}
          theme={props.route.theme}
          navigate={props.navigate}
          transitionBusy={transitionBusy}
          transitionError={transitionError}
          pendingTransition={pendingTransition}
          onEdit={beginEdit}
          hasDraft={Boolean(
            visibleSelectedBoard &&
            hasSessionDraft("ops-board:" + props.activeWorkspaceId + ":" + visibleSelectedBoard.boardId),
          )}
          onRequestTransition={requestTransition}
          onCancelTransition={() => setPendingTransition(null)}
          onConfirmTransition={() => void performTransition()}
          onRetry={() => visibleSelectedBoardId && void loadBoard(visibleSelectedBoardId)}
        />
      )}
      {leave.dialog}
    </NativePageFrame>
  );
}

function BoardSelector({
  boards,
  selectedBoardId,
  includeArchived,
  disabled,
  onSelect,
  onIncludeArchived,
}: {
  boards: OpsSavedBoardRecord[];
  selectedBoardId: string | null;
  includeArchived: boolean;
  disabled: boolean;
  onSelect: (boardId: string) => void;
  onIncludeArchived: (checked: boolean) => void;
}) {
  return (
    <div className="mc-next-ops-board-selector" role="group" aria-label="Saved board selection">
      <label>
        <span>Saved board</span>
        <select
          aria-label="Saved board"
          value={selectedBoardId ?? ""}
          disabled={disabled || boards.length === 0}
          onChange={(event) => onSelect(event.currentTarget.value)}
        >
          {boards.length === 0 ? <option value="">No boards</option> : null}
          {boards.map((board) => (
            <option key={board.boardId} value={board.boardId}>
              {board.name}
              {board.status === "archived" ? " · archived" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="mc-next-ops-board-archive-toggle">
        <input
          type="checkbox"
          checked={includeArchived}
          disabled={disabled}
          onChange={(event) => onIncludeArchived(event.currentTarget.checked)}
        />
        <span>Include archived</span>
      </label>
    </div>
  );
}

function BoardViewer({
  board,
  boardLoading,
  boardError,
  boardGeneration,
  workspaceId,
  theme,
  navigate,
  transitionBusy,
  transitionError,
  pendingTransition,
  onEdit,
  hasDraft,
  onRequestTransition,
  onCancelTransition,
  onConfirmTransition,
  onRetry,
}: {
  board: OpsSavedBoardRecord | null;
  boardLoading: boolean;
  boardError: string | null;
  boardGeneration: number;
  workspaceId: string;
  theme?: string;
  navigate: NativeRoutePagesProps["navigate"];
  transitionBusy: boolean;
  transitionError: string | null;
  pendingTransition: PendingTransition;
  onEdit: () => void;
  hasDraft: boolean;
  onRequestTransition: (operation: Exclude<PendingTransition, null>) => void;
  onCancelTransition: () => void;
  onConfirmTransition: () => void;
  onRetry: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [inspectedWidgetId, setInspectedWidgetId] = useState<string | null>(null);
  useEffect(() => {
    setDetailsOpen(false);
    setInspectedWidgetId(null);
  }, [board?.boardId]);
  if (boardLoading && !board) {
    return (
      <p className="mc-next-ops-board-loading" role="status">
        Loading selected board…
      </p>
    );
  }
  if (boardError || !board) {
    return (
      <div className="mc-next-ops-board-load-error">
        <NoticeBanner tone="error" message={boardError ?? "No canonical board record is selected."} />
        <NativeButton variant="outline" onClick={onRetry}>
          Retry board
        </NativeButton>
      </div>
    );
  }
  const operation = pendingTransition;
  return (
    <section className="mc-next-ops-board-view" aria-labelledby="ops-saved-board-title">
      <header className="mc-next-ops-board-view-header">
        <div>
          <div className="mc-next-ops-board-title-row">
            <h2 id="ops-saved-board-title">{board.name}</h2>
            <StatusChip tone={board.status === "active" ? "success" : "muted"}>{board.status}</StatusChip>
            <NativeButton
              variant="ghost"
              onClick={() => {
                setInspectedWidgetId(null);
                setDetailsOpen(true);
              }}
            >
              Board details
            </NativeButton>
          </div>
          {board.description ? <p>{board.description}</p> : null}
          <span>Updated {formatDateTime(board.updatedAt)} · layout only, never runtime authority</span>
        </div>
        <div className="mc-next-ops-board-inline-actions">
          {board.status === "active" ? (
            <>
              <NativeButton variant="outline" onClick={onEdit} disabled={transitionBusy}>
                <Pencil size={14} /> Edit layout{hasDraft ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton variant="ghost" onClick={() => onRequestTransition("archive")} disabled={transitionBusy}>
                <Archive size={14} /> Archive
              </NativeButton>
            </>
          ) : (
            <NativeButton variant="outline" onClick={() => onRequestTransition("restore")} disabled={transitionBusy}>
              <RotateCcw size={14} /> Restore
            </NativeButton>
          )}
        </div>
      </header>

      <DetailInspector
        open={detailsOpen || Boolean(operation)}
        title="Board details"
        onClose={() => {
          if (!transitionBusy) {
            setDetailsOpen(false);
            onCancelTransition();
          }
        }}
      >
        <p>
          revision {board.revision} · {board.status}
        </p>
        <p>{board.description}</p>
        <p>Updated {formatDateTime(board.updatedAt)} · layout only, never runtime authority</p>
        <dl className="mc-next-worker-record">
          {Object.entries(board)
            .filter(([key]) => key !== "placements")
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
                <dd>{String(value ?? "Unavailable")}</dd>
              </div>
            ))}
        </dl>{" "}
        {transitionError ? <NoticeBanner tone="warning" message={transitionError} /> : null}
        {operation ? (
          <div className="mc-next-ops-board-transition-confirm" role="alertdialog" aria-modal="false">
            <div>
              <strong>{operation === "archive" ? "Archive this board?" : "Restore this board?"}</strong>
              <p>This changes only the saved layout record at revision {board.revision}; source data is untouched.</p>
            </div>
            <div className="mc-next-ops-board-inline-actions">
              <NativeButton variant="outline" onClick={onCancelTransition} disabled={transitionBusy}>
                Cancel
              </NativeButton>
              <NativeButton
                variant={operation === "archive" ? "destructive" : "default"}
                onClick={onConfirmTransition}
                disabled={transitionBusy}
              >
                {transitionBusy ? "Saving…" : operation === "archive" ? "Archive board" : "Restore board"}
              </NativeButton>
            </div>
          </div>
        ) : null}
      </DetailInspector>
      <div className="mc-next-ops-board-grid" aria-label={`${board.name} trusted widget grid`}>
        {board.placements.map((placement) => (
          <div
            key={placement.widgetId}
            className="mc-next-ops-board-grid-cell"
            style={placementGridStyle(placement)}
            data-widget-kind={placement.kind}
          >
            <OpsSavedBoardsWidget
              key={`${workspaceId}:${board.boardId}:${board.revision}:${placement.widgetId}`}
              placement={placement}
              workspaceId={workspaceId}
              boardGeneration={boardGeneration}
              theme={theme}
              navigate={navigate}
              inspected={inspectedWidgetId === placement.widgetId}
              onInspect={() => {
                setDetailsOpen(false);
                setInspectedWidgetId(placement.widgetId);
              }}
              onCloseInspector={() => setInspectedWidgetId(null)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function placementGridStyle(placement: OpsSavedBoardRecord["placements"][number]): CSSProperties {
  return {
    gridColumnStart: placement.x + 1,
    gridColumnEnd: `span ${placement.width}`,
    gridRowStart: placement.y + 1,
    gridRowEnd: `span ${placement.height}`,
  };
}

function isCurrentRequest(
  mountedRef: { current: boolean },
  workspaceRef: { current: string },
  requestRef: { current: number },
  workspaceId: string,
  requestId: number,
): boolean {
  return mountedRef.current && workspaceRef.current === workspaceId && requestRef.current === requestId;
}

function isCurrentMutation(
  mountedRef: { current: boolean },
  workspaceRef: { current: string },
  requestRef: { current: number },
  workspaceId: string,
  requestId: number,
): boolean {
  return isCurrentRequest(mountedRef, workspaceRef, requestRef, workspaceId, requestId);
}

function createRequestIdentity(): string {
  return `ops-board-${globalThis.crypto.randomUUID()}`;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
