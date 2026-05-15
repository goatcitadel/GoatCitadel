import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatExecutionPlanRepository } from "./chat-execution-plan-repo.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore cleanup noise from SQLite sidecar files.
    }
  }
});

function createDb(prefix: string): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

describe("storage loop 25 branch tails", () => {
  it("covers durable lease fallback timestamps and empty lease persistence", () => {
    const repo = new DurableRunRepository(createDb("goatcitadel-loop25-durable"));
    const queued = repo.createRun({
      workflowKey: "loop25.lease",
      payload: { step: "queued" },
      metadata: undefined,
      status: "queued",
    });

    const leased = repo.tryClaimQueuedRun({
      runId: queued.runId,
      workerId: "worker-1",
      leaseHeartbeatAt: "2026-05-15T00:00:00.000Z",
      leaseExpiresAt: "2026-05-15T00:05:00.000Z",
    });
    assert.equal(leased?.startedAt, "2026-05-15T00:00:00.000Z");
    assert.equal(leased?.leaseOwnerId, "worker-1");
    assert.equal(leased?.leaseExpiresAt, "2026-05-15T00:05:00.000Z");
    assert.equal(leased?.leaseHeartbeatAt, "2026-05-15T00:00:00.000Z");

    const released = repo.releaseLease(queued.runId, "worker-1", "2026-05-15T00:01:00.000Z");
    assert.equal(released?.leaseOwnerId, undefined);
    assert.equal(released?.leaseExpiresAt, undefined);
    assert.equal(released?.leaseHeartbeatAt, undefined);
    assert.equal(
      repo.tryClaimQueuedRun({
        runId: queued.runId,
        workerId: "worker-2",
        leaseHeartbeatAt: "2026-05-15T00:02:00.000Z",
        leaseExpiresAt: "2026-05-15T00:07:00.000Z",
      }),
      undefined,
    );
  });

  it("covers execution plan patch defaults and bounded list limits", () => {
    const repo = new ChatExecutionPlanRepository(createDb("goatcitadel-loop25-plan"));
    const created = repo.create({
      sessionId: "session-1",
      turnId: "turn-1",
      mode: "cowork",
      planningMode: "advisory",
      source: "planner",
      objective: "Cover branch tails",
      summary: "Cover storage tails",
      status: "drafted",
      advisoryOnly: false,
      steps: [],
    });

    const preserved = repo.patch(created.planId, {});
    assert.equal(preserved.status, "drafted");
    assert.equal(preserved.summary, "Cover storage tails");
    assert.equal(preserved.startedAt, undefined);
    assert.equal(preserved.finishedAt, undefined);

    const cleared = repo.patch(created.planId, {
      startedAt: null as unknown as undefined,
      finishedAt: null as unknown as undefined,
      steps: [
        {
          stepId: "step-1",
          index: 0,
          objective: "Exercise null defaults",
          status: "pending",
          parallelizable: false,
        },
      ],
    });
    assert.equal(cleared.steps[0]?.successCriteria, undefined);
    assert.equal(cleared.steps[0]?.suggestedTools, undefined);
    assert.equal(repo.listBySession("session-1", 0).length, 1);
    assert.equal(repo.listByTurn("turn-1", 1000).length, 1);
  });

  it("covers chat tool run create and patch nullish branches", () => {
    const repo = new ChatToolRunRepository(createDb("goatcitadel-loop25-tool-run"));
    const minimal = repo.create({
      toolRunId: "tool-run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "browser.search",
    });
    assert.equal(minimal.approvalId, undefined);
    assert.equal(minimal.args, undefined);
    assert.equal(minimal.result, undefined);
    assert.equal(minimal.reused, undefined);
    assert.equal(minimal.finishedAt, undefined);

    const explicitFalse = repo.patch("tool-run-1", {
      approvalId: null as unknown as undefined,
      result: null as unknown as undefined,
      reused: false,
      reusedFromToolRunId: null as unknown as undefined,
      reuseReason: null as unknown as undefined,
      error: null as unknown as undefined,
      failureGuidance: null as unknown as undefined,
      finishedAt: null as unknown as undefined,
    });
    assert.equal(explicitFalse.approvalId, undefined);
    assert.equal(explicitFalse.result, undefined);
    assert.equal(explicitFalse.reused, false);
    assert.equal(explicitFalse.reusedFromToolRunId, undefined);
    assert.equal(explicitFalse.reuseReason, undefined);
    assert.equal(explicitFalse.error, undefined);
    assert.equal(explicitFalse.failureGuidance, undefined);
    assert.equal(explicitFalse.finishedAt, undefined);
  });
});
