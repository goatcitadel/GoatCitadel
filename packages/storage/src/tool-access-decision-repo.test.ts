import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  mapToolAccessDecisionRow,
  ToolAccessDecisionRepository,
  type ToolAccessDecisionRecord,
} from "./tool-access-decision-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore best-effort temp database cleanup failures.
    }
  }
});

function createRepoWithDb(): { repo: ToolAccessDecisionRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-tool-access-decision-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new ToolAccessDecisionRepository(db),
    db,
  };
}

function insertSessionMeta(db: ReturnType<typeof createDatabase>, sessionId: string, workspaceId: string): void {
  db.prepare(
    `
    INSERT INTO chat_session_meta (
      session_id,
      workspace_id,
      title,
      include_in_history,
      pinned,
      lifecycle_status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 1, 0, 'active', ?, ?)
  `,
  ).run(sessionId, workspaceId, "Coverage session", new Date().toISOString(), new Date().toISOString());
}

function recordDecision(
  repo: ToolAccessDecisionRepository,
  input: Partial<Omit<ToolAccessDecisionRecord, "decisionId" | "timestamp">> = {},
  now = new Date().toISOString(),
): ToolAccessDecisionRecord {
  return repo.record(
    {
      toolName: input.toolName ?? "fs.write",
      agentId: input.agentId ?? "agent-1",
      sessionId: input.sessionId ?? "session-1",
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      allowed: input.allowed ?? true,
      reasonCodes: input.reasonCodes ?? ["grant.matched"],
      matchedGrantId: input.matchedGrantId,
      requiresApproval: input.requiresApproval ?? false,
      riskLevel: input.riskLevel ?? "caution",
    },
    now,
  );
}

describe("ToolAccessDecisionRepository", () => {
  it("records decisions and counts calls across every grant scope", () => {
    const { repo, db } = createRepoWithDb();
    insertSessionMeta(db, "session-1", "workspace-1");
    insertSessionMeta(db, "session-2", "workspace-1");
    insertSessionMeta(db, "session-3", "workspace-2");

    const recent = recordDecision(repo, {
      taskId: "task-1",
      matchedGrantId: "grant-1",
      reasonCodes: ["grant.matched", "scope.session"],
    });
    assert.match(recent.decisionId, /^[0-9a-f-]{36}$/);
    assert.equal(recent.matchedGrantId, "grant-1");
    assert.deepEqual(recent.reasonCodes, ["grant.matched", "scope.session"]);

    recordDecision(repo, {
      sessionId: "session-2",
      taskId: "task-2",
      riskLevel: "danger",
    });
    recordDecision(repo, {
      agentId: "agent-2",
      sessionId: "session-3",
      taskId: "task-3",
      toolName: "web.search",
      allowed: false,
      requiresApproval: true,
      riskLevel: "safe",
    });
    recordDecision(
      repo,
      {
        taskId: "task-old",
      },
      "2000-01-01T00:00:00.000Z",
    );

    assert.equal(repo.countToolCallsInLastHour("fs.write", "agent-1", "session-1"), 1);
    assert.equal(repo.countWritesInLastHour("agent-1", "session-1"), 1);
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "global",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      2,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "agent",
        agentId: "agent-1",
        sessionId: "ignored",
      }),
      2,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
        workspaceId: "workspace-1",
      }),
      2,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      0,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "task",
        agentId: "ignored",
        sessionId: "ignored",
        taskId: "task-1",
      }),
      1,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "task",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      0,
    );

    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "global",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      2,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "agent",
        agentId: "agent-1",
        sessionId: "ignored",
      }),
      2,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
        workspaceId: "workspace-1",
      }),
      2,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      0,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "task",
        agentId: "ignored",
        sessionId: "ignored",
        taskId: "task-2",
      }),
      1,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "task",
        agentId: "ignored",
        sessionId: "ignored",
      }),
      0,
    );
  });

  it("maps persisted rows defensively", () => {
    assert.deepEqual(
      mapToolAccessDecisionRow({
        decision_id: "decision-1",
        timestamp: "2026-03-24T10:00:00.000Z",
        tool_name: "shell.exec",
        agent_id: "agent-1",
        session_id: "session-1",
        task_id: null,
        allowed: 0,
        reason_codes_json: "not json",
        matched_grant_id: null,
        requires_approval: 1,
        risk_level: "danger",
      }),
      {
        decisionId: "decision-1",
        timestamp: "2026-03-24T10:00:00.000Z",
        toolName: "shell.exec",
        agentId: "agent-1",
        sessionId: "session-1",
        taskId: undefined,
        allowed: false,
        reasonCodes: [],
        matchedGrantId: undefined,
        requiresApproval: true,
        riskLevel: "danger",
      },
    );
  });
});
