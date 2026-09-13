import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { relatedWorkerBudgetFixture, verifyRelatedWorkerBudgets } from "./remote-worker-budget-related-fixture.js";

const clients: DatabaseClient[] = [];
afterEach(() => {
  for (const db of clients.splice(0)) db.close();
});
function database() {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  return db;
}

it("counts independent utility operations and retries in the parent grant and reconciles after restart", () => {
  verifyRelatedWorkerBudgets(database(), "related-sqlite");
});

it("rejects unrelated operation, workspace, worker, context and price bindings before reservation", () => {
  const f = relatedWorkerBudgetFixture(database(), "related-scope");
  const changed = [
    { parentOperationId: "unrelated" },
    { operationId: f.op.operation.operationId },
    { workspaceId: "foreign" },
    { workerId: "foreign" },
    { turnId: "foreign" },
    { durableRunId: "foreign" },
    { contextIntentHash: "0".repeat(64) },
    { inputRateUsdPerMillion: 0 },
  ];
  changed.forEach((overrides, index) => {
    assert.throws(() => f.budget.authorizeRelatedAttempt(f.begin(String(index), overrides)), /different authority/u);
  });
  assert.equal(f.balance().heldRequests, 2);
  assert.deepEqual(f.budget.listRelatedAttempts(f.reservation), []);
});

it("checks money, current usage intent, and pricing before an auxiliary request can dispatch", () => {
  const f = relatedWorkerBudgetFixture(database(), "related-cost");
  const oversized = f.begin("cost", { requestedOutputTokenCap: 1_000_000, effectiveOutputTokenCap: 1_000_000 });
  assert.throws(() => f.budget.authorizeRelatedAttempt(oversized), /insufficient capacity/u);
  const unavailable = {
    pricingCatalogHash: undefined,
    pricingCatalogVersion: undefined,
    inputRateUsdPerMillion: undefined,
    outputRateUsdPerMillion: undefined,
    cachedInputRateUsdPerMillion: undefined,
  };
  const unpriced = f.begin("unpriced", unavailable);
  assert.throws(
    () => f.budget.authorizeRelatedAttempt({ ...unpriced, route: { ...f.route, ...unavailable } }),
    /pinned pricing/u,
  );
  const accepted = f.begin("already-sent");
  f.usage.acceptTransport(accepted.usageEventId, "related-owner", f.expiresAt);
  assert.throws(() => f.budget.authorizeRelatedAttempt(accepted), /current canonical/u);
  assert.equal(f.balance().heldRequests, 2);
});
