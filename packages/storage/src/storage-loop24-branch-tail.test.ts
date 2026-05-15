import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseClient, DbStatement } from "./db.js";
import { TaskActivityRepository } from "./task-activity-repo.js";
import { TaskDeliverableRepository } from "./task-deliverable-repo.js";
import { TaskSubagentRepository } from "./task-subagent-repo.js";

type MutableStatement = DbStatement & {
  runs: unknown[][];
  row?: unknown;
  rows: unknown;
};

function statement(input: { row?: unknown; rows?: unknown } = {}): MutableStatement {
  return {
    runs: [],
    row: input.row,
    rows: input.rows ?? [],
    run(...params: unknown[]) {
      this.runs.push(params);
      return { changes: 1 };
    },
    get<T = unknown>() {
      return this.row as T | undefined;
    },
    all<T = unknown>() {
      return this.rows as T[];
    },
  };
}

function fakeDb(resolve: (sql: string) => DbStatement): DatabaseClient {
  return {
    dialect: "sqlite",
    prepare: resolve,
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
}

function taskActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: "activity-1",
    task_id: "task-1",
    agent_id: null,
    activity_type: "comment",
    message: "Default activity",
    metadata_json: null,
    created_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function taskDeliverableRow(overrides: Record<string, unknown> = {}) {
  return {
    deliverable_id: "deliverable-1",
    task_id: "task-1",
    deliverable_type: "file",
    title: "Default deliverable",
    path: null,
    description: null,
    created_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function taskSubagentRow(overrides: Record<string, unknown> = {}) {
  return {
    subagent_session_id: "subagent-1",
    task_id: "task-1",
    agent_session_id: "agent-session-1",
    agent_name: null,
    status: "active",
    metadata_json: null,
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ended_at: null,
    ...overrides,
  };
}

describe("storage loop 24 branch tails", () => {
  it("preserves task activity omitted defaults and filters adapter fallbacks", () => {
    const insert = statement();
    const list = statement({ rows: [taskActivityRow(), taskActivityRow({ agent_id: 42 }), null] });
    const repo = new TaskActivityRepository(
      fakeDb((sql) => (sql.includes("INSERT INTO task_activities") ? insert : list)),
    );

    const created = repo.append(
      "task-1",
      {
        activityType: "comment",
        message: "Default activity",
      },
      "2026-05-15T00:00:00.000Z",
    );
    assert.equal(created.agentId, undefined);
    assert.equal(created.metadata, undefined);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).agentId, null);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).metadataJson, null);

    const [listed] = repo.listByTask("task-1");
    assert.equal(listed?.agentId, undefined);
    assert.equal(listed?.metadata, undefined);

    list.rows = { not: "rows" };
    assert.deepEqual(repo.listByTask("task-1"), []);
  });

  it("preserves task deliverable nullish defaults and count fallbacks", () => {
    const insert = statement();
    const list = statement({ rows: [taskDeliverableRow(), taskDeliverableRow({ path: 7 }), undefined] });
    const count = statement();
    const repo = new TaskDeliverableRepository(
      fakeDb((sql) => {
        if (sql.includes("INSERT INTO task_deliverables")) {
          return insert;
        }
        if (sql.includes("COUNT(*) AS count")) {
          return count;
        }
        return list;
      }),
    );

    const created = repo.append(
      "task-1",
      {
        deliverableType: "file",
        title: "Default deliverable",
      },
      "2026-05-15T00:00:00.000Z",
    );
    assert.equal(created.path, undefined);
    assert.equal(created.description, undefined);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).path, null);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).description, null);

    const [listed] = repo.listByTask("task-1");
    assert.equal(listed?.path, undefined);
    assert.equal(listed?.description, undefined);
    assert.equal(repo.countByTask("task-1"), 0);

    count.row = { count: null };
    assert.equal(repo.countByTask("task-1"), 0);

    list.rows = "not rows";
    assert.deepEqual(repo.listByTask("task-1"), []);
  });

  it("preserves task subagent omitted, nullish, and explicit terminal update variants", () => {
    const insert = statement();
    const get = statement({ row: taskSubagentRow() });
    const update = statement();
    const list = statement({ rows: [taskSubagentRow(), taskSubagentRow({ agent_name: 12 })] });
    const count = statement();
    const repo = new TaskSubagentRepository(
      fakeDb((sql) => {
        if (sql.includes("INSERT INTO task_subagent_sessions")) {
          return insert;
        }
        if (sql.includes("UPDATE task_subagent_sessions")) {
          return update;
        }
        if (sql.includes("COUNT(*) AS count")) {
          return count;
        }
        if (sql.includes("ORDER BY")) {
          return list;
        }
        return get;
      }),
    );

    const created = repo.create(
      "task-1",
      {
        agentSessionId: "agent-session-1",
      },
      "2026-05-15T00:00:00.000Z",
    );
    assert.equal(created.agentName, undefined);
    assert.equal(created.metadata, undefined);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).agentName, null);
    assert.equal((insert.runs[0]?.[0] as Record<string, unknown>).metadataJson, null);

    const preserved = repo.updateByAgentSessionId("agent-session-1", {}, "2026-05-15T00:01:00.000Z");
    assert.equal(preserved.status, "active");
    assert.equal((update.runs[0]?.[0] as Record<string, unknown>).status, "active");
    assert.equal((update.runs[0]?.[0] as Record<string, unknown>).metadataJson, null);
    assert.equal((update.runs[0]?.[0] as Record<string, unknown>).endedAt, null);

    get.row = taskSubagentRow({ status: "completed", metadata_json: '{"step":"done"}' });
    const cleared = repo.updateByAgentSessionId(
      "agent-session-1",
      {
        status: "failed",
        metadata: null,
        endedAt: "2026-05-15T00:02:00.000Z",
      },
      "2026-05-15T00:03:00.000Z",
    );
    assert.equal(cleared.status, "completed");
    assert.equal((update.runs[1]?.[0] as Record<string, unknown>).status, "failed");
    assert.equal((update.runs[1]?.[0] as Record<string, unknown>).metadataJson, null);
    assert.equal((update.runs[1]?.[0] as Record<string, unknown>).endedAt, "2026-05-15T00:02:00.000Z");

    assert.equal(repo.listByTask("task-1").length, 1);
    assert.equal(repo.activeCount(), 0);

    list.rows = { malformed: true };
    assert.deepEqual(repo.listAll(), []);
  });
});
