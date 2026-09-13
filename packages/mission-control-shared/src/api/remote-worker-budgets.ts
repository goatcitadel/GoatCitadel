import {
  normalizeRemoteWorkerBudgetGrant,
  normalizeRemoteWorkerInferenceOperationIdentifier,
  type RemoteWorkerBudgetBalance,
  type RemoteWorkerBudgetGrant,
  type RemoteWorkerBudgetGrantInput,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

const id = normalizeRemoteWorkerInferenceOperationIdentifier;
const base = (workspaceId: string) => `/api/v1/ops/workspaces/${encodeURIComponent(id(workspaceId, "workspaceId"))}/remote-worker-budgets`;

export async function fetchRemoteWorkerBudgets(
  registryWorkspaceId: string,
  executionWorkspaceId: string,
): Promise<RemoteWorkerBudgetBalance[]> {
  const result = await request<{ items: RemoteWorkerBudgetBalance[] }>(
    `${base(registryWorkspaceId)}?${new URLSearchParams({ executionWorkspaceId: id(executionWorkspaceId, "executionWorkspaceId") })}`,
  );
  if (!Array.isArray(result.items) || result.items.length > 100) throw new Error("Worker budget response is invalid.");
  for (const item of result.items) {
    const { operatorId, createdAt, revokedAt, revision, ...input } = item.grant;
    normalizeRemoteWorkerBudgetGrant(input);
    if (
      !operatorId ||
      !Number.isFinite(Date.parse(createdAt)) ||
      (revokedAt && !Number.isFinite(Date.parse(revokedAt))) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      input.registryWorkspaceId !== registryWorkspaceId ||
      input.executionWorkspaceId !== executionWorkspaceId ||
      item.availableRequests > input.maxRequests || item.availableCostMicrousd > input.maxCostMicrousd ||
      ![
        item.heldRequests,
        item.heldCostMicrousd,
        item.settledRequests,
        item.settledCostMicrousd,
        item.availableRequests,
        item.availableCostMicrousd,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      throw new Error("Worker budget scope or balance is invalid.");
  }
  return result.items;
}

export function authorizeRemoteWorkerBudget(input: RemoteWorkerBudgetGrantInput): Promise<RemoteWorkerBudgetGrant> {
  const { registryWorkspaceId, ...body } = normalizeRemoteWorkerBudgetGrant(input);
  return request(base(registryWorkspaceId), { method: "POST", body: JSON.stringify(body) });
}

export function revokeRemoteWorkerBudget(
  registryWorkspaceId: string,
  grantId: string,
  expectedRevision: number,
): Promise<RemoteWorkerBudgetGrant> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Worker budget revision is invalid.");
  return request(`${base(registryWorkspaceId)}/${encodeURIComponent(id(grantId, "grantId"))}/revoke`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
