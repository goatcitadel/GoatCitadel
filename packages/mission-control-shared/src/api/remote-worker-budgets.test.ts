import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRemoteWorkerBudget, fetchRemoteWorkerBudgets, revokeRemoteWorkerBudget } from "./remote-worker-budgets.js";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));
beforeEach(() => mocks.request.mockReset());
const input = { registryWorkspaceId: "registry", executionWorkspaceId: "workspace", grantId: "grant-one", workerId: "worker-one",
  workerGeneration: 3, maxRequests: 4, maxCostMicrousd: 2_000_000, expiresAt: "2030-01-01T00:00:00.000Z" };
const balance = { grant: { ...input, operatorId: "operator", revision: 1, createdAt: "2026-09-09T00:00:00.000Z" },
  heldRequests: 2, heldCostMicrousd: 1_000_000, settledRequests: 1, settledCostMicrousd: 200_000, availableRequests: 1, availableCostMicrousd: 800_000 };
describe("remote worker budget client", () => {
  it("uses the authenticated request transport and binds both scopes", async () => {
    mocks.request.mockResolvedValue({ items: [balance] });
    expect(await fetchRemoteWorkerBudgets("registry", "workspace")).toEqual([balance]);
    expect(mocks.request).toHaveBeenCalledWith("/api/v1/ops/workspaces/registry/remote-worker-budgets?executionWorkspaceId=workspace");
    await authorizeRemoteWorkerBudget(input);
    const call = mocks.request.mock.calls[1]!;
    expect(call[0]).toBe("/api/v1/ops/workspaces/registry/remote-worker-budgets");
    expect(JSON.parse(call[1].body)).toEqual({ ...input, registryWorkspaceId: undefined });
    await revokeRemoteWorkerBudget("registry", "grant-one", 1);
    expect(mocks.request.mock.calls[2]).toEqual(["/api/v1/ops/workspaces/registry/remote-worker-budgets/grant-one/revoke",
      { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) }]);
  });
  it.each([
    { ...balance, availableRequests: 9 }, { ...balance, heldCostMicrousd: -1 }, { ...balance, availableCostMicrousd: 3_000_000 },
    { ...balance, grant: { ...balance.grant, executionWorkspaceId: "foreign" } },
    { ...balance, grant: { ...balance.grant, credential: "forbidden" } },
  ])("rejects malformed or out-of-scope balances", async value => {
    mocks.request.mockResolvedValue({ items: [value] });
    await expect(fetchRemoteWorkerBudgets("registry", "workspace")).rejects.toThrow();
  });
  it("rejects oversized inventories and invalid mutation inputs", async () => {
    mocks.request.mockResolvedValue({ items: Array(101).fill(balance) });
    await expect(fetchRemoteWorkerBudgets("registry", "workspace")).rejects.toThrow("invalid");
    mocks.request.mockClear();
    expect(() => authorizeRemoteWorkerBudget({ ...input, maxRequests: 0 })).toThrow();
    expect(() => revokeRemoteWorkerBudget("registry", "grant-one", NaN)).toThrow();
    await expect(fetchRemoteWorkerBudgets("registry", "")).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
