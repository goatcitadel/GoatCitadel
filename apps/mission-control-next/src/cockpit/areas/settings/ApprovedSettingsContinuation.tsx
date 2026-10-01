import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { useSettingsApprovalContinuation } from "../../../features/native-routes/settings/use-settings-approval-continuation";
import { Button } from "../../ui/Button";

export function ApprovedSettingsContinuation(props: { plan?: ChangePlanRecord; onSettled: () => Promise<unknown> }) {
  const continuation = useSettingsApprovalContinuation(props);
  if (!continuation.visible) return null;
  return (
    <div className="mt-2 space-y-2">
      <Button size="sm" disabled={continuation.disabled} onClick={() => void continuation.continueApproved()}>
        Continue approved change
      </Button>
      {continuation.message ? (
        <p role="status" className="text-sm text-fg-secondary">
          {continuation.message}
        </p>
      ) : null}
    </div>
  );
}
