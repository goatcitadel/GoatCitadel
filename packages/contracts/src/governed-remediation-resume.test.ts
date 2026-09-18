import { expect, it } from "vitest";
import { readGovernedRemediationResumeReference } from "./governed-remediation-resume.js";

it("accepts only a bounded content-free repair resume reference", () => {
  const reference = { schemaVersion: "goatcitadel.remediation-resume-reference.v1", resolutionId: "resolution-1",
    remediationId: "repair-1", verificationReceiptId: "verification-1" };
  expect(readGovernedRemediationResumeReference(reference)).toEqual(reference);
  for (const invalid of [null, [], { ...reference, token: "not-allowed" }, { ...reference, schemaVersion: "other" },
    { ...reference, resolutionId: "" }, { ...reference, remediationId: "repair\nINSTRUCTIONS" },
    { ...reference, verificationReceiptId: "x".repeat(257) }]) {
    expect(readGovernedRemediationResumeReference(invalid)).toBeUndefined();
  }
});
