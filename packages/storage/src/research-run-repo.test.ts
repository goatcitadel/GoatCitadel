import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ResearchRunRepository } from "./research-run-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ResearchRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-research-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ResearchRunRepository(db) };
}

function setRawField(db: DatabaseClient, runId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE research_runs SET ${field} = ? WHERE run_id = ?`).run(value, runId);
}

describe("ResearchRunRepository", () => {
  it("creates, patches, clamps list limits, and maps optional fields", () => {
    const { repo } = createStore();
    const first = repo.create({
      runId: "run-a",
      sessionId: "session-a",
      query: "local-first ai",
      mode: "deep",
      summary: "started",
      startedAt: "2026-03-26T00:00:01.000Z",
    });
    const second = repo.create({
      runId: "run-b",
      sessionId: "session-a",
      query: "providers",
      mode: "quick",
      status: "completed",
      summary: "done",
      error: "none",
      startedAt: "2026-03-26T00:00:02.000Z",
      finishedAt: "2026-03-26T00:00:03.000Z",
    });

    assert.equal(first.status, "running");
    assert.equal(first.finishedAt, undefined);
    assert.equal(second.error, "none");

    const patched = repo.patch("run-a", {
      status: "failed",
      error: "network unavailable",
      finishedAt: "2026-03-26T00:00:04.000Z",
    });
    assert.equal(patched.status, "failed");
    assert.equal(patched.summary, "started");
    assert.equal(patched.error, "network unavailable");

    const preserved = repo.patch("run-a", {});
    assert.equal(preserved.status, "failed");
    assert.equal(preserved.finishedAt, "2026-03-26T00:00:04.000Z");

    assert.deepEqual(
      repo.listBySession("session-a", 0).map((run) => run.runId),
      ["run-b"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 5000).map((run) => run.runId),
      ["run-b", "run-a"],
    );
    assert.throws(() => repo.get("missing-run"), /Research run missing-run not found/);
    assert.throws(() => repo.patch("missing-run", { status: "failed" }), /Research run missing-run not found/);
  });

  it("filters malformed stored rows", () => {
    const { db, repo } = createStore();
    repo.create({
      runId: "run-a",
      sessionId: "session-a",
      query: "coverage",
      mode: "quick",
      startedAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "run-a", "mode", "invalid");
    assert.throws(() => repo.get("run-a"), /Research run run-a not found/);
    assert.deepEqual(repo.listBySession("session-a"), []);

    setRawField(db, "run-a", "mode", "quick");
    setRawField(db, "run-a", "status", "invalid");
    assert.throws(() => repo.get("run-a"), /Research run run-a not found/);
    assert.deepEqual(repo.listBySession("session-a"), []);
  });
});
