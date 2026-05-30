import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CostLedgerRepository } from "./cost-ledger-repo.js";

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

function createRepo(): CostLedgerRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-cost-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new CostLedgerRepository(db);
}

describe("CostLedgerRepository", () => {
  it("aggregates by session/day/agent/task", () => {
    const repo = createRepo();
    repo.insert({
      sessionId: "s1",
      agentId: "agent-a",
      taskId: "task-1",
      tokenInput: 10,
      tokenOutput: 20,
      tokenCachedInput: 2,
      costUsd: 0.1,
      createdAt: "2026-02-27T10:00:00.000Z",
    });
    repo.insert({
      sessionId: "s2",
      agentId: "agent-a",
      taskId: "task-2",
      tokenInput: 5,
      tokenOutput: 5,
      tokenCachedInput: 1,
      costUsd: 0.05,
      createdAt: "2026-02-27T12:00:00.000Z",
    });

    const byDay = repo.summary("day", "2026-02-20T00:00:00.000Z", "2026-02-28T00:00:00.000Z");
    const byAgent = repo.summary("agent", "2026-02-20T00:00:00.000Z", "2026-02-28T00:00:00.000Z");
    const byTask = repo.summary("task", "2026-02-20T00:00:00.000Z", "2026-02-28T00:00:00.000Z");

    assert.equal(byDay[0]?.tokenTotal, 40);
    assert.equal(byAgent[0]?.key, "agent-a");
    assert.equal(byAgent[0]?.tokenTotal, 40);
    assert.equal(byTask.length, 2);
  });

  it("reports tracked vs unknown usage availability for agent events", () => {
    const repo = createRepo();
    repo.insert({
      sessionId: "s1",
      agentId: "assistant",
      taskId: "task-1",
      tokenInput: 100,
      tokenOutput: 60,
      tokenCachedInput: 10,
      costUsd: 0.12,
      createdAt: "2026-02-27T10:00:00.000Z",
    });
    repo.insert({
      sessionId: "s1",
      agentId: "assistant",
      taskId: "task-1",
      tokenInput: 0,
      tokenOutput: 0,
      tokenCachedInput: 0,
      costUsd: 0,
      createdAt: "2026-02-27T10:05:00.000Z",
    });
    repo.insert({
      sessionId: "s1",
      tokenInput: 0,
      tokenOutput: 0,
      tokenCachedInput: 0,
      costUsd: 0,
      createdAt: "2026-02-27T10:06:00.000Z",
    });

    const availability = repo.usageAvailability("2026-02-27T00:00:00.000Z", "2026-02-27T23:59:59.999Z");
    assert.equal(availability.totalAgentEvents, 2);
    assert.equal(availability.trackedEvents, 1);
    assert.equal(availability.unknownEvents, 1);
  });

  it("builds a seven-day provider spend series with anomaly-ready totals", () => {
    const repo = createRepo();
    repo.insert({
      sessionId: "s1",
      agentId: "assistant",
      providerId: "openai",
      modelId: "gpt-5",
      tokenInput: 100,
      tokenOutput: 50,
      tokenCachedInput: 10,
      costUsd: 1,
      createdAt: "2026-02-21T10:00:00.000Z",
    });
    repo.insert({
      sessionId: "s2",
      agentId: "assistant",
      providerId: "anthropic",
      modelId: "claude-sonnet",
      tokenInput: 200,
      tokenOutput: 100,
      tokenCachedInput: 0,
      costUsd: 5,
      createdAt: "2026-02-23T10:00:00.000Z",
    });
    repo.insert({
      sessionId: "s3",
      agentId: "assistant",
      tokenInput: 20,
      tokenOutput: 10,
      tokenCachedInput: 0,
      costUsd: 0.2,
      createdAt: "2026-02-23T11:00:00.000Z",
    });

    const series = repo.dailySeries("2026-02-20T00:00:00.000Z", "2026-02-26T23:59:59.999Z");

    assert.equal(series.length, 7);
    assert.equal(series[0]?.isoDate, "2026-02-20");
    assert.equal(series[3]?.isoDate, "2026-02-23");
    assert.equal(series[1]?.segments[0]?.providerKey, "openai");
    assert.deepEqual(series[1]?.segments[0]?.models, ["gpt-5"]);
    assert.equal(series[3]?.costUsd, 5.2);
    assert.deepEqual(
      series[3]?.segments.map((segment) => segment.providerKey),
      ["anthropic", "unattributed"],
    );
  });

  it("uses zero availability defaults when aggregate rows are missing or nullish", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      summaryUsageAvailabilityStmt: { get: () => unknown };
    };

    internal.summaryUsageAvailabilityStmt = { get: () => undefined };
    assert.deepEqual(repo.usageAvailability("2026-02-27T00:00:00.000Z", "2026-02-27T23:59:59.999Z"), {
      trackedEvents: 0,
      unknownEvents: 0,
      totalAgentEvents: 0,
    });

    internal.summaryUsageAvailabilityStmt = {
      get: () => ({ tracked_events: null, unknown_events: null, total_agent_events: null }),
    };
    assert.deepEqual(repo.usageAvailability("2026-02-27T00:00:00.000Z", "2026-02-27T23:59:59.999Z"), {
      trackedEvents: 0,
      unknownEvents: 0,
      totalAgentEvents: 0,
    });
  });

  it("rolls back the insert when prune fails on the 50th write", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      insertCount: number;
      pruneStmt: { run: (params: { cutoff: string }) => unknown };
    };

    internal.insertCount = 49;
    const originalRun = internal.pruneStmt.run.bind(internal.pruneStmt);
    internal.pruneStmt.run = () => {
      throw new Error("prune failed");
    };

    assert.throws(() => {
      repo.insert({
        sessionId: "s-rollback",
        agentId: "assistant",
        taskId: "task-rollback",
        tokenInput: 1,
        tokenOutput: 1,
        tokenCachedInput: 0,
        costUsd: 0.01,
        createdAt: "2026-02-27T11:00:00.000Z",
      });
    }, /prune failed/);

    internal.pruneStmt.run = originalRun;
    const summary = repo.summary("session", "2026-02-27T00:00:00.000Z", "2026-02-27T23:59:59.999Z");
    assert.equal(summary.length, 0);
    assert.equal(internal.insertCount, 49);
  });
});
