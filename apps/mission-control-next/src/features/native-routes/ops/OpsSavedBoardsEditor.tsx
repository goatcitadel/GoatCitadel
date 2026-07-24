import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { OPS_SAVED_BOARD_LIMITS } from "@goatcitadel/contracts";
import { NativeButton, NoticeBanner } from "../primitives";
import {
  OPS_SAVED_BOARDS_WIDGET_OPTIONS,
  addOpsSavedBoardsWidget,
  adjustOpsSavedBoardsPlacement,
  formatOpsSavedBoardsWidgetLabel,
  removeOpsSavedBoardsWidget,
  type OpsSavedBoardsDraft,
  type OpsSavedBoardsPlacementAdjustment,
} from "./OpsSavedBoardsModel";

export interface OpsSavedBoardsEditorSession {
  mode: "create" | "edit";
  boardId?: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  draft: OpsSavedBoardsDraft;
}

export function OpsSavedBoardsEditor({
  session,
  busy,
  error,
  conflict,
  onChange,
  onSave,
  onCancel,
  onAdoptConflictRevision,
  onDiscardForCanonical,
  onUseFreshCreateIdentity,
}: {
  session: OpsSavedBoardsEditorSession;
  busy: boolean;
  error: string | null;
  conflict: OpsSavedBoardRecord | null;
  onChange: (session: OpsSavedBoardsEditorSession) => void;
  onSave: () => void;
  onCancel: () => void;
  onAdoptConflictRevision: () => void;
  onDiscardForCanonical: () => void;
  onUseFreshCreateIdentity: () => void;
}) {
  const updateDraft = (draft: OpsSavedBoardsDraft) => onChange({ ...session, draft });
  const atWidgetLimit = session.draft.placements.length >= OPS_SAVED_BOARD_LIMITS.placementsPerBoard;

  return (
    <section className="mc-next-ops-board-editor" aria-labelledby="ops-saved-board-editor-title">
      <header className="mc-next-ops-board-editor-header">
        <div>
          <span>{session.mode === "create" ? "New trusted layout" : `Revision ${session.expectedRevision}`}</span>
          <h2 id="ops-saved-board-editor-title">{session.mode === "create" ? "Create board" : "Edit board"}</h2>
          <p>Only compiled built-in widgets and bounded grid controls can be saved here.</p>
        </div>
      </header>

      {error ? <NoticeBanner tone={conflict ? "warning" : "error"} message={error} /> : null}
      {conflict ? (
        <div className="mc-next-ops-board-conflict" role="alert">
          <div>
            <strong>Canonical revision {conflict.revision} is now current.</strong>
            <p>
              Your draft is preserved. Adopting the new revision does not submit it; review and save again explicitly.
            </p>
          </div>
          <div className="mc-next-ops-board-inline-actions">
            <NativeButton variant="outline" onClick={onAdoptConflictRevision} disabled={busy}>
              Use revision {conflict.revision}
            </NativeButton>
            <NativeButton variant="ghost" onClick={onDiscardForCanonical} disabled={busy}>
              Discard draft
            </NativeButton>
          </div>
        </div>
      ) : session.mode === "create" && error ? (
        <div className="mc-next-ops-board-inline-actions">
          <NativeButton variant="outline" onClick={onUseFreshCreateIdentity} disabled={busy}>
            Start a fresh create request
          </NativeButton>
        </div>
      ) : null}

      <div className="mc-next-ops-board-editor-fields">
        <label>
          <span>Board name</span>
          <input
            value={session.draft.name}
            maxLength={OPS_SAVED_BOARD_LIMITS.nameCharacters}
            autoComplete="off"
            onChange={(event) => updateDraft({ ...session.draft, name: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>Description</span>
          <textarea
            value={session.draft.description}
            maxLength={OPS_SAVED_BOARD_LIMITS.descriptionCharacters}
            rows={3}
            onChange={(event) => updateDraft({ ...session.draft, description: event.currentTarget.value })}
          />
        </label>
      </div>

      <section className="mc-next-ops-board-catalog" aria-labelledby="ops-saved-board-catalog-title">
        <div className="mc-next-ops-board-section-heading">
          <div>
            <span>Compiled registry</span>
            <h3 id="ops-saved-board-catalog-title">Add a widget</h3>
          </div>
          <small>{session.draft.placements.length}/12 placed</small>
        </div>
        <div className="mc-next-ops-board-catalog-grid">
          {OPS_SAVED_BOARDS_WIDGET_OPTIONS.map((option) => (
            <article key={option.kind}>
              <div>
                <strong>{option.label}</strong>
                <p>{option.description}</p>
              </div>
              <NativeButton
                variant="outline"
                disabled={atWidgetLimit || busy}
                onClick={() => updateDraft(addOpsSavedBoardsWidget(session.draft, option.kind))}
              >
                Add {option.label}
              </NativeButton>
            </article>
          ))}
        </div>
      </section>

      <section className="mc-next-ops-board-placement-editor" aria-labelledby="ops-saved-board-layout-title">
        <div className="mc-next-ops-board-section-heading">
          <div>
            <span>12-column bounded grid</span>
            <h3 id="ops-saved-board-layout-title">Move and resize</h3>
          </div>
          <small>Every board keeps at least one widget.</small>
        </div>
        <ol>
          {session.draft.placements.map((placement) => (
            <li key={placement.widgetId}>
              <div className="mc-next-ops-board-placement-copy">
                <strong>{formatOpsSavedBoardsWidgetLabel(placement.kind)}</strong>
                <span>
                  Column {placement.x + 1} · Row {placement.y + 1} · {placement.width} × {placement.height}
                </span>
              </div>
              <PlacementControls
                disabled={busy}
                onAdjust={(adjustment) =>
                  updateDraft(adjustOpsSavedBoardsPlacement(session.draft, placement.widgetId, adjustment))
                }
              />
              <NativeButton
                variant="ghost"
                disabled={busy || session.draft.placements.length <= 1}
                onClick={() => updateDraft(removeOpsSavedBoardsWidget(session.draft, placement.widgetId))}
              >
                Remove
              </NativeButton>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mc-next-ops-board-editor-actions">
        <NativeButton variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </NativeButton>
        <NativeButton onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : session.mode === "create" ? "Create board" : "Save changes"}
        </NativeButton>
      </footer>
    </section>
  );
}

function PlacementControls({
  disabled,
  onAdjust,
}: {
  disabled: boolean;
  onAdjust: (adjustment: OpsSavedBoardsPlacementAdjustment) => void;
}) {
  const actions: Array<{ adjustment: OpsSavedBoardsPlacementAdjustment; label: string }> = [
    { adjustment: "left", label: "Move left" },
    { adjustment: "right", label: "Move right" },
    { adjustment: "up", label: "Move up" },
    { adjustment: "down", label: "Move down" },
    { adjustment: "narrower", label: "Make narrower" },
    { adjustment: "wider", label: "Make wider" },
    { adjustment: "shorter", label: "Make shorter" },
    { adjustment: "taller", label: "Make taller" },
  ];
  return (
    <div className="mc-next-ops-board-placement-controls" aria-label="Placement controls">
      {actions.map((action) => (
        <NativeButton
          key={action.adjustment}
          variant="secondary"
          disabled={disabled}
          onClick={() => onAdjust(action.adjustment)}
        >
          {action.label}
        </NativeButton>
      ))}
    </div>
  );
}
