import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { NativeButton } from "../primitives";
import { useSettingsApprovalContinuation } from "./use-settings-approval-continuation";

export function SettingsApprovalContinuation(props: { plan?: ChangePlanRecord; onSettled: () => Promise<unknown> }) {
  const continuation = useSettingsApprovalContinuation(props);
  if (!continuation.visible) return null;
  return (
    <div className="mc-next-settings-notice">
      <NativeButton disabled={continuation.disabled} onClick={() => void continuation.continueApproved()}>
        Continue approved change
      </NativeButton>
      {continuation.message ? <p role="status">{continuation.message}</p> : null}
    </div>
  );
}
