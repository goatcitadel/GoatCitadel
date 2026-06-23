import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AutonomyAuditAppendInput } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { AutonomyAuditRepository, createAutonomyAuditId } from "./autonomy-audit-repo.js";

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

function createRepo(): AutonomyAuditRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-autonomy-audit-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new AutonomyAuditRepository(db);
}

function tuneEntry(overrides: Partial<AutonomyAuditAppendInput> = {}): AutonomyAuditAppendInput {
  return {
    kind: "tune",
    targetKey: "decision.retryThreshold",
    restoreRef: { kind: "tune", tuneId: "tune_1" },
    ...overrides,
  };
}

describe("AutonomyAuditRepository", () => {
  it("appends an entry (un-reverted) and round-trips it by id", () => {
    const repo = createRepo();
    const stored = repo.append(tuneEntry(), "2026-06-22T00:00:00.000Z");
    assert.match(stored.auditId, /^aa_[a-f0-9]+$/);
    assert.equal(stored.kind, "tune");
    assert.equal(stored.targetKey, "decision.retryThreshold");
    assert.equal(stored.occurredAt, "2026-06-22T00:00:00.000Z");
    assert.equal(stored.reverted, false);
    assert.equal(stored.revertedAt, undefined);
    assert.deepEqual(stored.restoreRef, { kind: "tune", tuneId: "tune_1" });

    assert.deepEqual(repo.get(stored.auditId), stored);
    assert.equal(repo.get("missing"), undefined);
  });

  it("preserves a value-carrying restoreRef payload verbatim", () => {
    const repo = createRepo();
    const priorSnapshot = { operatorProfileId: "op_1", summary: "prior", facts: [], revision: 3 };
    const stored = repo.append({
      kind: "operator_profile",
      targetKey: "op_1",
      restoreRef: { kind: "operator_profile", priorSnapshot },
    });
    const loaded = repo.get(stored.auditId);
    assert.deepEqual(loaded?.restoreRef, { kind: "operator_profile", priorSnapshot });
  });

  it("lists only un-reverted entries with occurredAt >= since, newest-first", () => {
    const repo = createRepo();
    repo.append(tuneEntry({ targetKey: "old" }), "2026-06-20T00:00:00.000Z");
    const mid = repo.append(tuneEntry({ targetKey: "mid" }), "2026-06-22T00:00:00.000Z");
    const newest = repo.append(tuneEntry({ targetKey: "newest" }), "2026-06-23T00:00:00.000Z");

    const since = repo.listUnrevertedSince("2026-06-21T00:00:00.000Z");
    assert.deepEqual(
      since.map((e) => e.targetKey),
      ["newest", "mid"],
    );
    // Boundary is inclusive.
    const inclusive = repo.listUnrevertedSince("2026-06-22T00:00:00.000Z");
    assert.deepEqual(
      inclusive.map((e) => e.auditId),
      [newest.auditId, mid.auditId],
    );
  });

  it("bounds listUnrevertedSince by the pushed-down limit, newest-first", () => {
    const repo = createRepo();
    for (let i = 0; i < 5; i += 1) {
      repo.append(tuneEntry({ targetKey: `k${i}` }), `2026-06-22T0${i}:00:00.000Z`);
    }
    const capped = repo.listUnrevertedSince("2026-06-22T00:00:00.000Z", 2);
    assert.equal(capped.length, 2);
    assert.deepEqual(
      capped.map((e) => e.targetKey),
      ["k4", "k3"],
    );
    // A non-positive / non-finite limit falls back to the safe default (all 5 here).
    assert.equal(repo.listUnrevertedSince("2026-06-22T00:00:00.000Z", 0).length, 5);
    assert.equal(repo.listUnrevertedSince("2026-06-22T00:00:00.000Z", Number.NaN).length, 5);
  });

  it("excludes already-reverted entries from listUnrevertedSince", () => {
    const repo = createRepo();
    const a = repo.append(tuneEntry({ targetKey: "a" }), "2026-06-22T00:00:00.000Z");
    repo.append(tuneEntry({ targetKey: "b" }), "2026-06-22T01:00:00.000Z");

    assert.equal(repo.markReverted(a.auditId, "2026-06-22T02:00:00.000Z"), true);
    const since = repo.listUnrevertedSince("2026-06-22T00:00:00.000Z");
    assert.deepEqual(
      since.map((e) => e.targetKey),
      ["b"],
    );

    const reloaded = repo.get(a.auditId);
    assert.equal(reloaded?.reverted, true);
    assert.equal(reloaded?.revertedAt, "2026-06-22T02:00:00.000Z");
  });

  it("markReverted is idempotent (returns false when already reverted or missing)", () => {
    const repo = createRepo();
    const a = repo.append(tuneEntry());
    assert.equal(repo.markReverted(a.auditId), true);
    assert.equal(repo.markReverted(a.auditId), false);
    assert.equal(repo.markReverted("missing"), false);
  });

  it("unmarkReverted rolls back a claim so the entry is un-reverted and retryable", () => {
    const repo = createRepo();
    const a = repo.append(tuneEntry(), "2026-06-22T00:00:00.000Z");
    assert.equal(repo.markReverted(a.auditId, "2026-06-22T01:00:00.000Z"), true);
    // Excluded once reverted.
    assert.equal(repo.listUnrevertedSince("2026-06-22T00:00:00.000Z").length, 0);

    // Roll back the claim.
    assert.equal(repo.unmarkReverted(a.auditId), true);
    const reloaded = repo.get(a.auditId);
    assert.equal(reloaded?.reverted, false);
    assert.equal(reloaded?.revertedAt, undefined);
    // Visible to a retry again.
    assert.deepEqual(
      repo.listUnrevertedSince("2026-06-22T00:00:00.000Z").map((e) => e.targetKey),
      ["decision.retryThreshold"],
    );

    // No-op when not reverted or missing.
    assert.equal(repo.unmarkReverted(a.auditId), false);
    assert.equal(repo.unmarkReverted("missing"), false);
  });

  it("summarizes counts per kind and lists recent newest-first", () => {
    const repo = createRepo();
    const t = repo.append(tuneEntry(), "2026-06-22T00:00:00.000Z");
    repo.append(
      { kind: "curator_archive", targetKey: "skill_x", restoreRef: { kind: "curator_archive", skillId: "skill_x" } },
      "2026-06-22T01:00:00.000Z",
    );
    const newest = repo.append(
      { kind: "curator_archive", targetKey: "skill_y", restoreRef: { kind: "curator_archive", skillId: "skill_y" } },
      "2026-06-22T02:00:00.000Z",
    );
    repo.markReverted(t.auditId);

    const counts = repo.countByKind();
    const tune = counts.find((c) => c.kind === "tune");
    const curator = counts.find((c) => c.kind === "curator_archive");
    assert.equal(tune?.total, 1);
    assert.equal(tune?.reverted, 1);
    assert.equal(curator?.total, 2);
    assert.equal(curator?.reverted, 0);

    const recent = repo.listRecent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.auditId, newest.auditId);
  });

  it("issues unique-looking ids with the aa_ prefix", () => {
    const a = createAutonomyAuditId();
    const b = createAutonomyAuditId();
    assert.match(a, /^aa_[a-f0-9]+$/);
    assert.notEqual(a, b);
  });
});
