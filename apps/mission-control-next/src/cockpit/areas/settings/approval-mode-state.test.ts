// A lost write on one Gateway must never overwrite, clear or be cleared by another Gateway's record.
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetApprovalModeUncertaintyForTests,
  clearApprovalModeUncertainty,
  currentApprovalModeUncertainty,
  retainApprovalModeUncertainty,
  type ApprovalModeUncertainty,
} from "./approval-mode-state";

const record = (installation: string, message: string): ApprovalModeUncertainty => ({
  message,
  submitted: "approve_risky",
  baseRevision: 3,
  previous: "approve_all",
  installation,
  checking: false,
});

afterEach(() => __resetApprovalModeUncertaintyForTests());

describe("approval rule uncertainty records", () => {
  it("keeps one record per installation", () => {
    retainApprovalModeUncertainty(record("gateway-a", "A is unconfirmed"));
    retainApprovalModeUncertainty(record("gateway-b", "B is unconfirmed"));
    expect(currentApprovalModeUncertainty("gateway-a")?.message).toBe("A is unconfirmed");
    expect(currentApprovalModeUncertainty("gateway-b")?.message).toBe("B is unconfirmed");
  });

  it("clears only its own installation's record, in either order", () => {
    retainApprovalModeUncertainty(record("gateway-a", "A is unconfirmed"));
    retainApprovalModeUncertainty(record("gateway-b", "B is unconfirmed"));
    clearApprovalModeUncertainty("gateway-b");
    expect(currentApprovalModeUncertainty("gateway-a")?.message).toBe("A is unconfirmed");
    expect(currentApprovalModeUncertainty("gateway-b")).toBeUndefined();
    retainApprovalModeUncertainty(record("gateway-b", "B again"));
    clearApprovalModeUncertainty("gateway-a");
    expect(currentApprovalModeUncertainty("gateway-b")?.message).toBe("B again");
  });

  it("replaces only the same installation's record when its check updates it", () => {
    retainApprovalModeUncertainty(record("gateway-a", "Checking"));
    retainApprovalModeUncertainty(record("gateway-b", "B is unconfirmed"));
    retainApprovalModeUncertainty({ ...record("gateway-a", "A did not answer"), checking: true });
    expect(currentApprovalModeUncertainty("gateway-a")).toMatchObject({ message: "A did not answer", checking: true });
    expect(currentApprovalModeUncertainty("gateway-b")?.message).toBe("B is unconfirmed");
  });
});
