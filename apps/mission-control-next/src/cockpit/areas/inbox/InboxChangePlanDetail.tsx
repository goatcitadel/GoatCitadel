import type { ChangePlanRecord, OperatorInboxItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  presentChangePlanStatus,
  presentRiskLevel,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { StatusBadge } from "../../ui/StatusBadge";
import { canConfirmInboxChangePlan } from "./inbox-change-plan-guard";
import { useInboxChangePlan } from "./use-inbox-change-plan";
import { InboxSettingsContinuation } from "./InboxSettingsContinuation";

export function InboxChangePlanDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const { activeWorkspaceId } = useUiPreferences();
  const control = useInboxChangePlan(item, workspaceId, activeWorkspaceId ?? "default");
  const { query, plan, scopeChanged, review, pending, completed, result, error, canConfirm } = control;
  const confirmation = plan?.requiredAction?.kind === "confirmation" ? plan.requiredAction : undefined;
  const reviewedAction = review?.requiredAction?.kind === "confirmation" ? review.requiredAction : undefined;

  return (
    <section aria-label="Current change plan" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current change plan</h3>
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
          This Inbox item has no change-plan ID. Open its owner to review the current record.
        </p>
      ) : null}
      {query.isFetching ? (
        <p role="status" className="text-fg-muted">
          Loading the current change plan…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {!query.isFetching && !query.isError && !plan ? (
        <p className="text-fg-muted">
          This change plan is no longer waiting in the selected workspace. Open its owner to inspect the current status.
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
          <p className="text-xs text-fg-muted">
            Scope: {plan.scope.replaceAll("_", " ")} · Revision {plan.revision}
          </p>
          {confirmation ? (
            <p className="rounded-md border border-line bg-sunken p-3 whitespace-pre-wrap break-words text-fg-secondary">
              {confirmation.confirmationText}
            </p>
          ) : null}
          {plan.expiresAt && !canConfirmInboxChangePlan(plan) && plan.status === "awaiting_confirmation" ? (
            <p className="text-fg-secondary">
              This confirmation has expired. Refresh the owner before taking another action.
            </p>
          ) : null}
          {canConfirm ? (
            <Button
              size="sm"
              variant={plan.risk === "danger" || confirmation?.purpose === "rollback" ? "danger" : "primary"}
              disabled={pending}
              onClick={control.openReview}
            >
              Review {confirmation?.purpose === "rollback" ? "rollback" : "confirmation"}
            </Button>
          ) : null}
          {!confirmation && !completed ? <p className="text-xs text-fg-muted">{actionGuidance(plan)}</p> : null}
          {plan.origin.surface === "settings" && !plan.origin.sessionId && !plan.origin.turnId ? (
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
          <p>Gateway recorded the request. Current returned status: {presentChangePlanStatus(result.status).label}.</p>
          {result.status === "awaiting_approval" ? (
            <p>A separate canonical approval is required before the change can apply.</p>
          ) : null}
          {result.result?.summary ? <p>{result.result.summary}</p> : null}
          <p>Open the owner to inspect the latest outcome and evidence.</p>
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
        description="The Gateway will check this exact plan revision and decide whether it can apply or needs another approval."
      >
        {review && reviewedAction ? (
          <div className="mb-3 space-y-2 text-sm text-fg-secondary">
            <p className="font-medium text-fg">{review.title}</p>
            <p className="whitespace-pre-wrap break-words">{reviewedAction.confirmationText}</p>
            <p className="whitespace-pre-wrap break-words">Impact: {review.impact}</p>
            <p>
              Scope: {review.scope.replaceAll("_", " ")} · Risk: {review.risk} · Revision {review.revision}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={review?.risk === "danger" || reviewedAction?.purpose === "rollback" ? "danger" : "primary"}
            disabled={pending || scopeChanged}
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

function actionGuidance(plan: ChangePlanRecord): string {
  switch (plan.requiredAction?.kind) {
    case "approval":
      return "A separate canonical approval is required. Review it in Approvals; the decision alone does not prove this plan applied.";
    case "public_form":
      return "This plan needs form details in its owning Chat or Settings flow.";
    case "secure_input":
      return "This plan needs protected input in its existing secure owner flow. No secret entry is available in Inbox.";
    case "oauth":
      return "This plan needs its provider-owned OAuth flow.";
    case "native_path_picker":
      return "This plan needs the native desktop path picker.";
    case "artifact_review":
      return "This plan needs a verified artifact review in its owning flow.";
    default:
      return "Review the current owner record for the next action or recovery step.";
  }
}
