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

function metricAvailability(knownAttemptCount: number, unknownAttemptCount: number) {
  return {
    knownAttemptCount,
    unknownAttemptCount,
    complete: unknownAttemptCount === 0,
  };
}

const COMPLETE_METRICS = {
  inputTokensComplete: true,
  outputTokensComplete: true,
  cachedInputTokensComplete: true,
  costUsdComplete: true,
} as const;

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

  it("persists credentialType and usagePool billing-pool dimensions", () => {
    const repo = createRepo();
    repo.insert({
      sessionId: "s-cred",
      agentId: "assistant",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      credentialType: "oauth",
      usagePool: "subscription",
      tokenInput: 10,
      tokenOutput: 5,
      tokenCachedInput: 0,
      costUsd: 0.2,
      createdAt: "2026-06-22T10:00:00.000Z",
    });

    const internal = repo as unknown as {
      db: {
        prepare: (sql: string) => {
          get: <T>(params: Record<string, unknown>) => T | undefined;
        };
      };
    };
    const row = internal.db
      .prepare(
        "SELECT credential_type AS credentialType, usage_pool AS usagePool FROM cost_ledger WHERE session_id = @sessionId",
      )
      .get<{ credentialType?: string; usagePool?: string }>({ sessionId: "s-cred" });
    assert.equal(row?.credentialType, "oauth");
    assert.equal(row?.usagePool, "subscription");

    // Summary aggregation is unaffected by the additional columns.
    const summary = repo.summary("session", "2026-06-22T00:00:00.000Z", "2026-06-22T23:59:59.999Z");
    assert.equal(summary[0]?.tokenTotal, 15);
  });

  it("reports tracked vs unknown usage availability for all legacy attempts", () => {
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
    assert.equal(availability.totalAgentEvents, 3);
    assert.equal(availability.trackedEvents, 3);
    assert.equal(availability.unknownEvents, 0);
    assert.deepEqual(availability.metricAvailability, {
      inputTokens: metricAvailability(3, 0),
      outputTokens: metricAvailability(3, 0),
      cachedInputTokens: metricAvailability(3, 0),
      costUsd: metricAvailability(3, 0),
    });
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
    assert.equal(series[1]?.segments[0]?.label, "OpenAI");
    assert.deepEqual(series[1]?.segments[0]?.models, ["gpt-5"]);
    assert.deepEqual(series[1]?.segments[0]?.metricAvailability, COMPLETE_METRICS);
    assert.equal(series[3]?.costUsd, 5.2);
    assert.deepEqual(series[3]?.metricAvailability, COMPLETE_METRICS);
    assert.deepEqual(
      series[3]?.segments.map((segment) => segment.providerKey),
      ["anthropic", "unattributed"],
    );
  });

  it("preserves the OpenAI acronym inside compound provider labels", () => {
    const repo = createRepo();
    repo.insert({
      sessionId: "s-openai-codex",
      agentId: "assistant",
      providerId: "openai-codex",
      modelId: "gpt-5",
      tokenInput: 10,
      tokenOutput: 5,
      tokenCachedInput: 0,
      costUsd: 0.0026,
      createdAt: "2026-02-23T10:00:00.000Z",
    });

    const series = repo.dailySeries("2026-02-23T00:00:00.000Z", "2026-02-23T23:59:59.999Z");

    assert.equal(series[0]?.segments[0]?.providerKey, "openai-codex");
    assert.equal(series[0]?.segments[0]?.label, "OpenAI Codex");
  });

  it("uses the exact requested timestamp window for daily totals and coverage", () => {
    const repo = createRepo();
    const db = (
      repo as unknown as {
        db: { prepare: (sql: string) => { run: (params: Record<string, unknown>) => unknown } };
      }
    ).db;
    const insert = db.prepare(`
      INSERT INTO cost_ledger (
        session_id, agent_id, provider_id, model_id, day,
        token_input, token_output, token_cached_input, cost_usd,
        created_at, usage_known_mask
      ) VALUES (
        @sessionId, NULL, @providerId, @modelId, @day,
        @tokenInput, @tokenOutput, @tokenCachedInput, @costUsd,
        @createdAt, @usageKnownMask
      )
    `);
    insert.run({
      sessionId: "outside-window",
      providerId: "openai",
      modelId: "gpt-outside",
      day: "2026-07-13",
      tokenInput: 100,
      tokenOutput: 50,
      tokenCachedInput: 0,
      costUsd: 9,
      createdAt: "2026-07-13T08:00:00.000Z",
      usageKnownMask: "",
    });
    insert.run({
      sessionId: "inside-window",
      providerId: "anthropic",
      modelId: "claude-inside",
      day: "2026-07-13",
      tokenInput: 10,
      tokenOutput: 5,
      tokenCachedInput: 0,
      costUsd: 1,
      createdAt: "2026-07-13T12:00:00.000Z",
      usageKnownMask: "input,output,cached,cost",
    });

    const from = "2026-07-13T10:00:00.000Z";
    const to = "2026-07-13T13:00:00.000Z";
    assert.deepEqual(repo.summary("day", from, to), [
      {
        scope: "day",
        key: "2026-07-13",
        tokenInput: 10,
        tokenOutput: 5,
        tokenCachedInput: 0,
        tokenTotal: 15,
        costUsd: 1,
        metricAvailability: COMPLETE_METRICS,
      },
    ]);
    assert.equal(repo.dailySeries(from, to)[0]?.costUsd, 1);
    assert.deepEqual(repo.usageAvailability(from, to), {
      trackedEvents: 1,
      unknownEvents: 0,
      totalAgentEvents: 1,
      metricAvailability: {
        inputTokens: metricAvailability(1, 0),
        outputTokens: metricAvailability(1, 0),
        cachedInputTokens: metricAvailability(1, 0),
        costUsd: metricAvailability(1, 0),
      },
    });
  });

  it("keeps partial token totals while marking unknown cost in summary, provider, and coverage projections", () => {
    const repo = createRepo();
    const db = (
      repo as unknown as {
        db: {
          prepare: (sql: string) => { run: (params: Record<string, unknown>) => unknown };
        };
      }
    ).db;
    db.prepare(
      `
      INSERT INTO cost_ledger (
        session_id, agent_id, provider_id, model_id, day,
        token_input, token_output, token_cached_input, cost_usd,
        created_at, usage_known_mask
      ) VALUES (
        @sessionId, @agentId, @providerId, @modelId, @day,
        @tokenInput, @tokenOutput, @tokenCachedInput, @costUsd,
        @createdAt, @usageKnownMask
      )
    `,
    ).run({
      sessionId: "s-partial",
      agentId: "assistant",
      providerId: "openai",
      modelId: "gpt-partial",
      day: "2026-02-24",
      tokenInput: 12,
      tokenOutput: 3,
      tokenCachedInput: 0,
      costUsd: 0,
      createdAt: "2026-02-24T12:00:00.000Z",
      usageKnownMask: "input,output",
    });

    const summary = repo.summary("day", "2026-02-24T00:00:00.000Z", "2026-02-24T23:59:59.999Z");
    assert.equal(summary[0]?.tokenTotal, 15);
    assert.equal(summary[0]?.costUsd, 0);
    assert.deepEqual(summary[0]?.metricAvailability, {
      inputTokensComplete: true,
      outputTokensComplete: true,
      cachedInputTokensComplete: false,
      costUsdComplete: false,
    });

    const series = repo.dailySeries("2026-02-24T00:00:00.000Z", "2026-02-24T23:59:59.999Z");
    assert.equal(series[0]?.tokenTotal, 15);
    assert.equal(series[0]?.costUsd, 0);
    assert.deepEqual(series[0]?.metricAvailability, summary[0]?.metricAvailability);
    assert.deepEqual(series[0]?.segments[0]?.metricAvailability, summary[0]?.metricAvailability);

    assert.deepEqual(repo.usageAvailability("2026-02-24T00:00:00.000Z", "2026-02-24T23:59:59.999Z"), {
      trackedEvents: 1,
      unknownEvents: 0,
      totalAgentEvents: 1,
      metricAvailability: {
        inputTokens: metricAvailability(1, 0),
        outputTokens: metricAvailability(1, 0),
        cachedInputTokens: metricAvailability(0, 1),
        costUsd: metricAvailability(0, 1),
      },
    });
  });

  it("treats a legacy NULL usage mask as incomplete even when numeric lower bounds are nonzero", () => {
    const repo = createRepo();
    const db = (
      repo as unknown as {
        db: {
          prepare: (sql: string) => { run: (params: Record<string, unknown>) => unknown };
        };
      }
    ).db;
    db.prepare(
      `
      INSERT INTO cost_ledger (
        session_id, agent_id, provider_id, model_id, day,
        token_input, token_output, token_cached_input, cost_usd,
        created_at, usage_known_mask
      ) VALUES (
        @sessionId, @agentId, @providerId, @modelId, @day,
        @tokenInput, @tokenOutput, @tokenCachedInput, @costUsd,
        @createdAt, NULL
      )
    `,
    ).run({
      sessionId: "s-legacy-null-mask",
      agentId: "assistant",
      providerId: "legacy-provider",
      modelId: "legacy-model",
      day: "2026-02-25",
      tokenInput: 9,
      tokenOutput: 4,
      tokenCachedInput: 2,
      costUsd: 0.25,
      createdAt: "2026-02-25T12:00:00.000Z",
    });

    const incomplete = {
      inputTokensComplete: false,
      outputTokensComplete: false,
      cachedInputTokensComplete: false,
      costUsdComplete: false,
    };
    const summary = repo.summary("day", "2026-02-25T00:00:00.000Z", "2026-02-25T23:59:59.999Z");
    assert.equal(summary[0]?.tokenTotal, 13);
    assert.equal(summary[0]?.costUsd, 0.25);
    assert.deepEqual(summary[0]?.metricAvailability, incomplete);

    const series = repo.dailySeries("2026-02-25T00:00:00.000Z", "2026-02-25T23:59:59.999Z");
    assert.deepEqual(series[0]?.metricAvailability, incomplete);
    assert.deepEqual(series[0]?.segments[0]?.metricAvailability, incomplete);
    assert.deepEqual(repo.usageAvailability("2026-02-25T00:00:00.000Z", "2026-02-25T23:59:59.999Z"), {
      trackedEvents: 1,
      unknownEvents: 0,
      totalAgentEvents: 1,
      metricAvailability: {
        inputTokens: metricAvailability(0, 1),
        outputTokens: metricAvailability(0, 1),
        cachedInputTokens: metricAvailability(0, 1),
        costUsd: metricAvailability(0, 1),
      },
    });
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
      metricAvailability: {
        inputTokens: metricAvailability(0, 0),
        outputTokens: metricAvailability(0, 0),
        cachedInputTokens: metricAvailability(0, 0),
        costUsd: metricAvailability(0, 0),
      },
    });

    internal.summaryUsageAvailabilityStmt = {
      get: () => ({ tracked_events: null, unknown_events: null, total_agent_events: null }),
    };
    assert.deepEqual(repo.usageAvailability("2026-02-27T00:00:00.000Z", "2026-02-27T23:59:59.999Z"), {
      trackedEvents: 0,
      unknownEvents: 0,
      totalAgentEvents: 0,
      metricAvailability: {
        inputTokens: metricAvailability(0, 0),
        outputTokens: metricAvailability(0, 0),
        cachedInputTokens: metricAvailability(0, 0),
        costUsd: metricAvailability(0, 0),
      },
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
