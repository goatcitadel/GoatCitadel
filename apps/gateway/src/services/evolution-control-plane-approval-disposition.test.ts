import { describe, expect, it } from "vitest";
import { changePlanApprovalDisposition } from "./evolution-control-plane-approval-disposition.js";

describe("canonical Change Plan approval disposition", () => {
  const expiresAt = "2026-09-13T10:00:00.000Z", before = "2026-09-13T09:59:59.000Z", after = "2026-09-13T10:00:01.000Z";
  it("distinguishes expiry rejection from an earlier operator refusal without parsing note text", () => {
    expect(changePlanApprovalDisposition({ status: "rejected", expiresAt, resolvedAt: after })).toBe("expired");
    expect(changePlanApprovalDisposition({ status: "rejected", expiresAt, resolvedAt: expiresAt })).toBe("expired");
    expect(changePlanApprovalDisposition({ status: "rejected", expiresAt, resolvedAt: before })).toBe("denied");
    expect(changePlanApprovalDisposition({ status: "rejected", expiresAt })).toBe("denied");
  });
  it("retains canonical approval and edit decisions after the deadline", () => {
    expect(changePlanApprovalDisposition({ status: "approved", expiresAt, resolvedAt: before })).toBe("approved");
    expect(changePlanApprovalDisposition({ status: "edited", expiresAt, resolvedAt: after })).toBe("denied");
  });
  it("expires pending waits only from the database-clock owner's observation", () => {
    expect(changePlanApprovalDisposition({ status: "pending", expiresAt }, false)).toBe("pending");
    expect(changePlanApprovalDisposition({ status: "pending", expiresAt }, true)).toBe("expired");
    expect(changePlanApprovalDisposition({ status: "pending" })).toBe("pending");
    expect(changePlanApprovalDisposition({ status: "pending", expiresAt: "invalid" }, false)).toBe("pending");
    expect(changePlanApprovalDisposition({ status: "pending", expiresAt: "invalid" }, true)).toBe("expired");
  });
});
