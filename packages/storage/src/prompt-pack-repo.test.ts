import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";

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

function createRepo(): PromptPackRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new PromptPackRepository(db);
}

describe("PromptPackRepository", () => {
  it("rolls back pack test replacement if an insert fails mid-stream", () => {
    const repo = createRepo();
    const original = repo.replacePackTests({
      packId: "pack-1",
      name: "Original Pack",
      tests: [
        {
          code: "TEST-01",
          title: "Original test",
          prompt: "Original prompt",
          orderIndex: 0,
          mode: "chat",
          toolTier: "implicit-tools",
        },
      ],
    });

    const originalInsert = (repo as unknown as { insertTestStmt: { run: (input: Record<string, unknown>) => unknown } }).insertTestStmt;
    let insertCount = 0;
    const originalRun = originalInsert.run.bind(originalInsert);
    originalInsert.run = (input: Record<string, unknown>) => {
      insertCount += 1;
      if (insertCount === 2) {
        throw new Error("simulated insert failure");
      }
      return originalRun(input);
    };

    assert.throws(() => repo.replacePackTests({
      packId: "pack-1",
      name: "Updated Pack",
      tests: [
        {
          code: "TEST-02",
          title: "Replacement one",
          prompt: "Replacement prompt one",
          orderIndex: 0,
          mode: "chat",
          toolTier: "implicit-tools",
        },
        {
          code: "TEST-03",
          title: "Replacement two",
          prompt: "Replacement prompt two",
          orderIndex: 1,
          mode: "code",
          toolTier: "explicit-tools",
        },
      ],
    }), /simulated insert failure/);

    const pack = repo.getPack("pack-1");
    const tests = repo.listTests("pack-1");
    assert.equal(pack.name, original.pack.name);
    assert.equal(pack.testCount, 1);
    assert.deepEqual(tests.map((test) => test.code), ["TEST-01"]);
  });
});
