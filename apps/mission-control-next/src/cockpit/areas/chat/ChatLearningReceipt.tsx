import type { LearningAppliedLink, TurnLearningReceipt } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChatLearningReview, type ChatLearningReviewProps } from "./ChatLearningReview";

const APPLIED_STATES: Record<LearningAppliedLink["state"], string> = {
  saved_not_ready: "Saved. Recall is still pending",
  recall_ready: "Saved and eligible for recall",
  superseded: "Superseded by a newer lesson",
  forgotten: "Forgotten",
  revoked: "Revoked",
  awaiting_apply: "Approved and waiting to be applied",
  unknown: "Current state unavailable",
};

const JOB_STATES: Record<string, string> = {
  pending: "Queued for background review",
  running: "Background review is working",
  deferred: "Background review is deferred",
  delayed: "Background review is waiting",
  awaiting_reconciliation: "Automatic retries are paused until usage or dispatch is checked",
  completed: "Background review finished",
  cancelled: "Background review cancelled",
};

export function ChatLearningReceipt({
  receipt,
  pending,
  readOnly,
  onDecision,
  onEdit,
}: { receipt: TurnLearningReceipt } & Pick<ChatLearningReviewProps, "pending" | "readOnly" | "onDecision" | "onEdit">) {
  return (
    <section aria-label="Turn learning receipt" className="min-w-0 space-y-3 text-sm text-fg-secondary">
      {receipt.proposals.map((proposal) =>
        proposal.kind === "memory" ? (
          <ChatLearningReview
            key={proposal.candidate.candidateId}
            candidate={proposal.candidate}
            pending={pending}
            readOnly={readOnly}
            onDecision={onDecision}
            onEdit={onEdit}
          />
        ) : (
          <div key={proposal.proposalId} className="space-y-2">
            <p>
              Reusable workflow draft ·{" "}
              {proposal.state === "approved"
                ? "Approved version. Check whether this version can be used."
                : "Evaluation and review required"}
            </p>
            <a className="underline" href={proposal.href}>
              Review skill version
            </a>
            <p className="text-xs">You can review this version without activating it.</p>
          </div>
        ),
      )}
      {receipt.applied.length ? (
        <ul className="space-y-2">
          {receipt.applied.map((link) => (
            <li key={`${link.kind}:${link.ref}`}>
              <a className="underline" href={link.href}>
                {APPLIED_STATES[link.state]}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {receipt.usedSources.length ? (
        <details>
          <summary className="cursor-pointer font-medium text-fg">
            Included in this turn · {plural(receipt.usedSources.length, "source")}
          </summary>
          <ul className="space-y-2 py-2">
            {receipt.usedSources.map((link) => (
              <li key={`${link.kind}:${link.ref}:${link.sourceHash}`} className="break-words">
                <a className="underline" href={link.href}>
                  {link.kind === "memory"
                    ? "View memory context"
                    : link.skillVersion
                      ? link.skillVersion.name
                      : link.href === "/capabilities/skills"
                        ? "Browse skills"
                        : "View skill instructions"}
                </a>
                {link.skillVersion ? (
                  <p className="text-xs">
                    Version <code>{link.skillVersion.versionId}</code>
                  </p>
                ) : null}
                <p className="text-xs">Recorded when the model request was sent successfully.</p>
                <TechnicalDetails>
                  <code>{link.ref}</code>
                </TechnicalDetails>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p>The saved turn does not confirm use of any individual memory or skill.</p>
      )}
      {receipt.jobs.map((job) => (
        <div key={job.jobId}>
          <p>{JOB_STATES[job.state] ?? "Background review state unavailable"}</p>
          <a className="underline" href={job.href}>
            {job.reason ? "Inspect what the background review needs" : "Inspect background review"}
          </a>
        </div>
      ))}
      {receipt.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {receipt.truncated ? <p>This receipt shows part of the history.</p> : null}
      {!receipt.proposals.length && !receipt.applied.length && !receipt.jobs.length ? (
        <p>No learning decisions are shown for this turn.</p>
      ) : null}
      <a className="underline" href={`/library/memory?workspaceId=${encodeURIComponent(receipt.workspaceId)}`}>
        Open memory and learning history
      </a>
    </section>
  );
}
