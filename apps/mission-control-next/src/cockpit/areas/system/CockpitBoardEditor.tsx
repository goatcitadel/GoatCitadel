import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { OPS_SAVED_BOARD_LIMITS, type OpsSavedBoardRecord, type OpsSavedBoardWidgetKind } from "@goatcitadel/contracts";
import { useBoardEditor } from "../../../features/native-routes/ops/use-board-editor";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import {
  OPS_SAVED_BOARDS_WIDGET_OPTIONS,
  addOpsSavedBoardsWidget,
  adjustOpsSavedBoardsPlacement,
  formatOpsSavedBoardsWidgetLabel,
  removeOpsSavedBoardsWidget,
  type OpsSavedBoardsPlacementAdjustment,
} from "../../../features/native-routes/ops/OpsSavedBoardsModel";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { SystemDashboardWidget } from "./SystemDashboardWidget";

const ADJUSTMENTS: ReadonlyArray<{ value: OpsSavedBoardsPlacementAdjustment; label: string }> = [
  { value: "left", label: "Move left" },
  { value: "right", label: "Move right" },
  { value: "up", label: "Move up" },
  { value: "down", label: "Move down" },
  { value: "narrower", label: "Make narrower" },
  { value: "wider", label: "Make wider" },
  { value: "shorter", label: "Make shorter" },
  { value: "taller", label: "Make taller" },
];

type BoardEditorProps = {
  workspaceId: string;
  board?: OpsSavedBoardRecord;
  accessAvailable?: boolean;
  onClose: () => void;
  onConfirmed?: (saved: OpsSavedBoardRecord) => void;
  onSaved: (saved: OpsSavedBoardRecord) => void;
};
export function CockpitBoardEditor(props: BoardEditorProps) {
  return <BoardEditorView key={`${props.workspaceId}:${props.board?.boardId ?? "create"}`} {...props} />;
}
function BoardEditorView({ workspaceId, board, accessAvailable = true, onClose, onSaved, onConfirmed }: BoardEditorProps) {
  const client = useQueryClient();
  const owner = useBoardEditor(workspaceId, board, async (saved, isCurrent) => {
    if (isCurrent()) onConfirmed?.(saved);
    await client.invalidateQueries({ queryKey: queryKeys.systemBoards(workspaceId) });
    await client.invalidateQueries({ queryKey: ["surface", "saved-board", workspaceId, saved.boardId] });
    if (isCurrent()) onSaved(saved);
  });
  const { base, draft, setDraft, reviewing, save } = owner;
  const busy = owner.attempt.phase === "pending",
    uncertain = owner.attempt.phase === "uncertain";
  const conflict = owner.conflict;
  const stale = Boolean(conflict);
  // While a newer revision is offered below, its own recovery copy replaces the owner's generic conflict message.
  const message = owner.attempt.message ?? (conflict ? null : owner.message);
  const [preview, setPreview] = useState(false);
  const [widgetKind, setWidgetKind] = useState<OpsSavedBoardWidgetKind>("runtime_truth_summary");
  const [adjustments, setAdjustments] = useState<Record<string, OpsSavedBoardsPlacementAdjustment>>({});
  const setReviewing = (_value: false) => owner.cancelReview();
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessAvailable || stale) return;
    owner.requestReview();
  }
  return (
    <section
      aria-label={base ? "Edit board" : "Create board"}
      className="grid gap-4 rounded-lg border border-line-strong bg-raised p-4"
    >
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">{base ? "Edit board" : "Create board"}</h2>
        <p className="text-sm text-fg-secondary">
          Choose from the five built-in live widgets and arrange them in a bounded grid.
        </p>
      </div>
      {message ? (
        <p
          role={uncertain || stale ? "alert" : "status"}
          className="rounded-md border border-line bg-sunken p-3 text-sm text-fg"
        >
          {message}
        </p>
      ) : null}
      {conflict && !uncertain && !owner.hasEdits ? (
        <div role="alert" className="grid gap-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg">
          <p>
            <strong>Revision {conflict.revision} is now current.</strong> You have no unsaved edits.
          </p>
          <div>
            <Button size="sm" disabled={busy} onClick={owner.discardForCurrent}>
              Load revision {conflict.revision}
            </Button>
          </div>
        </div>
      ) : conflict && !uncertain ? (
        <div role="alert" className="grid gap-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg">
          <p>
            <strong>Revision {conflict.revision} is now current.</strong> Your draft is kept and nothing has been saved.
          </p>
          <p className="text-fg-secondary">
            Keeping your draft lets you review it against revision {conflict.revision}. Saving your draft replaces the
            changes in revision {conflict.revision}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={owner.adoptCurrent}>
              Keep my draft on revision {conflict.revision}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={owner.discardForCurrent}>
              Discard my draft
            </Button>
          </div>
        </div>
      ) : null}
      {owner.createIdentityTaken && !uncertain ? (
        <div className="grid gap-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg">
          <p>
            A saved board already uses this create request. Check your saved boards first: a fresh request creates a
            separate board.
          </p>
          <div>
            <Button size="sm" disabled={busy} onClick={owner.freshCreateIdentity}>
              Start a fresh create request
            </Button>
          </div>
        </div>
      ) : null}
      {!accessAvailable ? <p role="status" className="text-sm text-fg-secondary">Current board access has not been verified. Your draft is retained; saving requires a successful authorized read.</p> : null}
      {uncertain ? (
        <ClassicOwnerLink href="/ops/boards?shell=classic" scope={workspaceId} label="Review boards in the classic view" />
      ) : null}
      <form onSubmit={review} className="grid gap-4">
        <label className="grid gap-1 text-sm text-fg-secondary">
          Board name
          <input
            required
            maxLength={OPS_SAVED_BOARD_LIMITS.nameCharacters}
            disabled={busy || uncertain}
            value={draft.name}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setReviewing(false);
            }}
            className="rounded-md border border-line bg-canvas p-2 text-fg"
          />
        </label>
        <label className="grid gap-1 text-sm text-fg-secondary">
          Description
          <textarea
            maxLength={OPS_SAVED_BOARD_LIMITS.descriptionCharacters}
            rows={2}
            disabled={busy || uncertain}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
              setReviewing(false);
            }}
            className="rounded-md border border-line bg-canvas p-2 text-fg"
          />
        </label>
        <div className="grid gap-2 rounded-md border border-line p-3">
          <h3 className="text-sm font-semibold text-fg">
            Widgets ({draft.placements.length}/{OPS_SAVED_BOARD_LIMITS.placementsPerBoard})
          </h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-0 flex-1 gap-1 text-sm text-fg-secondary">
              Add widget
              <select
                value={widgetKind}
                disabled={busy || uncertain}
                onChange={(event) => setWidgetKind(event.target.value as OpsSavedBoardWidgetKind)}
                className="rounded-md border border-line bg-canvas p-2 text-fg"
              >
                {OPS_SAVED_BOARDS_WIDGET_OPTIONS.map((option) => (
                  <option key={option.kind} value={option.kind}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              disabled={busy || uncertain || draft.placements.length >= OPS_SAVED_BOARD_LIMITS.placementsPerBoard}
              onClick={() => {
                setDraft(addOpsSavedBoardsWidget(draft, widgetKind));
                setReviewing(false);
              }}
            >
              Add
            </Button>
          </div>
          <ol className="grid gap-2">
            {draft.placements.map((placement) => (
              <li
                key={placement.widgetId}
                className="flex flex-wrap items-end gap-2 rounded-md border border-line-subtle bg-sunken p-2"
              >
                <div className="min-w-32 flex-1">
                  <p className="text-sm font-medium text-fg">{formatOpsSavedBoardsWidgetLabel(placement.kind)}</p>
                  <p className="text-xs text-fg-muted">
                    Column {placement.x + 1}, row {placement.y + 1} · {placement.width} × {placement.height}
                  </p>
                </div>
                <label className="grid gap-1 text-xs text-fg-secondary">
                  Adjust
                  <select
                    aria-label={`Adjust ${formatOpsSavedBoardsWidgetLabel(placement.kind)}`}
                    disabled={busy || uncertain}
                    value={adjustments[placement.widgetId] ?? "right"}
                    onChange={(event) =>
                      setAdjustments({
                        ...adjustments,
                        [placement.widgetId]: event.target.value as OpsSavedBoardsPlacementAdjustment,
                      })
                    }
                    className="rounded-md border border-line bg-canvas p-2 text-sm text-fg"
                  >
                    {ADJUSTMENTS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setDraft(
                      adjustOpsSavedBoardsPlacement(
                        draft,
                        placement.widgetId,
                        adjustments[placement.widgetId] ?? "right",
                      ),
                    );
                    setReviewing(false);
                  }}
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || uncertain || draft.placements.length <= 1}
                  onClick={() => {
                    setDraft(removeOpsSavedBoardsWidget(draft, placement.widgetId));
                    setReviewing(false);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPreview(value => !value)} disabled={!accessAvailable} aria-pressed={preview}>Preview live widgets</Button>
          <Button type="submit" variant="primary" disabled={!accessAvailable || busy || uncertain || stale}>
            {base ? "Review changes" : "Review new board"}
          </Button>
          <Button
            onClick={() => {
              owner.invalidate();
              onClose();
            }}
          >
            Close editor
          </Button>
        </div>
      </form>
      {preview ? <section aria-label="Draft live widget preview" className="grid gap-3">
        <p className="text-sm text-fg-secondary">Unsaved layout preview. Values read current Gateway owners; this does not save a board or create a historical snapshot.</p>
        {accessAvailable ? <div className="grid gap-3 sm:grid-cols-2">{draft.placements.map(placement => <SystemDashboardWidget key={placement.widgetId} kind={placement.kind} workspaceId={workspaceId} />)}</div> : <p role="status">Preview unavailable until current board access is verified.</p>}
      </section> : null}
      {reviewing ? (
        <div className="grid gap-2 rounded-md border border-line-strong bg-sunken p-3" data-create-identity={base ? undefined : owner.createIdentity}>
          <p className="text-sm text-fg">
            {base ? "Save changes to" : "Create"} {draft.name.trim()} with {draft.placements.length}{" "}
            {draft.placements.length === 1 ? "widget" : "widgets"}?{" "}
            {base
              ? "The Gateway will check the current version before saving."
              : "The Gateway will validate and save this new layout."}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={!accessAvailable || busy || stale} onClick={() => { if (accessAvailable && !stale) void save(); }}>
              {busy ? "Saving…" : "Confirm save"}
            </Button>
            <Button disabled={busy} onClick={() => setReviewing(false)}>
              Keep editing
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
