import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { withCanonicalApprovalOutcome } from "./approval-follow-up.js";

describe("canonical approval outcomes", () => {
  it("preserves approval when the action subsequently fails", async () => {
    const storage = {
      approvalEvents: {
        listByApprovalId: vi.fn(async () => [
          { eventType: "resolved", actorId: "operator", payload: { outcome: "approved" } },
          { eventType: "approved_action_executed", actorId: "system", payload: { actionOutcome: "delivery_failed" } },
        ]),
      },
    } as never;
    expect(
      await withCanonicalApprovalOutcome(storage, { approvalId: "approval", status: "approved" } as ApprovalRequest),
    ).toMatchObject({ status: "approved", resolutionOutcome: "approved", actionOutcome: "delivery_failed" });
  });
  it("keeps legacy rejection and execution reasons unknown without interpreting display text", async () => {
    const storage = {
      approvalEvents: {
        listByApprovalId: vi.fn(async () => [
          { eventType: "resolved", actorId: "operator", payload: { note: "The user stopped this turn" } },
          { eventType: "approved_action_executed", actorId: "system", payload: { outcome: "executed" } },
        ]),
      },
    } as never;
    expect(
      await withCanonicalApprovalOutcome(storage, { approvalId: "legacy", status: "rejected" } as ApprovalRequest),
    ).toMatchObject({ resolutionOutcome: "unknown", actionOutcome: "unknown" });
  });
  it.each(["denied", "withdrawn", "expired", "policy_blocked"])(
    "projects %s from its canonical event",
    async (outcome) => {
      const storage = {
        approvalEvents: { listByApprovalId: vi.fn(async () => [{ eventType: "resolved", payload: { outcome } }]) },
      } as never;
      expect(
        (await withCanonicalApprovalOutcome(storage, { approvalId: "approval", status: "rejected" } as ApprovalRequest))
          .resolutionOutcome,
      ).toBe(outcome);
    },
  );
});
