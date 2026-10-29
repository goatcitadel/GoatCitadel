import { describe, expect, it, vi } from "vitest";
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
  ])("on a %s install with the setting %s, allows the skip: %s", async (profile, settingOn, expected) => {
    expect(await allowsOperatorApprovalSkip(profile, async () => settingOn)).toBe(expected);
  });

  it("never reads the setting on a remote_hardened install", async () => {
    const readSkipSetting = vi.fn(async (): Promise<boolean> => {
      throw new Error("settings store locked");
    });

    // A setting that can't be read can't matter where the skip never applies.
    expect(await allowsOperatorApprovalSkip("remote_hardened", readSkipSetting)).toBe(false);
    expect(readSkipSetting).not.toHaveBeenCalled();
  });

  it("reads the setting once elsewhere, and lets its failure reach the caller", async () => {
    const failure = new Error("settings store locked");
    const readSkipSetting = vi.fn(async (): Promise<boolean> => {
      throw failure;
    });

    await expect(allowsOperatorApprovalSkip("trusted_local", readSkipSetting)).rejects.toBe(failure);
    expect(readSkipSetting).toHaveBeenCalledTimes(1);
  });
});
