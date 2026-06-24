import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { AgentCommitmentRepository, type AgentCommitmentUpsertInput } from "./agent-commitment-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): AgentCommitmentRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-agent-commitments-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new AgentCommitmentRepository(db);
}

function baseInput(overrides: Partial<AgentCommitmentUpsertInput> = {}): AgentCommitmentUpsertInput {
  return {
    commitmentId: `commit-${randomUUID()}`,
    sessionId: "session-1",
    workspaceId: "default",
    kind: "follow_up",
    dueAt: "2026-07-01T09:00:00.000Z",
    confidence: 0.82,
    dedupeKey: "interview-followup",
    suggestedText: "How did the interview go?",
    ...overrides,
  };
}

describe("AgentCommitmentRepository", () => {
  it("inserts a commitment and reads it back", () => {
    const repo = createRepo();
    const created = repo.upsertByDedupe(baseInput({ commitmentId: "c1" }), "2026-06-22T00:00:00.000Z");

    assert.equal(created.commitmentId, "c1");
    assert.equal(created.status, "pending");
    assert.equal(created.createdBy, "classifier");
    assert.equal(created.createdAt, "2026-06-22T00:00:00.000Z");
    assert.equal(created.sentAt, undefined);

    const fetched = repo.get("c1");
    assert.ok(fetched);
    assert.equal(fetched.suggestedText, "How did the interview go?");
  });

  it("dedupes on (session_id, dedupe_key): second upsert updates, does not duplicate", () => {
    const repo = createRepo();
    repo.upsertByDedupe(
      baseInput({ commitmentId: "c1", confidence: 0.71, suggestedText: "v1", dueAt: "2026-07-01T09:00:00.000Z" }),
    );

    const second = repo.upsertByDedupe(
      baseInput({
        commitmentId: "c2", // different id, same (session, dedupe)
        confidence: 0.95,
        suggestedText: "v2-refined",
        dueAt: "2026-07-02T09:00:00.000Z",
        kind: "deadline",
      }),
    );

    // Only one row exists for this session, and it kept the ORIGINAL id.
    const all = repo.listBySession("session-1");
    assert.equal(all.length, 1);
    assert.equal(all[0]?.commitmentId, "c1");
    // The conflicting upsert never created c2.
    assert.equal(repo.get("c2"), undefined);
    // Inferred fields were refreshed by the second classification.
    assert.equal(second.commitmentId, "c1");
    assert.equal(second.confidence, 0.95);
    assert.equal(second.suggestedText, "v2-refined");
    assert.equal(second.dueAt, "2026-07-02T09:00:00.000Z");
    assert.equal(second.kind, "deadline");
  });

  it("dedup updates preserve lifecycle (a sent row is not reset to pending)", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1" }));
    assert.equal(repo.markSent("c1", "2026-06-22T10:00:00.000Z"), true);

    const reupsert = repo.upsertByDedupe(baseInput({ commitmentId: "c1", suggestedText: "refined" }));
    assert.equal(reupsert.status, "sent");
    assert.equal(reupsert.sentAt, "2026-06-22T10:00:00.000Z");
    assert.equal(reupsert.suggestedText, "refined");
  });

  it("dedup updates preserve lifecycle (a delivery-pending row is not reset to pending)", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1" }));
    assert.equal(repo.markDeliveryPending("c1"), true);

    const reupsert = repo.upsertByDedupe(baseInput({ commitmentId: "c1", suggestedText: "refined" }));
    assert.equal(reupsert.status, "delivery_pending");
    assert.equal(reupsert.sentAt, undefined);
    assert.equal(reupsert.suggestedText, "refined");
  });

  it("dedup updates preserve lifecycle (a delivery-failed row is not reset to pending)", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1" }));
    assert.equal(repo.markDeliveryFailed("c1"), true);

    const reupsert = repo.upsertByDedupe(baseInput({ commitmentId: "c1", suggestedText: "refined" }));
    assert.equal(reupsert.status, "delivery_failed");
    assert.equal(reupsert.sentAt, undefined);
    assert.equal(reupsert.suggestedText, "refined");
  });

  it("listDue returns only pending + due rows, oldest-due first, bounded by limit", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "due-late", dedupeKey: "k1", dueAt: "2026-06-22T08:00:00.000Z" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "due-early", dedupeKey: "k2", dueAt: "2026-06-22T06:00:00.000Z" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "future", dedupeKey: "k3", dueAt: "2026-12-31T00:00:00.000Z" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "sent-due", dedupeKey: "k4", dueAt: "2026-06-22T05:00:00.000Z" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "queued-due", dedupeKey: "k5", dueAt: "2026-06-22T05:30:00.000Z" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "failed-due", dedupeKey: "k6", dueAt: "2026-06-22T05:45:00.000Z" }));
    repo.markSent("sent-due");
    repo.markDeliveryPending("queued-due");
    repo.markDeliveryFailed("failed-due");

    const due = repo.listDue("2026-06-22T09:00:00.000Z");
    assert.deepEqual(
      due.map((item) => item.commitmentId),
      ["due-early", "due-late"],
    );

    const limited = repo.listDue("2026-06-22T09:00:00.000Z", 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.commitmentId, "due-early");
  });

  it("markSent transitions pending → sent once and is idempotent thereafter", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1" }));

    assert.equal(repo.markSent("c1", "2026-06-22T10:00:00.000Z"), true);
    const sent = repo.get("c1");
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.sentAt, "2026-06-22T10:00:00.000Z");

    // Second call no-ops (already sent) — returns false.
    assert.equal(repo.markSent("c1", "2026-06-22T11:00:00.000Z"), false);
    assert.equal(repo.get("c1")?.sentAt, "2026-06-22T10:00:00.000Z");
  });

  it("markDeliveryPending transitions pending rows without setting sentAt", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1", dueAt: "2026-06-22T05:00:00.000Z" }));

    assert.equal(repo.markDeliveryPending("c1"), true);
    const queued = repo.get("c1");
    assert.equal(queued?.status, "delivery_pending");
    assert.equal(queued?.sentAt, undefined);
    assert.deepEqual(repo.listDue("2026-06-22T09:00:00.000Z"), []);

    assert.equal(repo.markDeliveryPending("c1"), false);
  });

  it("markDeliveryFailed transitions pending and delivery-pending rows", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "pending-failure", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "queued-failure", dedupeKey: "k2" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "sent-row", dedupeKey: "k3" }));
    repo.markDeliveryPending("queued-failure");
    repo.markSent("sent-row");

    assert.equal(repo.markDeliveryFailed("pending-failure"), true);
    assert.equal(repo.markDeliveryFailed("queued-failure"), true);
    assert.equal(repo.get("pending-failure")?.status, "delivery_failed");
    assert.equal(repo.get("queued-failure")?.status, "delivery_failed");
    assert.equal(repo.markDeliveryFailed("pending-failure"), false);
    assert.equal(repo.markDeliveryFailed("sent-row"), false);
    assert.equal(repo.get("sent-row")?.status, "sent");
  });

  it("markSent can confirm a delivery-pending commitment", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1" }));
    repo.markDeliveryPending("c1");

    assert.equal(repo.markSent("c1", "2026-06-22T10:00:00.000Z"), true);
    const sent = repo.get("c1");
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.sentAt, "2026-06-22T10:00:00.000Z");
  });

  it("markSuperseded transitions only pending rows and excludes them from listDue", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1", dueAt: "2026-06-22T05:00:00.000Z" }));

    assert.equal(repo.markSuperseded("c1"), true);
    assert.equal(repo.get("c1")?.status, "superseded");
    assert.deepEqual(repo.listDue("2026-06-22T09:00:00.000Z"), []);

    // Cannot supersede again (no longer pending).
    assert.equal(repo.markSuperseded("c1"), false);
  });

  it("scopes rows by session in listBySession", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "a", sessionId: "session-1", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "b", sessionId: "session-2", dedupeKey: "k1" }));

    const s1 = repo.listBySession("session-1");
    assert.equal(s1.length, 1);
    assert.equal(s1[0]?.commitmentId, "a");
  });

  it("hasOpenBySession is false when the session has no commitments at all", () => {
    const repo = createRepo();
    assert.equal(repo.hasOpenBySession("session-1"), false);
  });

  it("hasOpenBySession is true when at least one pending commitment exists for the session", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1", sessionId: "session-1", dedupeKey: "k1" }));
    assert.equal(repo.hasOpenBySession("session-1"), true);
  });

  it("hasOpenBySession is false when the session's only commitment is non-pending", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "c1", sessionId: "session-1", dedupeKey: "k1" }));
    repo.markSent("c1");
    assert.equal(repo.hasOpenBySession("session-1"), false);
  });

  it("hasOpenBySession scopes by session (a pending row in another session does not leak)", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "other", sessionId: "session-2", dedupeKey: "k1" }));
    assert.equal(repo.hasOpenBySession("session-1"), false);
    assert.equal(repo.hasOpenBySession("session-2"), true);
  });

  it("hasOpenBySession is true when a pending row coexists with sent/superseded/failed rows", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "sent", sessionId: "session-1", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "superseded", sessionId: "session-1", dedupeKey: "k2" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "failed", sessionId: "session-1", dedupeKey: "k3" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "pending", sessionId: "session-1", dedupeKey: "k4" }));
    repo.markSent("sent");
    repo.markSuperseded("superseded");
    repo.markDeliveryFailed("failed");
    assert.equal(repo.hasOpenBySession("session-1"), true);
  });

  it("hasOpenBySession is false once every pending row is transitioned away", () => {
    const repo = createRepo();
    repo.upsertByDedupe(baseInput({ commitmentId: "a", sessionId: "session-1", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "b", sessionId: "session-1", dedupeKey: "k2" }));
    assert.equal(repo.hasOpenBySession("session-1"), true);
    repo.markSent("a");
    repo.markDeliveryPending("b");
    // delivery_pending is NOT "pending" — gate must agree with listBySession(...).some(pending).
    assert.equal(repo.hasOpenBySession("session-1"), false);
  });

  it("hasOpenBySession matches listBySession(...).some(status === pending) across fixtures", () => {
    // Equivalence proof: the existence query must return the IDENTICAL boolean the
    // hot-path predicate used to compute via listBySession(sessionId, limit).some(...).
    const repo = createRepo();
    const isOpen = (status: string): boolean => status === "pending";
    const sessionsUnderTest = ["s-empty", "s-pending", "s-sent", "s-mixed", "s-all-closed"];

    // s-empty: nothing inserted.
    // s-pending: one pending row.
    repo.upsertByDedupe(baseInput({ commitmentId: "p1", sessionId: "s-pending", dedupeKey: "k1" }));
    // s-sent: one row, sent.
    repo.upsertByDedupe(baseInput({ commitmentId: "s1", sessionId: "s-sent", dedupeKey: "k1" }));
    repo.markSent("s1");
    // s-mixed: sent + delivery_pending + pending.
    repo.upsertByDedupe(baseInput({ commitmentId: "m1", sessionId: "s-mixed", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "m2", sessionId: "s-mixed", dedupeKey: "k2" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "m3", sessionId: "s-mixed", dedupeKey: "k3" }));
    repo.markSent("m1");
    repo.markDeliveryPending("m2");
    // m3 stays pending.
    // s-all-closed: sent + superseded + delivery_failed (no pending).
    repo.upsertByDedupe(baseInput({ commitmentId: "a1", sessionId: "s-all-closed", dedupeKey: "k1" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "a2", sessionId: "s-all-closed", dedupeKey: "k2" }));
    repo.upsertByDedupe(baseInput({ commitmentId: "a3", sessionId: "s-all-closed", dedupeKey: "k3" }));
    repo.markSent("a1");
    repo.markSuperseded("a2");
    repo.markDeliveryFailed("a3");

    for (const sessionId of sessionsUnderTest) {
      const viaList = repo.listBySession(sessionId).some((c) => isOpen(c.status));
      assert.equal(
        repo.hasOpenBySession(sessionId),
        viaList,
        `hasOpenBySession disagrees with listBySession(...).some(pending) for ${sessionId}`,
      );
    }
  });
});
