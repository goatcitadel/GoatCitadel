import { useEffect, useState, type CSSProperties } from "react";
import { Archive, Pencil, RotateCcw } from "lucide-react";
import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { DetailInspector } from "../../../components/DetailInspector";
import { NativeButton, NoticeBanner, StatusChip } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import { OpsSavedBoardsWidget } from "./OpsSavedBoardsWidgets";
type PendingTransition = "archive" | "restore" | null;
export function BoardViewer({
  board,
  boardLoading,
  boardError,
  boardGeneration,
  workspaceId,
  theme,
  navigate,
  transitionBusy,
  transitionLocked,
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
  transitionLocked: boolean;
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
              <NativeButton variant="outline" onClick={onEdit} disabled={transitionBusy || transitionLocked}>
                <Pencil size={14} /> Edit layout{hasDraft ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton
                variant="ghost"
                onClick={() => onRequestTransition("archive")}
                disabled={transitionBusy || transitionLocked}
              >
                <Archive size={14} /> Archive
              </NativeButton>
            </>
          ) : (
            <NativeButton
              variant="outline"
              onClick={() => onRequestTransition("restore")}
              disabled={transitionBusy || transitionLocked}
            >
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
                disabled={transitionBusy || transitionLocked}
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

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
