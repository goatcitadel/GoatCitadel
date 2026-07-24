import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { SkillLifecycleRepository } from "./skill-lifecycle-repo.js";

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

function createStore(): { db: DatabaseClient; repo: SkillLifecycleRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-lifecycle-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new SkillLifecycleRepository(db) };
}

function setRawField(db: DatabaseClient, skillId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE skill_lifecycle SET ${field} = ? WHERE skill_id = ?`).run(value, skillId);
}

describe("SkillLifecycleRepository", () => {
  it("upserts, finds, gets, and lists lifecycle records", () => {
    const { db, repo } = createStore();
    const base = {
      skillId: "skill-a",
      category: "community_imported" as const,
      lifecycleState: "candidate" as const,
      trustLabel: "Needs review",
      reviewWarning: "Network access declared",
      provenance: {
        source: "marketplace",
        sourceRef: "skill://marketplace/skill-a",
        sourceProvider: "skillsmp",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        contentIntegrity: {
          manifestVersion: "goatcitadel.skill-tree.v1" as const,
          treeSha256: "a".repeat(64),
          fileCount: 2,
          totalBytes: 128,
          verified: true,
        },
      },
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    };

    assert.deepEqual(repo.upsert(base), base);
    assert.deepEqual(repo.get("skill-a"), base);
    assert.deepEqual(repo.find("skill-a"), base);

    setRawField(db, "skill-a", "provenance_json", '{"source":"local","commitSha":"not-a-sha"}');
    assert.deepEqual(repo.get("skill-a").provenance, { source: "local" });
    repo.upsert(base);

    const updated = repo.upsert({
      ...base,
      lifecycleState: "trusted",
      trustLabel: "Trusted",
      reviewWarning: undefined,
      provenance: undefined,
      updatedAt: "2026-03-26T00:00:02.000Z",
    });
    assert.equal(updated.lifecycleState, "trusted");
    assert.equal(updated.reviewWarning, undefined);
    assert.equal(updated.provenance, undefined);
    assert.deepEqual(
      repo.list().map((record) => record.skillId),
      ["skill-a"],
    );

    assert.equal(repo.find("missing-skill"), undefined);
    assert.throws(() => repo.get("missing-skill"), /skill lifecycle missing-skill not found/);
  });

  it("filters malformed rows and coerces malformed provenance", () => {
    const { db, repo } = createStore();
    repo.upsert({
      skillId: "skill-a",
      category: "optional",
      lifecycleState: "draft",
      trustLabel: "Draft",
      provenance: { source: "local" },
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "skill-a", "provenance_json", "[]");
    assert.equal(repo.get("skill-a").provenance, undefined);

    setRawField(db, "skill-a", "provenance_json", '{"source":"local","sourceRef":1,"sourceProvider":false}');
    assert.deepEqual(repo.get("skill-a").provenance, { source: "local" });

    setRawField(db, "skill-a", "capability_category", "unknown");
    assert.equal(repo.find("skill-a"), undefined);
    assert.deepEqual(repo.list(), []);
    assert.throws(() => repo.get("skill-a"), /skill lifecycle skill-a not found/);
  });
});
