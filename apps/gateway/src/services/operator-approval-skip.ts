import type { DeploymentProfile } from "@goatcitadel/contracts";

/**
 * Whether the operator's "skip approvals" opt-in (`settingsApprovalSkipEnabled`) applies on this install. It never
 * applies to a `remote_hardened` install, whatever the setting says, and there the setting is never read, so a failing
 * read can't matter. Every caller that resolves an approval on the operator's behalf decides the skip here.
 */
export async function allowsOperatorApprovalSkip(
  deploymentProfile: DeploymentProfile,
  readSkipSetting: () => Promise<boolean>,
): Promise<boolean> {
  if (deploymentProfile === "remote_hardened") return false;
  return await readSkipSetting();
}
