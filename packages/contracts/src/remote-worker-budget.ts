import { canonicalJsonString } from "./canonical-json.js";
import { normalizeRemoteWorkerInferenceOperationIdentifier } from "./remote-worker-inference.js";

/** An operator grant is permission to spend; usage remains owned by model_usage_events. */
export interface RemoteWorkerBudgetGrantInput {
  readonly grantId: string;
  readonly registryWorkspaceId: string;
  readonly executionWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly maxRequests: number;
  readonly maxCostMicrousd: number;
  readonly expiresAt: string;
}

export interface RemoteWorkerBudgetGrant extends RemoteWorkerBudgetGrantInput {
  readonly operatorId: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
  readonly revision: number;
}

export interface RemoteWorkerBudgetBalance {
  readonly grant: RemoteWorkerBudgetGrant;
  readonly heldRequests: number;
  readonly heldCostMicrousd: number;
  readonly settledRequests: number;
  readonly settledCostMicrousd: number;
  readonly availableRequests: number;
  readonly availableCostMicrousd: number;
}

export const REMOTE_WORKER_BUDGET_OWNER_ID = "gateway.remote-worker-budget.v1";
// The existing inference transport allows at most one output-cap recovery retry.
export const REMOTE_WORKER_BUDGET_MAX_ATTEMPTS = 2;

export function normalizeRemoteWorkerBudgetGrant(input: RemoteWorkerBudgetGrantInput): RemoteWorkerBudgetGrantInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("A worker budget grant is required.");
  const expected = [
    "grantId",
    "registryWorkspaceId",
    "executionWorkspaceId",
    "workerId",
    "workerGeneration",
    "maxRequests",
    "maxCostMicrousd",
    "expiresAt",
  ];
  if (Object.keys(input).some((key) => !expected.includes(key)))
    throw new TypeError("Unknown worker budget grant field.");
  const id = normalizeRemoteWorkerInferenceOperationIdentifier;
  const integer = (value: number, name: string, min: number, max: number): number => {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new TypeError(`Invalid worker budget ${name}.`);
    return value;
  };
  if (
    typeof input.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    new Date(input.expiresAt).toISOString() !== input.expiresAt
  ) {
    throw new TypeError("Worker budget expiry must be a canonical UTC timestamp.");
  }
  return Object.freeze({
    grantId: id(input.grantId, "grantId"),
    registryWorkspaceId: id(input.registryWorkspaceId, "registryWorkspaceId"),
    executionWorkspaceId: id(input.executionWorkspaceId, "executionWorkspaceId"),
    workerId: id(input.workerId, "workerId"),
    workerGeneration: integer(input.workerGeneration, "workerGeneration", 1, Number.MAX_SAFE_INTEGER),
    maxRequests: integer(input.maxRequests, "maxRequests", 1, 100_000),
    maxCostMicrousd: integer(input.maxCostMicrousd, "maxCostMicrousd", 0, 1_000_000_000_000),
    expiresAt: input.expiresAt,
  });
}

export function normalizeRemoteWorkerBudgetOperatorId(operatorId: unknown): string {
  // Gateway auth supplies these exact non-secret identities. The generic text
  // redactor treats their prefixes as credential assignments; do not change
  // redaction for arbitrary identifiers or accept a raw credential here.
  const canonicalAuthActor = typeof operatorId === "string"
    && (operatorId === "auth:none" || /^token:[0-9a-f]{16}$/u.test(operatorId));
  return canonicalAuthActor ? operatorId : normalizeRemoteWorkerInferenceOperationIdentifier(operatorId, "operatorId");
}

export function remoteWorkerBudgetGrantIdentity(input: RemoteWorkerBudgetGrantInput, operatorId: string): string {
  return canonicalJsonString({
    ...normalizeRemoteWorkerBudgetGrant(input),
    operatorId: normalizeRemoteWorkerBudgetOperatorId(operatorId),
  });
}
