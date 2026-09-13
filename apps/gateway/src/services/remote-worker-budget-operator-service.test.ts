import { describe, expect, it, vi } from "vitest";
import type { RemoteWorkerRegistryRecord } from "@goatcitadel/storage";
import { RemoteWorkerBudgetOperatorService } from "./remote-worker-budget-operator-service.js";

const grant = {
  grantId: "budget-a",
  registryWorkspaceId: "registry",
  executionWorkspaceId: "workspace-a",
  workerId: "worker-a",
  workerGeneration: 1,
  maxRequests: 40,
  maxCostMicrousd: 5_000_000,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function harness() {
  const budgets = {
    createGrant: vi.fn(),
    getGrant: vi.fn(async () => ({
      ...grant,
      operatorId: "operator-a",
      createdAt: "2026-09-09T00:00:00.000Z",
      revision: 1,
    })),
    listGrants: vi.fn(),
    revokeGrant: vi.fn(),
  };
  const registry = {
    listWorkerRegistry: vi.fn(),
    findWorkerRegistryEntry: vi.fn(
      async () => ({ admission: { workerId: "worker-a", workerGeneration: 1 } }) as RemoteWorkerRegistryRecord,
    ),
  };
  const audit = { append: vi.fn(async () => undefined) };
  return { budgets, registry, audit, service: new RemoteWorkerBudgetOperatorService(budgets, registry, audit) };
}

describe("remote worker operator budgets", () => {
  it("audits the exact operator authorization before creating spending authority", async () => {
    const h = harness();
    await h.service.create(grant, "operator-a");
    expect(h.budgets.createGrant).toHaveBeenCalledWith(grant, "operator-a");
    expect(h.audit.append.mock.invocationCallOrder[0]).toBeLessThan(h.budgets.createGrant.mock.invocationCallOrder[0]!);
    h.audit.append.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(h.service.create(grant, "operator-a")).rejects.toThrow("audit unavailable");
    expect(h.budgets.createGrant).toHaveBeenCalledTimes(1);
  });

  it("refuses stale generations and cross-workspace revocations", async () => {
    const h = harness();
    await expect(h.service.create({ ...grant, workerGeneration: 2 }, "operator-a")).rejects.toThrow("current admitted");
    await expect(
      h.service.revoke({
        registryWorkspaceId: "foreign",
        grantId: grant.grantId,
        expectedRevision: 1,
        actorId: "operator-a",
      }),
    ).rejects.toThrow("scope mismatch");
    expect(h.budgets.createGrant).not.toHaveBeenCalled();
    expect(h.budgets.revokeGrant).not.toHaveBeenCalled();
  });
});
