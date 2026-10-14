import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import {
  continuationAction,
  planSnapshot,
} from "../../../features/native-routes/settings/settings-approval-continuation-binding";
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
  const route = useCockpitRoute();
  const control = useSettingsApprovalContinuation({ plan, workspaceId, onSettled });
  const action = continuationAction(plan, workspaceId);
  const parameters = new URLSearchParams(route.search);
  if (action) parameters.set("workspaceId", plan.origin.workspaceId);
  parameters.delete("approvalId");
  parameters.delete("shell");
  parameters.delete("shellScope");
  if (!control.visible) return null;
  return (
    <section aria-label="Continue Settings change" className="space-y-2 rounded-md border border-line bg-sunken p-3">
      <p>
        Review the separate approval first, then explicitly continue this exact Settings change. A recorded continuation
        does not prove the settings were saved.
      </p>
      {action ? (
        <NativeOwnerLink
          className="block text-accent hover:underline"
          href={`/inbox/approvals/${encodeURIComponent(action.approvalId)}?${parameters}${route.hash}`}
          scope={JSON.stringify([workspaceId, planSnapshot(plan), action.approvalId])}
        >
          Review required approval
        </NativeOwnerLink>
      ) : null}
      <Button size="sm" disabled={control.disabled} onClick={() => void control.continueApproved()}>
        Continue approved change
      </Button>
      {control.message ? <p role="status">{control.message}</p> : null}
    </section>
  );
}
