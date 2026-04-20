import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): MutationIdempotencyRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-mutation-idempotency-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new MutationIdempotencyRepository(db);
}

describe("MutationIdempotencyRepository", () => {
  it("claims new mutations, blocks duplicates, and allows retries after failure", () => {
    const repo = createRepo();
    const input = {
      method: "POST",
      routePath: "/api/v1/tools/invoke",
      idempotencyKey: "idem-1",
      actorScope: "operator:test",
      payloadHash: "hash-1",
      now: "2026-04-19T00:00:00.000Z",
    };

    const claimed = repo.claim(input);
    assert.equal(claimed.outcome, "claimed");
    assert.equal(claimed.record.status, "pending");

    const inProgress = repo.claim(input);
    assert.equal(inProgress.outcome, "in_progress");

    repo.markCompleted(input);
    const duplicate = repo.claim(input);
    assert.equal(duplicate.outcome, "duplicate");

    repo.markFailed(input);
    const retried = repo.claim({
      ...input,
      now: "2026-04-19T00:00:10.000Z",
    });
    assert.equal(retried.outcome, "claimed");
    assert.equal(retried.record.status, "pending");
  });

  it("rejects reused keys when the payload hash changes", () => {
    const repo = createRepo();
    const input = {
      method: "PATCH",
      routePath: "/api/v1/approvals/apr-1/resolve",
      idempotencyKey: "idem-2",
      actorScope: "",
      payloadHash: "hash-a",
      now: "2026-04-19T00:00:00.000Z",
    };

    assert.equal(repo.claim(input).outcome, "claimed");
    const mismatch = repo.claim({
      ...input,
      payloadHash: "hash-b",
      now: "2026-04-19T00:00:01.000Z",
    });

    assert.equal(mismatch.outcome, "payload_mismatch");
    assert.equal(mismatch.record.payloadHash, "hash-a");
  });
});
