import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { remoteWorkerInferenceBudgetOperationSha256 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ModelUsageEventRepository } from "./model-usage-event-repo.js";
import { RemoteWorkerBudgetRepository } from "./remote-worker-budget-repo.js";
import { workerBudgetFixture } from "./remote-worker-budget-fixture.js";
import { createDatabase } from "./sqlite.js";
import { verifyNoDispatchBudgetEvidence } from "./remote-worker-budget-no-dispatch-fixture.js";

const clients: DatabaseClient[] = [];
afterEach(() => {
  for (const db of clients.splice(0)) db.close();
});
function fixture(seed: string) {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  return workerBudgetFixture(db, seed);
}

describe("remote worker budget authority", () => {
  it("retains canonical auth actors across grant creation, reload, replay and operator lookup", () => {
    for (const operatorId of ["auth:none", "token:0123456789abcdef"]) {
      const f = fixture("canonical-actor");
      const created = f.budget.createGrant(f.grant, operatorId);
      const reloaded = new RemoteWorkerBudgetRepository(f.db);
      assert.equal(created.operatorId, operatorId);
      assert.deepEqual(reloaded.getGrant(f.grant.grantId), created);
      assert.deepEqual(reloaded.createGrant(f.grant, operatorId), created);
      assert.equal(reloaded.listExecutionGrants("default", operatorId)[0]!.grant.operatorId, operatorId);
      assert.equal(reloaded.listExecutionGrants("default", "another-operator").length, 0);
      assert.throws(() => reloaded.createGrant(f.grant, "token:fixture-secret"), /secret-like/u);
    }
  });

  it("releases unused capacity only from canonical proof that HTTP was not invoked", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    verifyNoDispatchBudgetEvidence(db);
  });
  it("requires an explicit operator grant and exact replay, with expiry and scope ceilings", () => {
    const f = fixture("grant");
    const op = f.admit("first");
    assert.throws(() => f.budget.reserve(op), /explicit operator/u);
    const created = f.budget.createGrant(f.grant, "operator-a");
    assert.deepEqual(f.budget.createGrant(f.grant, "operator-a"), created);
    assert.throws(() => f.budget.createGrant({ ...f.grant, maxRequests: 3 }, "operator-a"), /replay changed/u);
    assert.throws(() => f.budget.createGrant(f.grant, "operator-b"), /replay changed/u);
    assert.throws(
      () =>
        f.budget.createGrant({ ...f.grant, grantId: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }, "operator-a"),
      /expire within/u,
    );
    f.budget.createGrant(
      { ...f.grant, grantId: "other-generation", workerGeneration: f.workerGeneration + 1 },
      "operator-a",
    );
    assert.throws(() => f.budget.reserve({ ...op, grantId: "other-generation" }), /scope mismatch/u);
    const operation = { ...op.operation, outputTokenCeiling: 101 };
    assert.throws(
      () =>
        f.budget.reserve({ ...op, operation, operationSha256: remoteWorkerInferenceBudgetOperationSha256(operation) }),
      /admitted authority/u,
    );
  });

  it("reserves retries atomically, exactly replays after restart, and prevents spending the last grant twice", () => {
    const f = fixture("reserve");
    f.budget.createGrant(f.grant, "operator-a");
    const op = f.admit("one");
    const receipt = f.budget.reserve(op)!;
    assert.equal(receipt.reservedCostMicrousd, 16_784);
    assert.deepEqual(new RemoteWorkerBudgetRepository(f.db).reserve(op), receipt);
    assert.equal(f.budget.reserve(f.admit("two")), undefined);
    const balance = f.budget.listGrants("default", "default")[0]!;
    assert.equal(balance.heldRequests, 2);
    assert.equal(balance.availableRequests, 0);
    assert.equal(balance.heldCostMicrousd, 16_784);
    assert.throws(
      () => f.db.prepare("UPDATE remote_worker_budget_reservations SET reserved_cost_microusd = 0").run(),
      /immutable/u,
    );
    assert.throws(() => f.db.prepare("DELETE FROM remote_worker_budget_reservations").run(), /cannot be deleted/u);
  });

  it("rejects unknown pricing and insufficient money without consuming a reservation", () => {
    const f = fixture("pricing");
    f.budget.createGrant({ ...f.grant, maxCostMicrousd: 1 }, "operator-a");
    assert.equal(f.budget.reserve(f.admit("insufficient")), undefined);
    const { pricingCatalogHash: _hash, ...unpricedRoute } = f.route;
    assert.throws(() => f.budget.reserve(f.admit("unknown", unpricedRoute)), /pinned pricing/u);
    assert.equal(f.budget.listGrants("default", "default")[0]!.heldRequests, 0);
  });

  it("selects only matching grants and preserves the selected grant across replay and revocation", () => {
    const f = fixture("selection");
    const first = f.admit("first");
    f.budget.createGrant({ ...f.grant, grantId: "foreign-worker", workerId: "another-worker" }, "operator-a");
    expectNoGrant();
    f.budget.createGrant({ ...f.grant, grantId: "later" }, "operator-a");
    f.budget.createGrant(
      { ...f.grant, grantId: "earlier", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      "operator-a",
    );
    const reservation = f.budget.reserveForWorker(first)!;
    assert.ok(reservation);
    assert.equal(
      f.budget.listGrants("default", "default").find((item) => item.grant.grantId === "earlier")!.heldRequests,
      2,
    );
    f.budget.revokeGrant("earlier", 1);
    assert.deepEqual(f.budget.reserveForWorker(first), reservation);
    assert.ok(f.budget.reserveForWorker(f.admit("second")));
    assert.equal(f.budget.reserveForWorker(f.admit("third")), undefined);
    function expectNoGrant() {
      assert.equal(f.budget.reserveForWorker(first), undefined);
    }
  });

  it("revokes dispatch without refunding held or uncertain work", () => {
    const f = fixture("revoke");
    f.budget.createGrant(f.grant, "operator-a");
    const receipt = f.budget.reserve(f.admit("one"))!;
    f.budget.assertDispatchAllowed(receipt);
    assert.throws(() => f.budget.revokeGrant(f.grant.grantId, 9), /revision changed/u);
    const revoked = f.budget.revokeGrant(f.grant.grantId, 1);
    assert.deepEqual(f.budget.revokeGrant(f.grant.grantId, 1), revoked);
    assert.throws(() => f.budget.assertDispatchAllowed(receipt), /expired or was revoked/u);
    assert.equal(f.budget.listGrants("default", "default")[0]!.heldRequests, 2);
  });

  it("only releases an exact canonical blocked-before-dispatch intent, once", () => {
    const f = fixture("release");
    f.budget.createGrant(f.grant, "operator-a");
    const op = f.admit("one");
    const receipt = f.budget.reserve(op)!;
    f.repo.recordBudgetReservation(op.key, receipt, f.now);
    const input = { reservation: receipt, reason: "pre_dispatch_authority_lost" as const };
    assert.throws(() => f.budget.release(input), /proof of no dispatch/u);
    f.repo.recordBudgetReleaseIntent(op.key, { reason: input.reason, blockReason: "cancelled", now: f.now });
    f.budget.release(input);
    new RemoteWorkerBudgetRepository(f.db).release(input);
    assert.equal(f.budget.listGrants("default", "default")[0]!.availableRequests, 2);
    assert.throws(
      () => f.db.prepare("UPDATE remote_worker_budget_reservations SET status = 'held'").run(),
      /immutable/u,
    );
  });

  for (const usageCase of ["priced", "unknown", "wrong-scope", "missing-attempt"] as const) {
    it(`settles from complete canonical usage: ${usageCase}`, () => {
      const f = fixture(usageCase);
      f.budget.createGrant(f.grant, "operator-a");
      const op = f.admit("one");
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
      const usage = new ModelUsageEventRepository(f.db);
      const begin = (id: string, index: number) => {
        usage.begin({
          eventId: id,
          idempotencyKey: id,
          source: "manual_test",
          callKind: "delegation_worker",
          operationId: op.operation.operationId,
          dispatchGeneration: op.operation.dispatchGeneration,
          attemptIndex: index,
          transportAttemptIndex: index,
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
          workerId: usageCase === "wrong-scope" ? "other-worker" : f.workerId,
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
        if (usageCase === "wrong-scope")
          assert.throws(() => f.budget.authorizeAttempt(receipt, id), /different authority/u);
        else f.budget.authorizeAttempt(receipt, id);
        usage.acceptTransport(id, "fixture-owner", f.expiresAt);
        assert.throws(() => f.budget.authorizeAttempt(receipt, id), /does not authorize/u);
        usage.finalize(id, {
          dispatchOwnerId: "fixture-owner",
          terminalOutcome: "succeeded",
          availability: usageCase === "unknown" ? "unknown" : "tracked",
          pricingSource: usageCase === "unknown" ? "not_available" : "gateway_estimate",
          costSource: usageCase === "unknown" ? "not_available" : "gateway_estimate",
          ...(usageCase === "unknown" ? {} : { costUsd: 0.000_012, inputTokens: 10, outputTokens: 1 }),
          finishedAt: f.now,
          durationMs: 0,
        });
      };
      begin("usage-one", 0);
      if (usageCase === "missing-attempt") begin("usage-two", 1);
      f.repo.finalizeTerminal({
        ...op.key,
        dispatchClaimOwner: "fixture-owner",
        terminalState: "completed",
        usageEventIds: ["usage-one"],
        now: f.now,
      });
      const settlement = { reservation: receipt, usageEventIds: ["usage-one"] };
      if (usageCase === "priced") {
        f.budget.settle(settlement);
        f.budget.settle(settlement);
        const balance = f.budget.listGrants("default", "default")[0]!;
        assert.equal(balance.settledRequests, 1);
        assert.equal(balance.settledCostMicrousd, 12);
        assert.equal(balance.availableRequests, 1);
        assert.equal(balance.heldRequests, 0);
        assert.throws(() => f.budget.settle({ ...settlement, usageEventIds: ["forged"] }), /evidence mismatch/u);
      } else {
        assert.throws(() => f.budget.settle(settlement), /uncertain|different authority|inventory is incomplete/u);
        assert.equal(f.budget.listGrants("default", "default")[0]!.heldRequests, 2);
      }
    });
  }
});
