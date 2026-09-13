import { describe, expect, it } from "vitest";
import { remoteWorkerBudgetGrantIdentity, type RemoteWorkerBudgetGrantInput } from "./remote-worker-budget.js";

const grant: RemoteWorkerBudgetGrantInput = {
  grantId: "grant-a", registryWorkspaceId: "registry", executionWorkspaceId: "workspace",
  workerId: "worker-a", workerGeneration: 1, maxRequests: 2, maxCostMicrousd: 1_000_000,
  expiresAt: "2026-09-10T09:00:00.000Z",
};

describe("worker budget operator identity", () => {
  it.each(["auth:none", "token:0123456789abcdef", "operator-a"])("retains canonical actor %s exactly", (operatorId) => {
    expect(JSON.parse(remoteWorkerBudgetGrantIdentity(grant, operatorId)).operatorId).toBe(operatorId);
  });

  it.each(["auth:fixture-secret", "token:fixture-secret", "token:0123456789abcdef-extra", "auth:none token=fixture-secret"])(
    "rejects secret-like actor %s", (operatorId) => {
      expect(() => remoteWorkerBudgetGrantIdentity(grant, operatorId)).toThrow("secret-like");
    },
  );

  it("does not exempt credential-shaped grant identifiers", () => {
    expect(() => remoteWorkerBudgetGrantIdentity({ ...grant, grantId: "auth:none" }, "auth:none")).toThrow("secret-like");
  });
});
