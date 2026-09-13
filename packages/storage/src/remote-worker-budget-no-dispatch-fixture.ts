import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { RemoteWorkerBudgetRepository } from "./remote-worker-budget-repo.js";
import { workerBudgetFixture } from "./remote-worker-budget-fixture.js";

/** Shared SQLite/PostgreSQL assertion against real repository owners. */
export function verifyNoDispatchBudgetEvidence(db: DatabaseClient): void {
  const usage = new ModelUsageEventRepository(db);
  for (const scenario of ["proven", "uncertain", "empty", "completed"] as const) {
    const f = workerBudgetFixture(db, `no-dispatch-${scenario}`);
    f.budget.createGrant(f.grant, "operator-a");
    const balance = () =>
      f.budget.listGrants("default", "default").find((item) => item.grant.grantId === f.grant.grantId)!;
    const proven = scenario === "proven" || scenario === "completed";
    const id = `${scenario}-intent`;
    const op = f.admit(id);
    const receipt = f.budget.reserve(op)!;
    f.repo.recordBudgetReservation(op.key, receipt, f.now);
    f.repo.claimDispatch({
      ...op.key,
      dispatchClaimOwner: "fixture-owner",
      effectiveProviderId: f.route.providerId,
      effectiveModelId: f.route.modelId,
      effectiveRouteSha256: op.operation.effectiveRouteSha256,
      dispatchLeaseExpiresAt: f.expiresAt,
      now: f.now,
    });
    if (scenario !== "empty") {
      usage.begin({
        eventId: id,
        idempotencyKey: id,
        source: "llm_service",
        callKind: "delegation_worker",
        operationId: op.operation.operationId,
        dispatchGeneration: op.operation.dispatchGeneration,
        attemptIndex: 0,
        transportAttemptIndex: 0,
        requestedOutputTokenCap: 100,
        effectiveOutputTokenCap: 100,
        outputCapDisposition: "initial",
        fallbackIndex: 0,
        repairIndex: 0,
        dispatchOwnerId: "fixture-owner",
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
      });
      f.budget.authorizeAttempt(receipt, id);
      if (proven) {
        usage.confirmTransportNotStarted(id, "fixture-owner", f.now);
      } else {
        usage.markDispatchUnknown(id, "fixture-owner", f.now, "connection_lost");
        usage.reconcileDispatchUnknown(id, {
          reconciliation: "confirmed_not_dispatched",
          reconciledAt: f.now,
          reconciledBy: "operator-a",
          evidence: "Operator believes no request was sent.",
        });
      }
    }
    const ids = scenario === "empty" ? [] : [id];
    const finalize = () =>
      f.repo.finalizeTerminal({
        ...op.key,
        dispatchClaimOwner: "fixture-owner",
        terminalState: scenario === "completed" ? "completed" : "failed",
        usageEventIds: ids,
        now: f.now,
      });
    const settlement = { reservation: receipt, usageEventIds: ids };
    if (scenario === "empty") {
      assert.throws(finalize, /non-empty/u);
      assert.throws(() => f.budget.settle(settlement), /non-empty/u);
      assert.equal(balance().heldRequests, 2);
      continue;
    }
    finalize();
    if (scenario === "proven") {
      f.budget.settle(settlement);
      new RemoteWorkerBudgetRepository(db).settle(settlement);
      assert.equal(balance().heldRequests, 0);
      assert.equal(balance().settledRequests, 0);
      assert.equal(balance().settledCostMicrousd, 0);
      assert.equal(balance().availableRequests, 2);
      assert.throws(() => f.budget.settle({ ...settlement, usageEventIds: ["different-intent"] }));
    } else {
      assert.throws(() => f.budget.settle(settlement), /uncertain|incomplete|without a provider dispatch/u);
      assert.equal(balance().heldRequests, 2);
    }
  }
}
