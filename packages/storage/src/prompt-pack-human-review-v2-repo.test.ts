import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PromptPackHumanReviewRecordV2 } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { PromptPackHumanReviewV2Repository } from "./prompt-pack-human-review-v2-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: PromptPackHumanReviewV2Repository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-human-review-v2-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new PromptPackHumanReviewV2Repository(db) };
}

function review(overrides: Partial<PromptPackHumanReviewRecordV2> = {}): PromptPackHumanReviewRecordV2 {
  return {
    reviewId: "review-a",
    packId: "pack-a",
    testId: "test-a",
    runId: "run-a",
    autoScoreId: "score-a",
    reviewerId: "operator",
    scores: { taskSuccess: 4, honesty: 3 },
    applicability: { taskSuccess: true, robustness: false },
    notes: "Looks good",
    overrideVerdict: "pass",
    createdAt: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

function createListRowsRepo(rows: unknown): PromptPackHumanReviewV2Repository {
  const listStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => rows as never[],
  };
  const noopStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => [],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare(sql) {
      return sql.includes("ORDER BY created_at DESC") ? listStatement : noopStatement;
    },
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
  return new PromptPackHumanReviewV2Repository(db);
}

describe("PromptPackHumanReviewV2Repository", () => {
  it("creates, reads, lists, and deletes human reviews", () => {
    const { repo } = createStore();
    const first = repo.create(review());
    const second = repo.create(
      review({
        reviewId: "review-b",
        autoScoreId: undefined,
        notes: undefined,
        overrideVerdict: undefined,
        createdAt: "2026-03-26T00:01:00.000Z",
      }),
    );
    repo.create(
      review({
        reviewId: "review-c",
        packId: "pack-b",
        testId: "test-b",
        runId: "run-b",
        createdAt: "2026-03-26T00:02:00.000Z",
      }),
    );

    assert.equal(first.autoScoreId, "score-a");
    assert.equal(first.overrideVerdict, "pass");
    assert.equal(second.autoScoreId, undefined);
    assert.equal(second.notes, undefined);
    assert.equal(second.overrideVerdict, undefined);
    assert.deepEqual(
      repo.listByPack("pack-a", 0).map((item) => item.reviewId),
      ["review-b"],
    );
    assert.deepEqual(
      repo.listByPack("pack-a", 10_001).map((item) => item.reviewId),
      ["review-b", "review-a"],
    );
    assert.deepEqual(
      repo.listByTest("test-a", 10).map((item) => item.reviewId),
      ["review-b", "review-a"],
    );
    assert.deepEqual(
      repo.listByRun("run-a", 10).map((item) => item.reviewId),
      ["review-b", "review-a"],
    );
    assert.equal(repo.get("review-a").reviewerId, "operator");
    assert.equal(repo.deleteByPack("pack-a"), 2);
    assert.equal(repo.deleteByPack("pack-a"), 0);
    assert.deepEqual(repo.listByPack("pack-a"), []);
  });

  it("handles missing, malformed, and non-row review data", () => {
    const { db, repo } = createStore();
    repo.create(review());

    assert.throws(() => repo.get("missing-review"), /Prompt pack human review missing-review not found/);

    db.prepare("UPDATE prompt_pack_human_reviews_v2 SET record_json = ? WHERE review_id = ?").run(
      "{bad json",
      "review-a",
    );
    assert.throws(() => repo.get("review-a"), /Stored prompt pack human review review-a is malformed/);

    assert.deepEqual(createListRowsRepo("not rows").listByPack("pack-a"), []);
    assert.deepEqual(createListRowsRepo([null]).listByPack("pack-a"), []);
  });
});
