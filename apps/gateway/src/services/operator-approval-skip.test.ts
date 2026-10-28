import { describe, expect, it } from "vitest";
import type { DeploymentProfile } from "@goatcitadel/contracts";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";

describe("allowsOperatorApprovalSkip", () => {
  it.each<[DeploymentProfile, boolean, boolean]>([
    ["local_dev", true, true],
    ["local_dev", false, false],
    ["trusted_local", true, true],
    ["trusted_local", false, false],
    // The operator's opt-in never applies to a remote_hardened install.
    ["remote_hardened", true, false],
    ["remote_hardened", false, false],
  ])("on a %s install with the setting %s, allows the skip: %s", (profile, settingOn, expected) => {
    expect(allowsOperatorApprovalSkip(profile, settingOn)).toBe(expected);
  });
});
