import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import {
  settingsApprovalOwnerBinding,
  type SettingsApprovalOwner,
  type SettingsApprovalReceipt,
} from "./settings-approval-owner";

export function SettingsApprovalOwnerAction({
  plan,
  owner,
  workspaceId,
  receipt,
  viewIdentity,
  disabled = false,
  label = "Review required approval",
}: {
  plan?: ChangePlanRecord | null;
  owner: SettingsApprovalOwner;
  workspaceId: string;
  receipt?: SettingsApprovalReceipt;
  viewIdentity?: unknown;
  disabled?: boolean;
  label?: string;
}) {
  const route = useCockpitRoute();
  const installation = getGatewayApiBaseUrl();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const binding = settingsApprovalOwnerBinding(plan, owner, workspaceId, receipt, route);
  if (!binding || disabled)
    return (
      <p role="status" className="text-sm text-fg-muted">
        {disabled
          ? "Wait for the current owner action before opening its approval."
          : "Refresh the current change to verify its exact approval."}
      </p>
    );
  return (
    <NativeOwnerLink
      href={binding.href}
      scope={JSON.stringify([installation, activeCitadelId, activeWorkspaceId, viewIdentity, binding.identity])}
      className="inline-flex min-h-10 items-center rounded-md border border-line bg-raised px-3 py-2 text-sm font-medium text-accent hover:underline"
    >
      {label}
    </NativeOwnerLink>
  );
}
