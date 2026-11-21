import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { CostLedgerRepository } from "./cost-ledger-repo.js";
import { BackgroundLearningBudgetRepository } from "./background-learning-budget-repo.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const budget = {
  providerId: "openai",
  model: "fixture",
  pricingCatalogVersion: "fixture",
  pricingCatalogHash: "b".repeat(64),
  reservedCostUsd: 0.6,
  dailyCostCeilingUsd: 1,
};
function fixture() {
  const db = files.open({ dbPath: files.path("learning-budget") });
  const settings = new SystemSettingsRepository(db);
  return { settings, repo: new BackgroundLearningBudgetRepository(settings, new CostLedgerRepository(db)) };
}
it("releases only unused settled headroom and settles each operation once", () => {
  const f = fixture(),
    now = "2026-11-19T12:00:00.000Z";
  const day = f.repo.reserve("job", "one", budget, now);
  f.repo.settle("job", "one", day, "settled", 0.2);
  f.repo.settle("job", "one", day, "settled", 0.2);
  f.repo.reserve("job", "two", budget, now);
  assert.throws(() => f.repo.reserve("other", "three", { ...budget, reservedCostUsd: 0.3 }, now));
  f.repo.settle("job", "two", day, "not_started", undefined);
  f.repo.reserve("other", "three", { ...budget, reservedCostUsd: 0.8 }, now);
});
it("retains unknown and foreign-owned reservations and carries an observed overrun as debt", () => {
  const f = fixture(),
    now = "2026-11-19T12:00:00.000Z";
  const day = f.repo.reserve("job", "one", budget, now);
  f.repo.settle("job", "one", day, "unknown", undefined);
  assert.throws(() => f.repo.reserve("other", "two", budget, now));
  assert.throws(() => f.repo.settle("other", "one", day, "settled", 0));
  assert.throws(() => f.repo.settle("job", "one", day, "settled", undefined));
  f.repo.settle("job", "one", day, "settled", 1.1);
  assert.throws(() => f.repo.reserve("other", "two", { ...budget, reservedCostUsd: 0 }, now));
  f.repo.reserve("other", "next-day", budget, "2026-11-20T00:00:00.001Z");
  assert.equal(f.settings.get<{ spentUsd: number }>(`background_learning_budget_v1:${day}`)?.value.spentUsd, 1.1);
});
