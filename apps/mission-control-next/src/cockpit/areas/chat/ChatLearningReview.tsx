import { useId, useState } from "react";
import type { TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
export interface ChatLearningReviewProps {
  candidate: TraceMemoryCandidateRecord;
  pending?: boolean;
  readOnly?: boolean;
  onDecision: (candidate: TraceMemoryCandidateRecord, action: "promote" | "reject") => void | Promise<void>;
  onEdit?: (candidate: TraceMemoryCandidateRecord, content: string) => void | Promise<void>;
}
export function ChatLearningReview({ candidate, pending, readOnly, onDecision, onEdit }: ChatLearningReviewProps) {
  const id = useId(),
    [edit, setEdit] = useState<{ hash: string; content: string }>();
  const stale = edit && edit.hash !== candidate.reviewHash,
    eligible = candidate.status === "proposed" && Boolean(candidate.reviewHash) && !pending && !readOnly;
  return (
    <section aria-label="Proposed lesson" className="min-w-0 space-y-2 rounded-lg border border-line-subtle p-3">
      <p className="text-xs font-medium text-fg-muted">
        {candidate.status === "proposed"
          ? "Proposed lesson · awaiting your review"
          : candidate.status === "rejected"
            ? "Lesson rejected"
            : "Lesson review recorded"}
      </p>
      <p className="whitespace-pre-wrap break-words text-fg">{candidate.proposedInsight}</p>
      <details>
        <summary className="cursor-pointer">Source and scope</summary>
        <p className="whitespace-pre-wrap break-words">{candidate.sourceText}</p>
        <p>Workspace: {candidate.workspaceId}</p>
        <p>Source references: {candidate.sourceRefs.length}</p>
      </details>
      {candidate.status === "proposed" ? (
        <>
          {candidate.promotionEligibility?.reason ? <p role="status">{candidate.promotionEligibility.reason}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!eligible || Boolean(edit) || candidate.promotionEligibility?.allowed === false}
              data-learning-save
              onClick={() => void onDecision(candidate, "promote")}
            >
              Save to memory
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!eligible}
              onClick={() => void onDecision(candidate, "reject")}
            >
              Reject
            </Button>
            {onEdit ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!eligible || !candidate.editEligibility?.allowed}
                onClick={() => setEdit({ hash: candidate.reviewHash!, content: candidate.proposedInsight })}
              >
                Edit lesson
              </Button>
            ) : null}
          </div>
          {!candidate.reviewHash ? <p>Refresh the exact proposal before deciding.</p> : null}
          {onEdit && candidate.editEligibility?.reason ? (
            <p className="text-xs">{candidate.editEligibility.reason}</p>
          ) : null}
          {edit ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (eligible && !stale && edit.content.trim())
                  void Promise.resolve(onEdit?.(candidate, edit.content.trim()))
                    .then(() => setEdit(undefined))
                    .catch(() => {
                      // Keep the current draft if saving it fails.
                    });
              }}
            >
              <label htmlFor={id}>Reviewed lesson</label>
              <textarea
                id={id}
                className="w-full rounded border border-line bg-input p-2 text-fg"
                rows={4}
                maxLength={1000}
                value={edit.content}
                onChange={(event) => setEdit({ ...edit, content: event.currentTarget.value })}
              />
              {stale ? (
                <p role="alert">
                  The proposal changed while you were editing. Your draft is kept; copy it before reviewing the latest
                  version.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit" disabled={!eligible || Boolean(stale) || !edit.content.trim()}>
                  Update proposal
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setEdit(undefined)}
                >
                  Keep original
                </Button>
              </div>
              <p className="text-xs">Updating keeps this lesson inactive. Review its new wording before saving it.</p>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
