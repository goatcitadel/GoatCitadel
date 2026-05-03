import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatDelegationRunRepository } from "./chat-delegation-run-repo.js";
import { ChatDelegationStepRepository } from "./chat-delegation-step-repo.js";

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

function createRepos(): {
  runs: ChatDelegationRunRepository;
  steps: ChatDelegationStepRepository;
  close: () => void;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-delegation-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    runs: new ChatDelegationRunRepository(db),
    steps: new ChatDelegationStepRepository(db),
    close: () => db.close(),
  };
}

describe("ChatDelegationStepRepository", () => {
  it("maps child session ids back to their parent delegation run and step", () => {
    const { runs, steps, close } = createRepos();
    try {
      runs.create({
        runId: "run-1",
        sessionId: "parent-session",
        taskId: "task-1",
        objective: "Plan beta acquisition.",
        roles: ["Plan", "Synthesis"],
        mode: "sequential",
        status: "running",
        startedAt: "2026-05-03T16:00:00.000Z",
      });
      steps.create({
        stepId: "run-1:step-2",
        runId: "run-1",
        role: "synthesizer",
        label: "Synthesis",
        index: 1,
        status: "completed",
        childSessionId: "child-session",
        startedAt: "2026-05-03T16:01:00.000Z",
      });

      const parents = steps.listParentsByChildSessionIds(["child-session", "missing-session"]);

      assert.deepEqual(parents.get("child-session"), {
        parentSessionId: "parent-session",
        runId: "run-1",
        stepId: "run-1:step-2",
        role: "synthesizer",
        label: "Synthesis",
        index: 1,
      });
      assert.equal(parents.has("missing-session"), false);
    } finally {
      close();
    }
  });
});
