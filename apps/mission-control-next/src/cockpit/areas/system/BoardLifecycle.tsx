import { useEffect, useRef, useState } from "react";
import { Archive, RotateCcw } from "lucide-react";
import type { OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { BoardReviewConflict, commitReviewedBoard } from "../../../features/native-routes/ops/board-mutation";
import { useBoardMutationState } from "../../../features/native-routes/ops/board-mutation-state";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";

type Transition = "archive" | "restore";

const statusOf = (error: unknown) =>
  error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;

/**
 * Reviewed archive/restore of one saved layout record through the governed board owner: the owner re-reads the board
 * before sending, sends one expectedRevision request, checks the exact receipt and confirms it by owner readback.
 */
export function BoardLifecycle({
  board,
  onSettled,
  onConflict,
}: {
  board: OpsSavedBoardRecord;
  onSettled: (saved: OpsSavedBoardRecord, message: string) => void;
  onConflict: (current?: OpsSavedBoardRecord) => void;
}) {
  const mutation = useBoardMutationState(board.workspaceId, board.boardId);
  const [review, setReview] = useState<{ kind: Transition; before: OpsSavedBoardRecord }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    // StrictMode mounts, unmounts and mounts again; the second mount must make the component live again.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const kind: Transition = board.status === "active" ? "archive" : "restore";
  const locked = mutation.phase !== "idle";
  const uncertain = mutation.phase === "uncertain";
  const close = () => {
    if (!busy) setReview(undefined);
  };
  const confirm = async () => {
    if (!review || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await commitReviewedBoard({ kind: review.kind, before: review.before }, () => live.current);
      if (!saved || !live.current) return;
      setReview(undefined);
      onSettled(
        saved,
        `Board ${review.kind === "archive" ? "archived" : "restored"} and confirmed at revision ${saved.revision}.`,
      );
    } catch (failure) {
      if (!live.current) return;
      if (failure instanceof BoardReviewConflict) {
        setError(
          `${failure.message} ${failure.current ? "Its current record is shown behind this review" : "The current board is being reloaded behind this review"}; close it and decide again.`,
        );
        onConflict(failure.current);
      } else if (statusOf(failure) === 409) {
        setError(
          `The Gateway refused the change because this board is no longer at revision ${review.before.revision}. Nothing changed; the current board is being reloaded behind this review.`,
        );
        onConflict(undefined);
      } else setError(describeApiError(failure).summary);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant={kind === "archive" ? "ghost" : "secondary"}
        disabled={busy || locked}
        onClick={() => {
          setError(undefined);
          setReview({ kind, before: structuredClone(board) });
        }}
      >
        {kind === "archive" ? (
          <Archive aria-hidden="true" className="size-4" />
        ) : (
          <RotateCcw aria-hidden="true" className="size-4" />
        )}
        {kind === "archive" ? "Archive board…" : "Restore board…"}
      </Button>
      {uncertain ? <Callout tone="warning">{mutation.message}</Callout> : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={review?.kind === "restore" ? "Review board restore" : "Review board archive"}
        description={`Saved board ${review?.before.name ?? ""} · workspace ${board.workspaceId}.`}
      >
        {review ? (
          <div className="grid min-w-0 grid-cols-1 gap-3 text-sm wrap-anywhere">
            <p>
              <strong>{review.before.name}</strong> · revision {review.before.revision} · {review.before.status} ·{" "}
              {review.before.placements.length} {review.before.placements.length === 1 ? "widget" : "widgets"}
            </p>
            <p>
              {review.kind === "archive"
                ? `Archiving moves this saved layout out of the active list at revision ${review.before.revision}. Widgets and the data they read are untouched, and you can restore it from the archived list.`
                : `Restoring returns this saved layout to the active list at revision ${review.before.revision}. Its widgets and layout are unchanged.`}
            </p>
            <p className="text-fg-secondary">
              The Gateway changes the board only if it is still at this revision when the request arrives.
            </p>
            {uncertain ? (
              <Callout tone="warning">{mutation.message}</Callout>
            ) : error ? (
              <Callout tone="error">{error}</Callout>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={close}>
                {error || uncertain ? "Close" : "Cancel"}
              </Button>
              {error || uncertain ? null : (
                <Button
                  variant={review.kind === "archive" ? "danger" : "primary"}
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "Saving…" : review.kind === "archive" ? "Archive board" : "Restore board"}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
