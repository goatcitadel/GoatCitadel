import type { AssistantReadinessAction, AssistantReadinessResponse } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
const reasons: Record<string, string> = {
  memory_disabled: "Memory is turned off on this installation.",
  memory_administration_disabled: "Reviewed memory is turned off on this installation.",
  session_memory_off: "Memory is turned off for this conversation.",
  reviewed_memory_available: "Reviewed lessons can be recalled in this workspace.",
  skill_drafts_disabled: "Automatic skill drafting is off.",
  drafts_require_evaluation_and_review: "Drafts stay inactive until evaluation and your review.",
  provider_unavailable: "Set up a ready background model to suggest lessons.",
  budget_exhausted: "The background learning budget is used up.",
  budget_reserved: "Budget is held by unsettled background work.",
  usage_unknown: "Usage needs reconciliation before more background inference.",
  autonomy_disabled: "Background work is paused for this installation.",
  commitment_scheduling_disabled: "Follow-ups for accepted commitments are off.",
  accepted_commitments_only: "Only commitments you accept can request follow-up work.",
  explicit_schedule_required: "Work runs only after you create a schedule.",
  owner_unavailable: "The runtime could not read this feature's current state.",
  durable_execution_disabled: "Resumable execution must be enabled before this work can run.",
  pricing_unavailable: "Choose a background model with known pricing.",
  source_ineligible: "This conversation cannot be used as a private learning source.",
  feature_disabled: "This feature is turned off.",
  not_ready: "A required dependency is not ready.",
  readiness_unavailable: "Current learning readiness could not be read.",
  not_checked: "A prerequisite is off; background work has not been checked.",
};
export function ChatAssistantReadiness({
  readiness,
  pending = false,
  error,
  onAction,
  onRefresh,
}: {
  readiness?: AssistantReadinessResponse;
  pending?: boolean;
  error?: string;
  onAction: (action: AssistantReadinessAction) => void | Promise<void>;
  onRefresh: () => void | Promise<unknown>;
}) {
  const learningReasons =
    readiness && !readiness.learning.canExtractMemory
      ? [
          ...new Set(
            [readiness.learning.provider.reasonCode, readiness.learning.budget.reasonCode].filter(
              (reason): reason is string => Boolean(reason),
            ),
          ),
        ]
      : [];
  return (
    <section className="grid min-w-0 gap-3" aria-label="Assistant readiness">
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      {!readiness && !error ? <p>Checking assistant readiness…</p> : null}
      {readiness?.items.map((item) => (
        <div key={item.id} className="grid min-w-0 gap-1 border-b border-line-subtle pb-3">
          <p className="text-sm font-medium text-fg">
            {item.label}{" "}
            <span className="font-normal text-fg-muted">
              ·{" "}
              {item.state === "ready"
                ? "Ready"
                : item.state === "disabled"
                  ? "Off"
                  : item.state === "blocked"
                    ? "Needs attention"
                    : "Unavailable"}
            </span>
          </p>
          {item.reasons.map((reason) => (
            <p key={reason} className="text-sm text-fg-secondary">
              {reasons[reason] ?? "Check this feature's settings for its current requirements."}
            </p>
          ))}
          {item.scope === "installation" && item.nextAction?.kind === "review_change_plan" ? (
            <p className="text-xs text-fg-muted">
              This change applies to the whole installation. Review its scope before approving.
            </p>
          ) : null}
          {item.nextAction ? (
            <Button
              size="sm"
              className="justify-self-start whitespace-normal text-left"
              data-readiness-action={item.id}
              disabled={pending}
              onClick={() => void onAction(item.nextAction!)}
            >
              {item.nextAction.label}
            </Button>
          ) : null}
        </div>
      ))}
      {readiness ? (
        <details className="min-w-0 text-sm text-fg-secondary">
          <summary className="cursor-pointer text-fg">Learning and recall details</summary>
          <div className="mt-2 grid gap-2">
            <p>
              Saving, readiness for recall, and actual use are recorded separately. A proposed lesson is never active
              memory.
            </p>
            {learningReasons.map((reason) => (
              <p key={reason}>{reasons[reason] ?? "Background learning is not ready."}</p>
            ))}
            {readiness.reviewedSkillUse ? (
              <p>
                {readiness.reviewedSkillUse.state === "ready"
                  ? "Reviewed skills can add their approved instructions to matching Chat work."
                  : readiness.reviewedSkillUse.state === "disabled"
                    ? "Approved skills are not being added to Chat while instruction use is off."
                    : readiness.reviewedSkillUse.state === "blocked"
                      ? "Reviewed skill use needs attention. Refresh readiness to inspect its current requirements."
                      : "Current reviewed skill use could not be confirmed. Refresh readiness before changing it."}
              </p>
            ) : null}
            {readiness.reviewedSkillUseSetup ? (
              <>
                <p className="text-xs">
                  Enabling reviewed skill use applies to the whole installation. Existing skill trust and approval
                  controls still apply.
                </p>
                <Button
                  size="sm"
                  data-readiness-action="skill_use"
                  disabled={pending}
                  onClick={() => void onAction(readiness.reviewedSkillUseSetup!)}
                >
                  {readiness.reviewedSkillUseSetup.label}
                </Button>
              </>
            ) : null}
            <p>
              {readiness.indexedRecall.state === "ready"
                ? "Indexed memory search is available within current scope."
                : "Indexed memory search is optional and currently unavailable. Other eligible saved-memory readers keep their current behavior."}
            </p>
            {readiness.indexedRecallSetup ? (
              <>
                <p className="text-xs">Enabling indexed search applies to the whole installation.</p>
                <Button size="sm" disabled={pending} onClick={() => void onAction(readiness.indexedRecallSetup!)}>
                  {readiness.indexedRecallSetup.label}
                </Button>
              </>
            ) : null}
          </div>
        </details>
      ) : null}
      <Button size="sm" variant="secondary" data-readiness-retry disabled={pending} onClick={() => void onRefresh()}>
        Refresh readiness
      </Button>
    </section>
  );
}
