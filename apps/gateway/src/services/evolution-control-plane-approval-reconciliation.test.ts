import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { reconcileChangePlanApproval } from "./evolution-control-plane-approval-reconciliation.js";

// Only the fields the bounded delivery owner reads; settlement remains a separate owner.
const waiting = (planId: string, approvalId = "approval-1") => ({
  planId, status: "awaiting_approval", requiredAction: { kind: "approval", approvalId },
}) as ChangePlanRecord;

function fixture(plans: ChangePlanRecord[]) {
  const remaining = new Map(plans.map(plan => [plan.planId, plan]));
  const settle = vi.fn(async (plan: ChangePlanRecord) => {
    remaining.delete(plan.planId);
    return plan;
  });
  const forbidden = vi.fn(async () => { throw new Error("Delivery must not directly mutate plans"); });
  const deps = {
    repository: {
      get: forbidden,
      transition: forbidden,
      listAwaitingApproval: vi.fn(async (_id: string, limit = 100) => [...remaining.values()].slice(0, limit)),
    },
    getApprovalDisposition: vi.fn(async () => "denied" as const),
  };
  return { deps, settle, forbidden, remaining };
}

describe("bounded Change Plan refusal delivery", () => {
  it("retries past the first hundred waits without repeating settled plans", async () => {
    const f = fixture(Array.from({ length: 101 }, (_, index) => waiting(String(index))));
    await expect(reconcileChangePlanApproval(f.deps, "approval-1", f.settle)).rejects.toThrow("Another Change Plan approval reconciliation batch is required");
    expect(f.remaining.size).toBe(1);
    expect(await reconcileChangePlanApproval(f.deps, "approval-1", f.settle)).toBe(1);
    expect(await reconcileChangePlanApproval(f.deps, "approval-1", f.settle)).toBe(0);
    expect(f.settle).toHaveBeenCalledTimes(101);
    expect(new Set(f.settle.mock.calls.map(([plan]) => plan.planId)).size).toBe(101);
    expect(f.deps.repository.listAwaitingApproval).toHaveBeenCalledWith("approval-1", 100);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("refuses a mismatched approval binding before settlement", async () => {
    const f = fixture([waiting("foreign", "approval-2")]);
    await expect(reconcileChangePlanApproval(f.deps, "approval-1", f.settle)).rejects.toThrow("approval binding is inconsistent");
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
