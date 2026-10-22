import type { ChangePlanRecord, OperatorInboxItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  presentChangePlanStatus,
  presentRiskLevel,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordAnswered } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { canConfirmInboxChangePlan } from "./inbox-change-plan-guard";
import { useInboxChangePlan } from "./use-inbox-change-plan";
import { InboxSettingsContinuation } from "./InboxSettingsContinuation";
import { presentChangePlanScope } from "./inbox-vocabulary";

export function InboxChangePlanDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const { activeWorkspaceId } = useUiPreferences();
  const control = useInboxChangePlan(item, workspaceId, activeWorkspaceId ?? "default");
  const { query, view, checking, plan, scopeChanged, review, pending, completed, result, error, canConfirm } = control;
  const lastVersion = lastVersionNote(view);
  const confirmation = plan?.requiredAction?.kind === "confirmation" ? plan.requiredAction : undefined;
  const reviewedAction = review?.requiredAction?.kind === "confirmation" ? review.requiredAction : undefined;

  return (
    <section aria-label="Current change plan" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">Current change plan</h3>
        <Button
          size="sm"
          disabled={query.isFetching || pending || !item.source.planId}
          onClick={() => void control.refresh()}
        >
          Refresh
        </Button>
      </div>
      {!item.source.planId ? (
        <p role="alert" className="text-status-failed">
          This Inbox item has no change-plan ID, so it can&apos;t be reviewed here.
        </p>
      ) : null}
      {view.phase === "loading" ? (
        <p role="status" className="text-fg-muted">
          Loading the current change plan…
        </p>
      ) : checking ? (
        <p role="status" className="text-fg-muted">
          {CHECKING_FOR_CHANGES}
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {lastVersion ? <p className="text-fg-muted">{lastVersion}</p> : null}
      {recordAnswered(view) && !plan ? (
        <p className="text-fg-muted">
          This change plan is no longer waiting in the selected workspace. It may have been applied or cancelled.
        </p>
      ) : null}
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {plan ? (
        <>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={presentChangePlanStatus(plan.status)} />
            <StatusBadge status={presentRiskLevel(plan.risk)} />
          </div>
          <p className="font-medium text-fg">{plan.title}</p>
          <p className="whitespace-pre-wrap break-words text-fg-secondary">{plan.summary}</p>
          <p className="whitespace-pre-wrap break-words text-fg-secondary">Impact: {plan.impact}</p>
          <p className="text-xs text-fg-muted">Scope: {presentChangePlanScope(plan.scope)}</p>
          <TechnicalDetails label="Plan identifiers">
            <p className="break-all font-mono text-xs">Revision {plan.revision}</p>
          </TechnicalDetails>
          {confirmation ? (
            <p className="whitespace-pre-wrap break-words text-fg-secondary">{confirmation.confirmationText}</p>
          ) : null}
          {plan.expiresAt && !canConfirmInboxChangePlan(plan) && plan.status === "awaiting_confirmation" ? (
            <p className="text-fg-secondary">This confirmation has expired. Refresh before taking another action.</p>
          ) : null}
          {canConfirm ? (
            <Button
              size="sm"
              variant={plan.risk === "danger" || confirmation?.purpose === "rollback" ? "danger" : "primary"}
              disabled={pending || checking}
              onClick={control.openReview}
            >
              Review {confirmation?.purpose === "rollback" ? "rollback" : "confirmation"}
            </Button>
          ) : null}
          {!confirmation && !completed ? (
            <p className="text-xs text-fg-muted">
              {actionGuidance(plan)} <ApprovalLink plan={plan} workspaceId={workspaceId} />
            </p>
          ) : null}
          {continuesInSettings(plan) ? (
            <InboxSettingsContinuation
              key={control.identity}
              plan={plan}
              workspaceId={workspaceId}
              onSettled={control.refresh}
            />
          ) : null}
        </>
      ) : null}
      {pending ? (
        <p role="status" className="text-fg-muted">
          Checking the current plan and requesting confirmation…
        </p>
      ) : null}
      {result ? (
        <div role="status" className="space-y-1 text-fg-secondary">
          <p>Confirmation recorded. Plan status: {presentChangePlanStatus(result.status).label}.</p>
          {result.status === "awaiting_approval" ? (
            <p>
              It needs a separate approval before the change can apply.{" "}
              <ApprovalLink plan={result} workspaceId={workspaceId} />
            </p>
          ) : null}
          {result.result?.summary ? <p>{result.result.summary}</p> : null}
          <p>Refresh to see the latest outcome.</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !pending) control.cancelReview();
        }}
        title={reviewedAction?.purpose === "rollback" ? "Confirm rollback" : "Confirm change plan"}
        description="This exact plan version is checked again before it applies. It may still need another approval."
      >
        {review && reviewedAction ? (
          <div className="mb-3 space-y-2 text-sm text-fg-secondary">
            <p className="font-medium text-fg">{review.title}</p>
            <p className="whitespace-pre-wrap break-words">{reviewedAction.confirmationText}</p>
            <p className="whitespace-pre-wrap break-words">Impact: {review.impact}</p>
            <p>
              Scope: {presentChangePlanScope(review.scope)} · Risk: {presentRiskLevel(review.risk).label}
            </p>
            <TechnicalDetails label="Plan identifiers">
              <p className="break-all font-mono text-xs">Revision {review.revision}</p>
            </TechnicalDetails>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={review?.risk === "danger" || reviewedAction?.purpose === "rollback" ? "danger" : "primary"}
            disabled={pending || scopeChanged || checking}
            onClick={() => void control.confirm()}
          >
            Confirm {reviewedAction?.purpose === "rollback" ? "rollback" : "change"}
          </Button>
          <Button size="sm" disabled={pending} onClick={control.cancelReview}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

/** A Settings-started plan whose continuation (with its own approval link) renders in this detail. */
function continuesInSettings(plan: ChangePlanRecord): boolean {
  return plan.origin.surface === "settings" && !plan.origin.sessionId && !plan.origin.turnId;
}

/** The plan's separate approval, when the plan names it; the Inbox owns approval decisions. */
function ApprovalLink({ plan, workspaceId }: { plan: ChangePlanRecord; workspaceId: string }) {
  const approvalId = plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined;
  if (!approvalId || continuesInSettings(plan)) return null;
  return (
    <NativeOwnerLink
      href={`/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}`}
      scope={[workspaceId, plan.planId, approvalId]}
      className="font-medium text-accent hover:underline"
    >
      Open approval
    </NativeOwnerLink>
  );
}

function actionGuidance(plan: ChangePlanRecord): string {
  switch (plan.requiredAction?.kind) {
    case "approval":
      return "This plan needs a separate approval. Deciding it alone does not show this plan applied.";
    case "public_form":
      return "This plan needs form details in the Chat or Settings flow that started it.";
    case "secure_input":
      return "This plan needs protected input in the secure flow that started it. Secrets can't be entered in Inbox.";
    case "oauth":
      return "This plan needs the provider's sign-in flow.";
    case "native_path_picker":
      return "This plan needs the native desktop path picker.";
    case "artifact_review":
      return "This plan needs a verified artifact review in the flow that started it.";
    default:
      return "Refresh to see the next step for this plan.";
  }
}
