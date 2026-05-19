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
      runId: input.runId,
      allowed: input.allowed ?? true,
      reasonCodes: input.reasonCodes ?? ["grant.matched"],
      matchedGrantId: input.matchedGrantId,
      requiresApproval: input.requiresApproval ?? false,
      riskLevel: input.riskLevel ?? "caution",
      countsTowardLimits: input.countsTowardLimits,
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
      runId: "run-1",
      matchedGrantId: "grant-1",
      reasonCodes: ["grant.matched", "scope.session"],
    });
    assert.match(recent.decisionId, /^[0-9a-f-]{36}$/);
    assert.equal(recent.matchedGrantId, "grant-1");
    assert.equal(recent.runId, "run-1");
    assert.deepEqual(recent.reasonCodes, ["grant.matched", "scope.session"]);
    const persistedRun = db
      .prepare("SELECT run_id FROM tool_access_decisions WHERE decision_id = ?")
      .get(recent.decisionId) as {
      run_id: string;
    };
    assert.equal(persistedRun.run_id, "run-1");

    recordDecision(repo, {
      sessionId: "session-2",
      taskId: "task-2",
      riskLevel: "danger",
    });
    recordDecision(repo, {
      sessionId: "session-without-meta",
      workspaceId: "workspace-1",
      taskId: "task-without-session-meta",
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
      3,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "agent",
        agentId: "agent-1",
        sessionId: "ignored",
      }),
      3,
    );
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
        workspaceId: "workspace-1",
      }),
      3,
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
      3,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "agent",
        agentId: "agent-1",
        sessionId: "ignored",
      }),
      3,
    );
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
        workspaceId: "workspace-1",
      }),
      3,
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

  it("counts session-scoped limits across agents in the same session", () => {
    const { repo, db } = createRepoWithDb();
    insertSessionMeta(db, "session-shared", "workspace-1");

    recordDecision(repo, {
      agentId: "agent-a",
      sessionId: "session-shared",
      toolName: "fs.write",
    });
    recordDecision(repo, {
      agentId: "agent-b",
      sessionId: "session-shared",
      toolName: "fs.write",
    });
    recordDecision(repo, {
      agentId: "agent-a",
      sessionId: "session-other",
      toolName: "fs.write",
    });

    assert.equal(repo.countToolCallsInLastHour("fs.write", "agent-a", "session-shared"), 2);
    assert.equal(repo.countToolCallsInLastHour("fs.write", "agent-b", "session-shared"), 2);
    assert.equal(
      repo.countToolCallsInLastHourInScope({
        toolName: "fs.write",
        scope: "session",
        agentId: "agent-a",
        sessionId: "session-shared",
      }),
      2,
    );
    assert.equal(repo.countWritesInLastHour("agent-a", "session-shared"), 2);
    assert.equal(repo.countWritesInLastHour("agent-b", "session-shared"), 2);
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "session",
        agentId: "agent-a",
        sessionId: "session-shared",
      }),
      2,
    );
  });

  it("counts all registry mutation classes for write-rate limits", () => {
    const { repo, db } = createRepoWithDb();
    insertSessionMeta(db, "session-mutations", "workspace-1");

    const mutatingTools = [
      ["bankr.write", "danger"],
      ["http.post", "danger"],
      ["shell.exec", "danger"],
      ["browser.screenshot", "danger"],
      ["browser.interact", "danger"],
      ["mcp.invoke", "danger"],
      ["fs.copy", "caution"],
      ["documents.create", "caution"],
      ["presentations.create", "caution"],
      ["channel.send", "caution"],
      ["discord.react", "caution"],
      ["slack.unsend", "caution"],
      ["calendar.create_event", "danger"],
    ] as const;

    for (const [toolName, riskLevel] of mutatingTools) {
      recordDecision(repo, {
        toolName,
        riskLevel,
        sessionId: "session-mutations",
        workspaceId: "workspace-1",
      });
    }
    recordDecision(repo, {
      toolName: "http.get",
      riskLevel: "caution",
      sessionId: "session-mutations",
      workspaceId: "workspace-1",
    });
    recordDecision(repo, {
      toolName: "memory.search",
      riskLevel: "safe",
      sessionId: "session-mutations",
      workspaceId: "workspace-1",
    });

    assert.equal(repo.countWritesInLastHour("agent-1", "session-mutations"), mutatingTools.length);
    assert.equal(
      repo.countWritesInLastHourInScope({
        scope: "workspace",
        agentId: "ignored",
        sessionId: "ignored",
        workspaceId: "workspace-1",
      }),
      mutatingTools.length,
    );
  });

  it("does not count inspection or dry-run evidence toward grant rate limits", () => {
    const { repo, db } = createRepoWithDb();
    insertSessionMeta(db, "session-1", "workspace-1");

    const evidenceOnly = recordDecision(repo, {
      toolName: "fs.write",
      allowed: true,
      countsTowardLimits: false,
    });
    const row = db
      .prepare("SELECT counts_toward_limits FROM tool_access_decisions WHERE decision_id = ?")
      .get(evidenceOnly.decisionId) as { counts_toward_limits: number };
    assert.equal(row.counts_toward_limits, 0);

    assert.equal(repo.countToolCallsInLastHour("fs.write", "agent-1", "session-1"), 0);
    assert.equal(repo.countWritesInLastHour("agent-1", "session-1"), 0);

    recordDecision(repo, {
      toolName: "fs.write",
      allowed: true,
      countsTowardLimits: true,
    });

    assert.equal(repo.countToolCallsInLastHour("fs.write", "agent-1", "session-1"), 1);
    assert.equal(repo.countWritesInLastHour("agent-1", "session-1"), 1);
  });

  it("maps persisted rows defensively", () => {
    assert.deepEqual(
      mapToolAccessDecisionRow({
        decision_id: "decision-1",
        timestamp: "2026-03-24T10:00:00.000Z",
        tool_name: "shell.exec",
        agent_id: "agent-1",
        session_id: "session-1",
        workspace_id: null,
        task_id: null,
        run_id: null,
        allowed: 0,
        reason_codes_json: "not json",
        matched_grant_id: null,
        requires_approval: 1,
        risk_level: "danger",
        permission_profile_id: null,
        local_operator_override_id: null,
        counts_toward_limits: 0,
      }),
      {
        decisionId: "decision-1",
        timestamp: "2026-03-24T10:00:00.000Z",
        toolName: "shell.exec",
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: undefined,
        taskId: undefined,
        runId: undefined,
        allowed: false,
        reasonCodes: [],
        matchedGrantId: undefined,
        requiresApproval: true,
        riskLevel: "danger",
        permissionProfileId: undefined,
        localOperatorOverrideId: undefined,
        countsTowardLimits: false,
      },
    );
  });
});
