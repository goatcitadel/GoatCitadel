import { describe, expect, it, vi } from "vitest";
import { ConflictError, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneRepositoryPort } from "./evolution-control-plane-service.js";
import { settleRefusedChangePlanApproval } from "./evolution-control-plane-approval-reconciliation.js";

const waiting = {
  planId: "plan-1", revision: 3, status: "awaiting_approval",
  requiredAction: { kind: "approval", approvalId: "approval-1" },
} as ChangePlanRecord;

class RefusalRepository {
  current = waiting;
  reads = 0;
  transitions = 0;
  readonly conflict = new ConflictError({ message: "Exact plan revision changed." });
  forceConflict = false;

  async get(planId: string): Promise<ChangePlanRecord> {
    expect(planId).toBe(this.current.planId);
    this.reads += 1;
    return this.current;
  }

  async transition(planId: string, input: Parameters<EvolutionControlPlaneRepositoryPort["transition"]>[1]) {
    expect(planId).toBe(this.current.planId);
    this.transitions += 1;
    if (this.forceConflict || input.expectedRevision !== this.current.revision) throw this.conflict;
    expect(input).toMatchObject({ expectedRevision: 3, status: "cancelled", internal: true,
      requiredAction: null, approvalRefs: ["approval-1"], actorId: "operator-1" });
    this.current = { ...this.current, revision: 4, status: "cancelled", requiredAction: undefined };
    return this.current;
  }
}

describe("refused Change Plan settlement owner", () => {
  it("preserves repository receivers and publishes only the committed exact revision", async () => {
    const repository = new RefusalRepository();
    const signal = vi.fn(async () => {});
    const discard = vi.fn(async () => { expect(repository.transitions).toBe(0); });
    const result = await settleRefusedChangePlanApproval({ repository }, signal, waiting, "denied", "operator-1", discard);
    expect(result).toBe(repository.current);
    expect(repository.reads).toBe(1);
    expect(repository.transitions).toBe(1);
    expect(discard).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledExactlyOnceWith("change_plan.cancelled", result);
  });

  it("returns the winning canonical revision when cleanup races another settlement", async () => {
    const repository = new RefusalRepository();
    const signal = vi.fn(async () => {});
    const result = await settleRefusedChangePlanApproval({ repository }, signal, waiting, "denied", "operator-1",
      async () => { repository.current = { ...waiting, revision: 4, status: "failed" }; });
    expect(result).toBe(repository.current);
    expect(repository.reads).toBe(2);
    expect(repository.transitions).toBe(1);
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not hide an unchanged-revision conflict or emit an uncommitted event", async () => {
    const repository = new RefusalRepository();
    repository.forceConflict = true;
    const signal = vi.fn(async () => {});
    await expect(settleRefusedChangePlanApproval({ repository }, signal, waiting, "denied", "operator-1", async () => {}))
      .rejects.toBe(repository.conflict);
    expect(repository.reads).toBe(2);
    expect(signal).not.toHaveBeenCalled();
  });

  it("preserves the target claim when temporary-input cleanup fails", async () => {
    const repository = new RefusalRepository();
    const signal = vi.fn(async () => {});
    await expect(settleRefusedChangePlanApproval({ repository }, signal, waiting, "denied", "operator-1",
      async () => { throw new Error("custody unavailable"); })).rejects.toThrow("custody unavailable");
    expect(repository.transitions).toBe(0);
    expect(repository.current).toBe(waiting);
    expect(signal).not.toHaveBeenCalled();
  });
});
