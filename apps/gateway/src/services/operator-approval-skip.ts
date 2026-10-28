import type { DeploymentProfile } from "@goatcitadel/contracts";

/**
 * Whether the operator's "skip approvals" opt-in (`settingsApprovalSkipEnabled`) applies on this install. It never
 * applies to a `remote_hardened` install, whatever the setting says. The caller reads the setting; this keeps the
 * rule in one place for every caller that resolves an approval on the operator's behalf.
 */
export function allowsOperatorApprovalSkip(deploymentProfile: DeploymentProfile, skipSettingOn: boolean): boolean {
  return deploymentProfile !== "remote_hardened" && skipSettingOn;
}
