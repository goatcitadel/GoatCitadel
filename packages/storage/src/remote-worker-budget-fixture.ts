import {
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  authorizeRemoteWorkerInferenceRequestSubmission,
  remoteWorkerInferenceBudgetOperationSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceRequestSha256,
  type RemoteWorkerBudgetGrantInput,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerBudgetRepository } from "./remote-worker-budget-repo.js";
import { seedRemoteWorkerInferenceAuthority } from "./remote-worker-inference-fixture.js";

export function workerBudgetFixture(db: DatabaseClient, seed: string) {
  const a = seedRemoteWorkerInferenceAuthority(db, seed);
  const budget = new RemoteWorkerBudgetRepository(db);
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const route: RemoteWorkerInferenceEffectiveRouteReceipt = {
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
    providerId: "fixture-provider",
    modelId: "fixture-model",
    apiStyle: "openai-chat-completions",
    configuredContextWindowTokens: 8192,
    credentialType: "api_key",
    usagePool: "standard",
    credentialSource: "env",
    pricingCatalogVersion: "fixture-v1",
    pricingCatalogHash: "a".repeat(64),
    inputRateUsdPerMillion: 1,
    outputRateUsdPerMillion: 2,
    cachedInputRateUsdPerMillion: 0.5,
  };
  const grant: RemoteWorkerBudgetGrantInput = {
    grantId: `grant-${seed}`,
    registryWorkspaceId: "default",
    executionWorkspaceId: "default",
    workerId: a.workerId,
    workerGeneration: a.workerGeneration,
    maxRequests: 2,
    maxCostMicrousd: 1_000_000,
    expiresAt,
  };
  function admit(suffix: string, effectiveRoute = route) {
    const submission = authorizeRemoteWorkerInferenceRequestSubmission({
      registryWorkspaceId: "default",
      assignmentId: a.assignmentId,
      assignmentGeneration: a.assignmentGeneration,
      inferenceRequestId: `inference-${suffix}`,
      attempt: 1,
      idempotencyKey: `${seed}:${suffix}`,
      leaseToken: "fixture-lease",
      messages: [{ role: "user", text: "Compute 2 + 2." }],
      inputSha256: "b".repeat(64),
      contextSha256: "c".repeat(64),
      modelIntentSha256: "d".repeat(64),
      outputTokenCeiling: 100,
      reasoningTokenCeiling: 0,
      temperatureMilli: 0,
    }).submission;
    const operation = {
      operationId: `budget-op-${seed}:${suffix}`,
      dispatchGeneration: `budget-dispatch-${seed}:${suffix}`,
      requestSha256: remoteWorkerInferenceRequestSha256(submission),
      effectiveRouteSha256: remoteWorkerInferenceEffectiveRouteSha256(effectiveRoute),
      registryWorkspaceId: "default",
      executionWorkspaceId: "default",
      assignmentId: a.assignmentId,
      assignmentGeneration: a.assignmentGeneration,
      workerId: a.workerId,
      workerGeneration: a.workerGeneration,
      admittedLeaseRevision: 1,
      sessionId: a.sessionId,
      turnId: a.turnId,
      durableRunId: a.durableRunId,
      taskId: a.taskId,
      capabilityProfileSha256: "e".repeat(64),
      routedContextSha256: submission.contextSha256,
      outputTokenCeiling: submission.outputTokenCeiling,
      reasoningTokenCeiling: submission.reasoningTokenCeiling,
    };
    const {
      operationId,
      dispatchGeneration,
      requestSha256: _requestSha256,
      effectiveRouteSha256,
      ...authority
    } = operation;
    a.repo.admitOrReplay({
      ...authority,
      submission,
      operationId,
      dispatchGeneration,
      governance: {
        schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
        decision: "allowed",
        effectiveRouteSha256,
        policyRevision: 1,
        policySha256: "f".repeat(64),
        outputTokenCeiling: 100,
        reasoningTokenCeiling: 0,
        expiresAt,
      },
      effectiveRoute,
      budgetOperation: operation,
      admittedAt: a.now,
    });
    const { registryWorkspaceId, assignmentId, assignmentGeneration, inferenceRequestId, attempt } = submission;
    return {
      grantId: grant.grantId,
      operation,
      operationSha256: remoteWorkerInferenceBudgetOperationSha256(operation),
      key: { registryWorkspaceId, assignmentId, assignmentGeneration, inferenceRequestId, attempt },
    };
  }
  return { ...a, budget, grant, expiresAt, route, admit };
}
