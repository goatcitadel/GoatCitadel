import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  usePackPlanAction,
  PACK_ACTION_LABELS,
} from "../../../features/native-routes/settings/sections/use-pack-plan-action";
import {
  packActionDescription,
  packInboxUrl,
} from "../../../features/native-routes/settings/sections/pack-plan-presentation";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function PackPlanControls({
  plan,
  workspaceId,
  onUpdated,
  onInspect,
}: {
  plan: ChangePlanRecord;
  workspaceId: string;
  onUpdated: () => void;
  onInspect: (url: string) => void;
}) {
  const owner = usePackPlanAction(plan, workspaceId, onUpdated);
  const required = plan.requiredAction;
  return (
    <article className="space-y-3 rounded-md border border-line p-3">
      <header>
        <h5 className="text-sm font-semibold text-fg">{plan.title.slice(0, 240)}</h5>
        <p className="text-xs text-fg-muted">
          {plan.status.replaceAll("_", " ")} · revision {plan.revision}
        </p>
      </header>
      <p className="break-words text-sm text-fg-secondary">{plan.summary.slice(0, 3000)}</p>
      <p className="break-words text-sm text-fg-secondary">{plan.impact.slice(0, 3000)}</p>
      {plan.result ? (
        <p className="break-words text-sm text-fg-secondary">{plan.result.summary.slice(0, 3000)}</p>
      ) : null}
      <code className="block break-all font-mono text-xs text-fg-muted">{plan.planId}</code>
      <div className="flex flex-wrap gap-2">
        {owner.actions.map((action) => (
          <Button key={action} disabled={owner.attempt.phase !== "idle"} onClick={() => owner.request(action)}>
            {PACK_ACTION_LABELS[action]}
          </Button>
        ))}
        {required?.kind === "approval" && required.approvalId && plan.approvalRefs.includes(required.approvalId) ? (
          <Button onClick={() => onInspect(packInboxUrl(`approval:${required.approvalId}`, workspaceId))}>
            Inspect required approval
          </Button>
        ) : null}
      </div>
      {owner.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {owner.notice}
        </p>
      ) : null}
      {owner.attempt.message ? (
        <p role="alert" className="text-sm text-status-waiting">
          {owner.attempt.message}
        </p>
      ) : null}
      <Dialog
        open={Boolean(owner.review)}
        title={owner.review ? PACK_ACTION_LABELS[owner.review.action] : "Review setup action"}
        description={owner.review ? packActionDescription(owner.review.plan, owner.review.action) : undefined}
        onOpenChange={(open) => {
          if (!open) owner.cancel();
        }}
      >
        {owner.review ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">
              {owner.review.plan.title.slice(0, 240)} · revision {owner.review.plan.revision}
            </p>
            <p className="break-words text-sm text-fg-secondary">{owner.review.plan.impact.slice(0, 3000)}</p>
            {owner.review.plan.requiredAction?.kind === "confirmation" ? (
              <p className="text-sm text-fg-secondary">
                {owner.review.plan.requiredAction.confirmationText.slice(0, 3000)}
              </p>
            ) : null}
            <p className="text-xs text-fg-muted">
              The exact plan is read again before submitting its revision and action nonce. A changed action is
              withheld.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={owner.attempt.phase !== "idle"} onClick={() => void owner.confirm()}>
                Submit reviewed plan action
              </Button>
              <Button onClick={owner.cancel}>Cancel plan review</Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </article>
  );
}
