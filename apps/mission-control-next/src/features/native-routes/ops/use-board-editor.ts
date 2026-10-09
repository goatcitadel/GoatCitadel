import { useState } from "react";
import {
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardRecord,
} from "@goatcitadel/contracts";
import { useSessionDraft } from "../library/session-drafts";
import { createOpsSavedBoardsDraft, type OpsSavedBoardsDraft } from "./OpsSavedBoardsModel";
import type { OpsSavedBoardsEditorSession } from "./OpsSavedBoardsEditor";
import { BoardReviewConflict, commitReviewedBoard, type ReviewedBoardMutation } from "./board-mutation";
import { useBoardMutationState } from "./board-mutation-state";
import { useBoardMutationView } from "./use-board-mutation-view";
export function useBoardEditor(
  workspaceId: string,
  board: OpsSavedBoardRecord | undefined,
  onSaved: (saved: OpsSavedBoardRecord, isCurrent: () => boolean) => Promise<void>,
) {
  const [base, setBase] = useState(board),
    [idempotencyKey] = useState(() => `ops-board-${crypto.randomUUID()}`);
  // A newer canonical revision of the edited board, from the owner query or from the owner's pre-save read.
  const [foundNewer, setFoundNewer] = useState<OpsSavedBoardRecord>();
  const [createIdentityTaken, setCreateIdentityTaken] = useState(false);
  const newer = [foundNewer, board]
    .filter((record): record is OpsSavedBoardRecord =>
      Boolean(
        base &&
        record &&
        record.boardId === base.boardId &&
        record.workspaceId === base.workspaceId &&
        record.revision > base.revision,
      ),
    )
    .sort((left, right) => right.revision - left.revision)[0];
  const canonical: OpsSavedBoardsEditorSession = {
    mode: base ? "edit" : "create",
    ...(base ? { boardId: base.boardId, expectedRevision: base.revision } : { idempotencyKey }),
    draft: createOpsSavedBoardsDraft(base),
  };
  const store = useSessionDraft(`ops-board:${workspaceId}:${base?.boardId ?? "create"}`, canonical, base?.revision, {
    label: "Board layout",
  });
  // A retained draft reopened against a board that moved on is just as stale as one overtaken while open.
  const retainedBehind =
    base &&
    store.isDirty &&
    typeof store.value.expectedRevision === "number" &&
    store.value.expectedRevision < base.revision
      ? base
      : undefined;
  const conflict = newer ?? retainedBehind;
  const view = useBoardMutationView([workspaceId, board]),
    attempt = useBoardMutationState(workspaceId, base?.boardId);
  const [review, setReview] = useState<ReviewedBoardMutation | null>(null),
    [message, setMessage] = useState<string | null>(null);
  const locked = attempt.phase !== "idle";
  function setDraft(draft: OpsSavedBoardsDraft) {
    view.invalidate();
    setReview(null);
    store.setValue({ ...store.value, draft });
  }
  function requestReview() {
    if (locked) return;
    const draft = store.value.draft;
    try {
      const common = { workspaceId, name: draft.name, placements: draft.placements };
      if (base) {
        if (board?.workspaceId !== workspaceId || store.value.expectedRevision !== base.revision)
          throw new Error("The retained board revision changed. Reopen the current layout before reviewing.");
        setReview({
          kind: "update",
          before: structuredClone(base),
          input: normalizeOpsSavedBoardUpdateInput({
            ...common,
            expectedRevision: base.revision,
            description: draft.description.trim() || null,
          }),
        });
      } else
        setReview({
          kind: "create",
          input: normalizeOpsSavedBoardCreateInput({
            ...common,
            idempotencyKey: store.value.idempotencyKey ?? idempotencyKey,
            ...(draft.description.trim() ? { description: draft.description } : {}),
          }),
        });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review the board name and widget layout before saving.");
    }
  }
  async function save() {
    if (!review || locked) return;
    const current = view.capture(),
      submitted = store.value;
    try {
      const saved = await commitReviewedBoard(review, current, (record) => {
        const clean = store.acceptSaved(
          { ...submitted, expectedRevision: record.revision, draft: createOpsSavedBoardsDraft(record) },
          record.revision,
          submitted,
        );
        if (clean) store.discard();
      });
      if (!saved || !current()) return;
      setReview(null);
      setMessage("Board saved and confirmed.");
      try {
        await onSaved(saved, current);
      } catch {
        if (current()) setMessage("Board saved and confirmed. The view could not refresh; reopen the saved board.");
      }
    } catch (error) {
      if (current()) {
        setReview(null);
        setMessage(error instanceof Error ? error.message : "The board could not be saved.");
        if (error instanceof BoardReviewConflict) {
          if (base && error.current) setFoundNewer(error.current);
          else if (!base) setCreateIdentityTaken(true);
        }
      }
    }
  }
  /** Keeps the draft and re-targets it at the newer revision; nothing is saved until a new review is confirmed. */
  function adoptCurrent() {
    if (!conflict || locked) return;
    // Without edits there is nothing to keep: re-targeting would resave stale content over the newer revision.
    if (!store.isDirty) return discardForCurrent();
    view.invalidate();
    setReview(null);
    setBase(conflict);
    setFoundNewer(undefined);
    store.setValue({ ...store.value, boardId: conflict.boardId, expectedRevision: conflict.revision });
    setMessage(null);
  }
  /** Drops the draft and continues from the newer canonical revision. */
  function discardForCurrent() {
    if (!conflict || locked) return;
    view.invalidate();
    setReview(null);
    setBase(conflict);
    setFoundNewer(undefined);
    store.discard();
    setMessage(null);
  }
  /** A new create identity is a separate board; only offered after the reviewed identity was found to exist. */
  function freshCreateIdentity() {
    if (base || !createIdentityTaken || locked) return;
    view.invalidate();
    setReview(null);
    store.setValue({ ...store.value, idempotencyKey: `ops-board-${crypto.randomUUID()}` });
    setCreateIdentityTaken(false);
    setMessage(null);
  }
  return {
    base,
    conflict,
    hasEdits: store.isDirty,
    adoptCurrent,
    discardForCurrent,
    createIdentityTaken,
    freshCreateIdentity,
    createIdentity: store.value.idempotencyKey ?? idempotencyKey,
    draft: store.value.draft,
    setDraft,
    store,
    attempt,
    locked,
    reviewing: Boolean(review),
    requestReview,
    save,
    message,
    cancelReview: () => {
      view.invalidate();
      setReview(null);
    },
    invalidate: view.invalidate,
  };
}
