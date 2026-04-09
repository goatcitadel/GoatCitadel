import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function createRepo(): PromptPackRunRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new PromptPackRunRepository(db);
}

describe("PromptPackRunRepository", () => {
  it("patch updates only provided fields without clobbering others", () => {
    const repo = createRepo();
    repo.create({
      runId: "run-1",
      packId: "pack-1",
      testId: "test-1",
      status: "running",
      responseText: "initial response",
      error: "initial error",
      startedAt: "2026-03-02T00:00:00.000Z",
    });

    const firstPatch = repo.patch("run-1", {
      status: "completed",
      responseText: "final response",
    });
    assert.equal(firstPatch.status, "completed");
    assert.equal(firstPatch.responseText, "final response");
    assert.equal(firstPatch.error, "initial error");

    const secondPatch = repo.patch("run-1", {
      error: "updated error",
    });
    assert.equal(secondPatch.status, "completed");
    assert.equal(secondPatch.responseText, "final response");
    assert.equal(secondPatch.error, "updated error");
  });

  it("round-trips integrity metadata through create and patch", () => {
    const repo = createRepo();
    const created = repo.create({
      runId: "run-integrity-1",
      packId: "pack-1",
      testId: "test-1",
      status: "completed",
      responseText: "Final answer.",
      integrity: {
        validationStatus: "valid",
        signals: [],
        completionStatus: "complete",
        finishReason: "stop",
        outputTokenCount: 48,
        responseChecksumSha256: "abc123",
      },
      startedAt: "2026-03-02T00:00:00.000Z",
      finishedAt: "2026-03-02T00:00:02.000Z",
    });

    assert.deepEqual(created.integrity, {
      validationStatus: "valid",
      signals: [],
      completionStatus: "complete",
      finishReason: "stop",
      outputTokenCount: 48,
      responseChecksumSha256: "abc123",
    });

    const patched = repo.patch("run-integrity-1", {
      integrity: {
        validationStatus: "invalid",
        signals: ["output_cut_off_fragment"],
        completionStatus: "truncated",
        finishReason: "length",
        outputTokenCount: 48,
        responseChecksumSha256: "def456",
      },
    });

    assert.deepEqual(patched.integrity, {
      validationStatus: "invalid",
      signals: ["output_cut_off_fragment"],
      completionStatus: "truncated",
      finishReason: "length",
      outputTokenCount: 48,
      responseChecksumSha256: "def456",
    });
  });
});
