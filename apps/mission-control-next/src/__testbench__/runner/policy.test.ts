import { describe, expect, it } from "vitest";
import { checkPermission } from "./policy";
import type { CheckTier, RunOptions } from "./types";

const NO_OPT_INS: RunOptions = { allowHost: false, confirmedExternalIds: new Set() };
const SANDBOX = { kind: "sandbox" as const };
const REAL = { kind: "real" as const };

function check(tier: CheckTier, realSafe?: true) {
  return { id: `demo.${tier}`, tier, realSafe };
}

describe("checkPermission", () => {
  it("always allows read checks", () => {
    expect(checkPermission(check("read"), SANDBOX, NO_OPT_INS)).toEqual({ allowed: true });
    expect(checkPermission(check("read"), REAL, NO_OPT_INS)).toEqual({ allowed: true });
  });

  it("allows mutate checks only in the verified sandbox", () => {
    expect(checkPermission(check("mutate"), SANDBOX, NO_OPT_INS)).toEqual({ allowed: true });
    expect(checkPermission(check("mutate"), REAL, NO_OPT_INS)).toEqual({
      allowed: false,
      reason: "Mutating checks never run on the real gateway.",
    });
  });

  it("requires the per-run opt-in for host checks and never runs them on the real gateway", () => {
    expect(checkPermission(check("host"), SANDBOX, NO_OPT_INS)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Allow host checks"),
    });
    expect(checkPermission(check("host"), SANDBOX, { ...NO_OPT_INS, allowHost: true })).toEqual({ allowed: true });
    expect(checkPermission(check("host"), REAL, { ...NO_OPT_INS, allowHost: true })).toEqual({
      allowed: false,
      reason: "Host checks never run on the real gateway.",
    });
  });

  it("requires confirmation for external checks", () => {
    const confirmed: RunOptions = { allowHost: false, confirmedExternalIds: new Set(["demo.external"]) };
    expect(checkPermission(check("external"), SANDBOX, NO_OPT_INS)).toEqual({
      allowed: false,
      reason: "External checks run only after you confirm them.",
    });
    expect(checkPermission(check("external"), SANDBOX, confirmed)).toEqual({ allowed: true });
  });

  it("runs only realSafe external checks on the real gateway, and only once confirmed", () => {
    const confirmed: RunOptions = { allowHost: false, confirmedExternalIds: new Set(["demo.external"]) };
    expect(checkPermission(check("external"), REAL, confirmed)).toEqual({
      allowed: false,
      reason: "Only allowlisted external checks run on the real gateway.",
    });
    expect(checkPermission(check("external", true), REAL, NO_OPT_INS)).toMatchObject({ allowed: false });
    expect(checkPermission(check("external", true), REAL, confirmed)).toEqual({ allowed: true });
  });
});
