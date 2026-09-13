import assert from "node:assert/strict";
import { isModelUsageProvenNotDispatched, type ModelUsageEventRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { RemoteWorkerBudgetRepository } from "./remote-worker-budget-repo.js";
import { workerBudgetFixture } from "./remote-worker-budget-fixture.js";

export function relatedWorkerBudgetFixture(db: DatabaseClient, seed: string) {
  const f = workerBudgetFixture(db, seed);
  f.budget.createGrant({ ...f.grant, maxRequests: 5 }, "operator-a");
  const op = f.admit("parent");
  const reservation = f.budget.reserve(op)!;
  f.repo.recordBudgetReservation(op.key, reservation, f.now);
  f.repo.claimDispatch({
    ...op.key,
    dispatchClaimOwner: "related-owner",
    effectiveProviderId: f.route.providerId,
    effectiveModelId: f.route.modelId,
    effectiveRouteSha256: op.operation.effectiveRouteSha256,
    dispatchLeaseExpiresAt: f.expiresAt,
    now: f.now,
  });
  const usage = new ModelUsageEventRepository(db);
  function begin(suffix: string, overrides: Partial<ModelUsageEventRecord> = {}) {
    const eventId = `${seed}:${suffix}`;
    usage.begin({
      eventId,
      idempotencyKey: eventId,
      source: "llm_service",
      callKind: "utility",
      operationId: `utility:${eventId}`,
      parentOperationId: op.operation.operationId,
      dispatchGeneration: `generation:${eventId}`,
      attemptIndex: 0,
      transportAttemptIndex: 0,
      requestedOutputTokenCap: 100,
      effectiveOutputTokenCap: 100,
      outputCapDisposition: "initial",
      fallbackIndex: 0,
      repairIndex: 0,
      dispatchOwnerId: "related-owner",
      dispatchLeaseExpiresAt: f.expiresAt,
      workspaceId: "default",
      sessionId: f.sessionId,
      turnId: f.turnId,
      durableRunId: f.durableRunId,
      taskId: f.taskId,
      workerId: f.workerId,
      contextIntentHash: op.operation.routedContextSha256,
      effectiveProviderId: f.route.providerId,
      effectiveModelId: f.route.modelId,
      effectiveApiStyle: f.route.apiStyle,
      credentialType: f.route.credentialType,
      usagePool: f.route.usagePool,
      credentialSource: f.route.credentialSource,
      pricingCatalogVersion: f.route.pricingCatalogVersion,
      pricingCatalogHash: f.route.pricingCatalogHash,
      inputRateUsdPerMillion: f.route.inputRateUsdPerMillion,
      outputRateUsdPerMillion: f.route.outputRateUsdPerMillion,
      cachedInputRateUsdPerMillion: f.route.cachedInputRateUsdPerMillion,
      startedAt: f.now,
      ...overrides,
    });
    return { reservation, usageEventId: eventId, route: f.route };
  }
  function finish(eventId: string, costUsd?: number) {
    usage.acceptTransport(eventId, "related-owner", f.expiresAt);
    usage.finalize(eventId, {
      dispatchOwnerId: "related-owner",
      terminalOutcome: "succeeded",
      availability: costUsd === undefined ? "unknown" : "tracked",
      pricingSource: costUsd === undefined ? "not_available" : "gateway_estimate",
      costSource: costUsd === undefined ? "not_available" : "gateway_estimate",
      ...(costUsd === undefined ? {} : { costUsd, inputTokens: 10, outputTokens: 1 }),
      finishedAt: f.now,
      durationMs: 1,
    });
  }
  const balance = () => f.budget.listGrants("default", "default").find((row) => row.grant.grantId === f.grant.grantId)!;
  return { ...f, op, reservation, usage, begin, finish, balance };
}

/** Shared behavioral proof executes unchanged against SQLite and real PostgreSQL. */
export function verifyRelatedWorkerBudgets(db: DatabaseClient, seed: string): void {
  const f = relatedWorkerBudgetFixture(db, seed);
  const embedding = f.begin("embedding-not-sent", { source: "embedding_runtime" });
  f.usage.confirmTransportNotStarted(embedding.usageEventId, "related-owner", f.now);
  assert.equal(isModelUsageProvenNotDispatched(f.usage.findByEventId(embedding.usageEventId)!), true);
  const manual = f.begin("manual-not-proof", { source: "manual_test" });
  assert.throws(() => f.usage.confirmTransportNotStarted(manual.usageEventId, "related-owner", f.now), /owner/u);
  const first = f.begin("memory");
  const retry = f.begin("retry", {
    operationId: `utility:${first.usageEventId}`,
    dispatchGeneration: `generation:${first.usageEventId}`,
    transportAttemptIndex: 1,
  });
  const unknown = f.begin("hook");
  for (const attempt of [first, retry, unknown]) f.budget.authorizeRelatedAttempt(attempt);
  new RemoteWorkerBudgetRepository(db).authorizeRelatedAttempt(first);
  assert.equal(f.balance().heldRequests, 5);
  assert.equal(f.balance().heldCostMicrousd, 41_960);
  assert.throws(() => f.budget.authorizeRelatedAttempt(f.begin("exhausted")), /insufficient capacity/u);
  assert.equal(f.budget.reserveForWorker(f.admit("another-root")), undefined);
  const retained = f.budget.listRelatedAttempts(f.reservation);
  assert.equal(retained.length, 3);
  assert.equal(
    retained.find((event) => event.eventId === first.usageEventId)?.operationId,
    `utility:${first.usageEventId}`,
  );
  assert.equal(retained.find((event) => event.eventId === retry.usageEventId)?.transportAttemptIndex, 1);
  f.finish(first.usageEventId, 0.000_012);
  f.usage.confirmTransportNotStarted(retry.usageEventId, "related-owner", f.now);
  f.finish(unknown.usageEventId);
  f.budget.revokeGrant(f.grant.grantId, 1);
  assert.throws(() => f.budget.authorizeRelatedAttempt(first), /not current/u);
  const restarted = new RemoteWorkerBudgetRepository(db);
  restarted.reconcileRelatedAttempts(f.reservation);
  restarted.reconcileRelatedAttempts(f.reservation);
  assert.equal(f.balance().settledRequests, 1);
  assert.equal(f.balance().settledCostMicrousd, 12);
  assert.equal(f.balance().heldRequests, 3); // Root retry reservation plus unknown child.
  assert.equal(f.balance().heldCostMicrousd, 25_176);
  assert.equal(f.balance().availableRequests, 0); // Revoked grants remain unavailable.
  assert.throws(
    () =>
      db
        .prepare("UPDATE remote_worker_budget_dispatches SET reserved_cost_microusd = 0 WHERE usage_event_id = ?")
        .run(unknown.usageEventId),
    /immutable/u,
  );
  assert.throws(
    () => db.prepare("DELETE FROM remote_worker_budget_dispatches WHERE usage_event_id = ?").run(first.usageEventId),
    /cannot be deleted/u,
  );
}
