import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { approvePlanInPlace } from "./channel-setup/approve-plan-in-place";

/** Settings changes are planned in the installation workspace. */
const SETTINGS_WORKSPACE = "default";
const NEEDS_SETTINGS =
  "Turning on Code Mode needs an approval in Settings or Inbox. Finish it there, then run the code.";

/**
 * Turns Code Mode and its sandbox on through the same governed Settings change, and settles that change's own
 * approval in the same click. Throws a plain-words error when the change cannot finish here, so nothing else is approved.
 */
export async function enableCodeMode(): Promise<void> {
  const current = await fetchSettings();
  const response = await patchSettings({
    expectedRevision: current.revision,
    features: { codeModeV1Enabled: true, codeModeHostSandboxEnabled: true },
  });
  const receipt = response.changePlanReceipt;
  if (!receipt || receipt.status === "completed" || receipt.status === "applied") return;
  const outcome = await approvePlanInPlace(receipt.planId, SETTINGS_WORKSPACE);
  if (outcome.kind === "completed") return;
  throw new Error(outcome.kind === "failed" ? outcome.message : NEEDS_SETTINGS);
}
