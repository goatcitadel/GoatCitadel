import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { useSettingsApprovalContinuation } from "../../../features/native-routes/settings/use-settings-approval-continuation";
import { Button } from "../../ui/Button";

/** Settings uses installation/workspace context. Session-owned plans stay in Chat. */
export function InboxSettingsContinuation({
  plan,
  workspaceId,
  onSettled,
}: {
  plan: ChangePlanRecord;
  workspaceId: string;
  onSettled: () => Promise<unknown>;
}) {
  const control = useSettingsApprovalContinuation({ plan, workspaceId, onSettled });
  if (!control.visible) return null;
  return (
    <section aria-label="Continue Settings change" className="space-y-2 rounded-md border border-line bg-sunken p-3">
      <p>
        Review the separate approval first, then explicitly continue this exact Settings change. A recorded continuation
        does not prove the settings were saved.
      </p>
      {plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId ? (
        <ClassicOwnerLink
          className="block text-accent hover:underline"
          href={`/ops/approvals?shell=classic&approvalId=${encodeURIComponent(plan.requiredAction.approvalId)}`}
          scope={JSON.stringify([workspaceId, plan.planId, plan.requiredAction.approvalId])}
          label="Review required approval"
        />
      ) : null}
      <Button size="sm" disabled={control.disabled} onClick={() => void control.continueApproved()}>
        Continue approved change
      </Button>
      {control.message ? <p role="status">{control.message}</p> : null}
    </section>
  );
}
