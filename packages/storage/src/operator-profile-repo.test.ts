import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import {
  createOperatorProfileId,
  OperatorProfileRepository,
  type OperatorProfileUpsertInput,
} from "./operator-profile-repo.js";

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

function createRepo(): OperatorProfileRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-operator-profile-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new OperatorProfileRepository(db);
}

function baseInput(overrides: Partial<OperatorProfileUpsertInput> = {}): OperatorProfileUpsertInput {
  return {
    operatorProfileId: "op_fixed",
    workspaceId: "default",
    summary: "Operator prefers terse, source-grounded answers.",
    facts: [{ kind: "preference", content: "Prefers metric units.", confidence: 0.9 }],
    ...overrides,
  };
}

describe("OperatorProfileRepository", () => {
  it("creates at revision 1 and round-trips by id and by workspace", () => {
    const repo = createRepo();
    const created = repo.upsert(baseInput());
    assert.equal(created.revision, 1);
    assert.equal(created.operatorProfileId, "op_fixed");
    assert.equal(created.createdAt, created.updatedAt);

    assert.deepEqual(repo.get("op_fixed"), created);
    assert.deepEqual(repo.getByWorkspace("default"), created);
    assert.equal(repo.get("missing"), undefined);
    assert.equal(repo.getByWorkspace("other"), undefined);
  });

  it("bumps revision on each upsert and preserves createdAt", () => {
    const repo = createRepo();
    const first = repo.upsert(baseInput(), "2026-06-22T00:00:00.000Z");
    const second = repo.upsert(
      baseInput({ summary: "Updated summary.", facts: [{ kind: "goal", content: "Ship v1.", confidence: 0.8 }] }),
      "2026-06-22T01:00:00.000Z",
    );
    assert.equal(second.revision, 2);
    assert.equal(second.summary, "Updated summary.");
    assert.equal(second.facts[0]?.kind, "goal");
    assert.equal(second.createdAt, first.createdAt);
    assert.notEqual(second.updatedAt, first.updatedAt);
  });

  it("captures the prior snapshot and restores it (rollback), re-bumping revision", () => {
    const repo = createRepo();
    repo.upsert(baseInput()); // revision 1
    const write = repo.upsertCapturingPrior(
      baseInput({ summary: "v2 summary", facts: [{ kind: "constraint", content: "Never email vendors.", confidence: 1 }] }),
    );
    assert.equal(write.record.revision, 2);
    assert.ok(write.priorSnapshot, "expected a prior snapshot on the second write");
    assert.equal(write.priorSnapshot?.revision, 1);
    assert.equal(write.priorSnapshot?.summary, baseInput().summary);

    // Restore the captured snapshot — content reverts, revision advances.
    const restored = repo.restore(write.priorSnapshot!);
    assert.equal(restored.revision, 3);
    assert.equal(restored.summary, baseInput().summary);
    assert.equal(restored.facts[0]?.content, "Prefers metric units.");
  });

  it("omits priorSnapshot on first creation", () => {
    const repo = createRepo();
    const write = repo.upsertCapturingPrior(baseInput());
    assert.equal(write.priorSnapshot, undefined);
    assert.equal(write.record.revision, 1);
  });

  it("drops malformed facts and clamps confidence on persist", () => {
    const repo = createRepo();
    const stored = repo.upsert(
      baseInput({
        facts: [
          { kind: "preference", content: "Valid.", confidence: 5 },
          { kind: "bogus" as never, content: "Bad kind.", confidence: 0.5 },
          { kind: "fact", content: "   ", confidence: 0.5 },
          { kind: "goal", content: "Has source.", confidence: -2, sourceRef: "item-1" },
        ],
      }),
    );
    assert.equal(stored.facts.length, 2);
    assert.equal(stored.facts[0]?.confidence, 1); // clamped from 5
    assert.equal(stored.facts[1]?.confidence, 0); // clamped from -2
    assert.equal(stored.facts[1]?.sourceRef, "item-1");
  });

  it("issues unique-looking ids with the op_ prefix", () => {
    const a = createOperatorProfileId();
    const b = createOperatorProfileId();
    assert.match(a, /^op_[a-f0-9]+$/);
    assert.notEqual(a, b);
  });
});
