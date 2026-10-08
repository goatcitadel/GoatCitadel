import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryQmdRunRepository } from "./memory-qmd-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): MemoryQmdRunRepository {
  const dbPath = tempDbs.path("goatcitadel-memory-run");
  const db = tempDbs.open({ dbPath });
  return new MemoryQmdRunRepository(db);
}

describe("MemoryQmdRunRepository", () => {
  it("stores run records and computes aggregate stats", () => {
    const repo = createRepo();
    repo.append({
      scope: "chat",
      status: "generated",
      durationMs: 150,
      candidateCount: 12,
      citationsCount: 4,
      originalTokenEstimate: 1000,
      distilledTokenEstimate: 450,
      savingsPercent: 55,
      createdAt: "2026-02-28T10:00:00.000Z",
    });
    repo.append({
      scope: "chat",
      status: "cache_hit",
      durationMs: 10,
      candidateCount: 12,
      citationsCount: 4,
      originalTokenEstimate: 1000,
      distilledTokenEstimate: 450,
      savingsPercent: 55,
      createdAt: "2026-02-28T10:30:00.000Z",
    });

    const stats = repo.stats("2026-02-28T00:00:00.000Z", "2026-02-28T23:59:59.999Z");
    assert.equal(stats.totalRuns, 2);
    assert.equal(stats.generatedRuns, 1);
    assert.equal(stats.cacheHitRuns, 1);
    assert.equal(stats.originalTokenEstimate, 2000);
    assert.equal(stats.distilledTokenEstimate, 900);
    assert.equal(stats.savingsPercent, 55);
    assert.equal(stats.netTokenDelta, -1100);
    assert.equal(stats.compressionPercent, 55);
    assert.equal(stats.expansionPercent, 0);
    assert.equal(stats.efficiencyLabel, "reduced");
  });

  it("reports expansion metrics when distilled context grows", () => {
    const repo = createRepo();
    repo.append({
      scope: "chat",
      status: "generated",
      durationMs: 120,
      candidateCount: 8,
      citationsCount: 3,
      originalTokenEstimate: 500,
      distilledTokenEstimate: 650,
      savingsPercent: -30,
      createdAt: "2026-02-28T11:00:00.000Z",
    });

    const stats = repo.stats("2026-02-28T00:00:00.000Z", "2026-02-28T23:59:59.999Z");
    assert.equal(stats.netTokenDelta, 150);
    assert.equal(stats.compressionPercent, 0);
    assert.equal(stats.expansionPercent, 30);
    assert.equal(stats.efficiencyLabel, "expanded");
  });

  it("prunes old run rows", () => {
    const repo = createRepo();
    repo.append({
      scope: "chat",
      status: "generated",
      durationMs: 100,
      candidateCount: 5,
      citationsCount: 2,
      originalTokenEstimate: 500,
      distilledTokenEstimate: 300,
      savingsPercent: 40,
      createdAt: "2026-02-01T10:00:00.000Z",
    });
    repo.append({
      scope: "chat",
      status: "generated",
      durationMs: 90,
      candidateCount: 4,
      citationsCount: 2,
      originalTokenEstimate: 400,
      distilledTokenEstimate: 260,
      savingsPercent: 35,
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const removed = repo.pruneOlderThan("2026-02-15T00:00:00.000Z");
    assert.equal(removed, 1);

    const remaining = repo.list(10);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.createdAt, "2026-03-01T10:00:00.000Z");
  });
});
