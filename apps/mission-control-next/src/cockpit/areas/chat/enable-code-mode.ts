import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { approvePlanInPlace } from "./channel-setup/approve-plan-in-place";

/** Settings changes are planned in the installation workspace. */
const SETTINGS_WORKSPACE = "default";
const NEEDS_SETTINGS =
  "Turning on Code Mode needs an approval in Settings or Inbox. Finish it there, then run the code.";
/** A governed Settings change carries one flag, so Code Mode and its sandbox are turned on one after the other. */
const CODE_MODE_FLAGS = ["codeModeV1Enabled", "codeModeHostSandboxEnabled"] as const;

/**
 * Turns Code Mode and its sandbox on through the governed Settings change, one flag at a time, and settles each
 * change's own approval in the same click. Throws a plain-words error when a change cannot finish here, so nothing
 * else is approved.
 */
export async function enableCodeMode(): Promise<void> {
  for (const flag of CODE_MODE_FLAGS) {
    const current = await fetchSettings();
    if (current.features[flag] === true) continue;
    const response = await patchSettings({ expectedRevision: current.revision, features: { [flag]: true } });
    const receipt = response.changePlanReceipt;
    if (!receipt || receipt.status === "completed" || receipt.status === "applied") continue;
    const outcome = await approvePlanInPlace(receipt.planId, SETTINGS_WORKSPACE);
    if (outcome.kind === "completed") continue;
    throw new Error(outcome.kind === "failed" ? outcome.message : NEEDS_SETTINGS);
  }
}
