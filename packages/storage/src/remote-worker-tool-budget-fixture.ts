import assert from "node:assert/strict";
import {
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type CapabilityCatalogEntry,
  type ModelUsageEventRecord,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
  type StartRemoteWorkerAssignmentGenerationCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerBudgetRepository, remoteWorkerToolBudgetOperationId } from "./remote-worker-budget-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";

/** Identical budget assertions over real canonical Chat, protected admission,
 * effect intents and model usage in SQLite and PostgreSQL. No provider calls. */
export function verifyWorkerToolBudgets(db: DatabaseClient, seed: string,
  worker: Pick<StartRemoteWorkerAssignmentGenerationCommand, "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration">,
  fence: RemoteWorkerAssignmentProtectedCommitFence): void {
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const budget = new RemoteWorkerBudgetRepository(db);
  const effects = new RemoteWorkerEffectRepository(db);
  const usage = new ModelUsageEventRepository(db);
  const entry: CapabilityCatalogEntry = { capabilityId: "tool:fs.read", kind: "tool", category: "built_in",
    title: "Read file", summary: "Read an admitted file", callable: true, trustLabel: "Builtin", toolName: "fs.read",
    effectPotential: { version: "goatcitadel.tool-effect.v1", potential: "none", sourceKind: "builtin", reason: "trusted_builtin_safe_read" } };
  const definition = { type: "function", function: { name: "fs_read", description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
  const prepared = prepareChatOfferFixture(db, true, `-tool-budget-${seed}`, {
    catalogSnapshotId: `tool-budget-catalog:${seed}`,
    subagentPolicy: "off", callableEntries: [entry], tools: [{ canonicalName: "fs.read", modelName: "fs_read",
      providerDefinition: definition, definitionHash: digest(definition),
      runtimeOwner: { kind: "builtin", bindingHash: digest("tool-budget-owner") }, effectPotential: entry.effectPotential }],
  });
  const assignment = assignments.scheduleTaskBoundChatOffer(prepared.offerInput).assignment;
  const leaseTokenSha256 = digest(`${seed}:lease`);
  const { generation } = assignments.startGeneration({ ...worker, registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId, durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256, idempotencyKey: `${seed}:generation` });
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId, assignmentGeneration: generation.assignmentGeneration };
  const intent = effects.recordNextIntent({ ...ref, effectSelector: "fs.read", canonicalArgs: { path: "note.txt" },
    workerIdempotencyKey: `${seed}:tool`, idempotencyKey: `${seed}:tool` });
  const key = { ...ref, intentId: intent.intentId };
  const execution = assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256 }, fence);
  const now = generation.startedAt;
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const route: RemoteWorkerInferenceEffectiveRouteReceipt = {
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION, providerId: "fixture", modelId: "fixture",
    apiStyle: "openai-chat-completions", configuredContextWindowTokens: 8192, credentialType: "api_key",
    usagePool: "standard", credentialSource: "env", pricingCatalogVersion: "fixture-v1", pricingCatalogHash: "a".repeat(64),
    inputRateUsdPerMillion: 1, outputRateUsdPerMillion: 2, cachedInputRateUsdPerMillion: 0.5,
  };
  const grant = { grantId: `${seed}:grant`, registryWorkspaceId: "default", executionWorkspaceId: "default",
    workerId: worker.workerId, workerGeneration: worker.workerGeneration, maxRequests: 3, maxCostMicrousd: 1_000_000, expiresAt };
  const manifest = assignment.manifest;
  function begin(suffix: string, overrides: Partial<ModelUsageEventRecord> = {}) {
    const eventId = `${seed}:${suffix}`;
    usage.begin({ eventId, idempotencyKey: eventId, source: "llm_service", callKind: "utility",
      operationId: `utility:${eventId}`, parentOperationId: remoteWorkerToolBudgetOperationId(intent.intentId),
      dispatchGeneration: `dispatch:${eventId}`, attemptIndex: 0, transportAttemptIndex: 0, fallbackIndex: 0, repairIndex: 0,
      requestedOutputTokenCap: 100, effectiveOutputTokenCap: 100, outputCapDisposition: "initial",
      dispatchOwnerId: "tool-budget-owner", dispatchLeaseExpiresAt: expiresAt,
      workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId, turnId: manifest.turnId,
      durableRunId: manifest.durableRunId, taskId: manifest.taskId, workerId: worker.workerId,
      contextIntentHash: execution.workload.contextSnapshotSha256,
      effectiveProviderId: route.providerId, effectiveModelId: route.modelId, effectiveApiStyle: route.apiStyle,
      credentialType: route.credentialType, usagePool: route.usagePool, credentialSource: route.credentialSource,
      pricingCatalogVersion: route.pricingCatalogVersion, pricingCatalogHash: route.pricingCatalogHash,
      inputRateUsdPerMillion: route.inputRateUsdPerMillion, outputRateUsdPerMillion: route.outputRateUsdPerMillion,
      cachedInputRateUsdPerMillion: route.cachedInputRateUsdPerMillion, startedAt: now, ...overrides });
    return { ...key, leaseTokenSha256, protectedAuthority: fence, usageEventId: eventId, route,
      effectSelector: intent.effectSelector, canonicalArgsSha256: intent.canonicalArgsSha256, workerIdempotencyKey: intent.workerIdempotencyKey };
  }
  const balance = () => budget.listGrants("default", "default").find((row) => row.grant.grantId === grant.grantId)!;
  const first = begin("first");
  budget.createGrant({ ...grant, grantId: `${seed}:foreign` }, "operator-b");
  assert.throws(() => budget.authorizeToolAttempt(first), /No current operator grant/u);
  budget.createGrant(grant, "operator-a");
  for (const field of ["workspaceId", "sessionId", "turnId", "durableRunId", "taskId", "workerId", "contextIntentHash", "parentOperationId"] as const)
    assert.throws(() => budget.authorizeToolAttempt(begin(`foreign-${field}`, { [field]: "foreign" })), /another execution/u);
  assert.throws(() => budget.authorizeToolAttempt({ ...first, leaseTokenSha256: digest("obsolete-lease") }));
  assert.throws(() => budget.authorizeToolAttempt({ ...first, protectedAuthority: { ...fence,
    credentialAuthority: { ...fence.credentialAuthority, authorizationCredentialSha256: digest("obsolete-credential") } } }));
  assert.throws(() => budget.authorizeToolAttempt({ ...first, canonicalArgsSha256: digest("changed-args") }));
  assert.throws(() => budget.authorizeToolAttempt(begin("unbounded", { effectiveOutputTokenCap: undefined,
    requestedOutputTokenCap: undefined, outputCapDisposition: undefined })), /bounded canonical/u);
  assert.throws(() => budget.authorizeToolAttempt(begin("manual", { source: "manual_test" })), /bounded canonical/u);
  assert.throws(() => budget.authorizeToolAttempt({ ...first, route: { ...route, outputRateUsdPerMillion: 0 } }), /pricing/u);
  const unpricedRoute = { ...route, pricingCatalogHash: undefined, pricingCatalogVersion: undefined,
    inputRateUsdPerMillion: undefined, outputRateUsdPerMillion: undefined, cachedInputRateUsdPerMillion: undefined };
  const unpriced = begin("unpriced", { pricingCatalogHash: undefined, pricingCatalogVersion: undefined,
    inputRateUsdPerMillion: undefined, outputRateUsdPerMillion: undefined, cachedInputRateUsdPerMillion: undefined });
  assert.throws(() => budget.authorizeToolAttempt({ ...unpriced, route: unpricedRoute }), /pinned pricing/u);
  assert.equal(balance().heldRequests, 0);

  const retry = begin("retry", { operationId: `utility:${first.usageEventId}`,
    dispatchGeneration: `dispatch:${first.usageEventId}`, transportAttemptIndex: 1 });
  const unknown = begin("unknown");
  for (const attempt of [first, retry, unknown]) budget.authorizeToolAttempt(attempt);
  new RemoteWorkerBudgetRepository(db).authorizeToolAttempt(first);
  assert.equal(balance().heldRequests, 3);
  assert.equal(balance().heldCostMicrousd, 25_176);
  for (const status of ["settled", "released"])
    assert.throws(() => db.transaction("immediate", () => db.prepare(`UPDATE remote_worker_tool_budget_dispatches
      SET status = ?, settled_cost_microusd = NULL, closed_at = ? WHERE usage_event_id = ?`)
      .run(status, now, unknown.usageEventId)), /CHECK|check constraint/u);
  assert.throws(() => budget.authorizeToolAttempt(begin("exhausted")), /No current operator grant/u);
  assert.equal(budget.listToolAttempts(key).length, 3);
  assert.equal(budget.listToolAttempts(key).find((event) => event.eventId === retry.usageEventId)?.transportAttemptIndex, 1);
  for (const event of [first, unknown]) {
    usage.acceptTransport(event.usageEventId, "tool-budget-owner", expiresAt);
    const priced = event === first;
    usage.finalize(event.usageEventId, { dispatchOwnerId: "tool-budget-owner", terminalOutcome: "succeeded",
      availability: priced ? "tracked" : "unknown", pricingSource: priced ? "gateway_estimate" : "not_available",
      costSource: priced ? "gateway_estimate" : "not_available", ...(priced ? { costUsd: 0.000_012, inputTokens: 10, outputTokens: 1 } : {}),
      finishedAt: now, durationMs: 1 });
  }
  usage.confirmTransportNotStarted(retry.usageEventId, "tool-budget-owner", now);
  budget.revokeGrant(grant.grantId, 1);
  assert.throws(() => budget.authorizeToolAttempt(begin("revoked")), /No current operator grant/u);
  const restarted = new RemoteWorkerBudgetRepository(db);
  restarted.reconcileToolAttempts(key);
  restarted.reconcileToolAttempts(key);
  assert.equal(balance().settledRequests, 1);
  assert.equal(balance().settledCostMicrousd, 12);
  assert.equal(balance().heldRequests, 1);
  assert.equal(balance().heldCostMicrousd, 8_392);
  assert.equal(balance().availableRequests, 0);
  for (const sql of ["UPDATE remote_worker_tool_budget_dispatches SET reserved_cost_microusd = 0 WHERE usage_event_id = ?",
    "UPDATE remote_worker_tool_budget_dispatches SET status = 'held', settled_cost_microusd = NULL, closed_at = NULL WHERE usage_event_id = ?",
    "DELETE FROM remote_worker_tool_budget_dispatches WHERE usage_event_id = ?"])
    assert.throws(() => db.transaction("immediate", () => db.prepare(sql).run(first.usageEventId)), /immutable|cannot be deleted/u);
  budget.createGrant({ ...grant, grantId: `${seed}:underfunded`, maxCostMicrousd: 1 }, "operator-a");
  assert.throws(() => budget.authorizeToolAttempt(begin("underfunded")), /No current operator grant/u);
  budget.createGrant({ ...grant, grantId: `${seed}:renewed` }, "operator-a");
  budget.authorizeToolAttempt(begin("renewed"));
  assert.equal(budget.listToolAttempts(key).length, 4);
}
