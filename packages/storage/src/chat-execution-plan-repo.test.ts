import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatExecutionPlanRepository } from "./chat-execution-plan-repo.js";
import type { DatabaseClient, DbStatement } from "./db.js";

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

function createRepo(): ChatExecutionPlanRepository {
  return createRepoWithDb().repo;
}

function createRepoWithDb(): { repo: ChatExecutionPlanRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-execution-plan-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new ChatExecutionPlanRepository(db),
    db,
  };
}

describe("ChatExecutionPlanRepository", () => {
  it("creates, patches, and reloads execution plans with step linkage", () => {
    const repo = createRepo();

    const created = repo.create({
      sessionId: "sess-1",
      turnId: "turn-1",
      mode: "cowork",
      planningMode: "advisory",
      source: "planner",
      advisoryOnly: true,
      objective: "Investigate the regression",
      summary: "Plan the investigation and stop before execution.",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          objective: "Review recent failures",
          successCriteria: "List the broken paths",
          suggestedTools: ["code.search", "file.read_range"],
          expectedOutput: "Failure inventory",
          parallelizable: false,
          status: "pending",
        },
        {
          stepId: "step-2",
          index: 1,
          objective: "Delegate verification",
          delegatedRole: "qa-validator",
          parallelizable: true,
          dependsOnStepIds: ["step-1"],
          status: "pending",
        },
      ],
    });

    assert.equal(created.objective, "Investigate the regression");
    assert.equal(created.steps.length, 2);
    assert.equal(created.steps[1]?.delegatedRole, "qa-validator");

    const patched = repo.patch(created.planId, {
      status: "running",
      summary: "Investigation is in progress.",
      startedAt: "2026-03-12T10:00:00.000Z",
      steps: [
        {
          ...created.steps[0]!,
          status: "completed",
          summary: "Found two broken retry paths.",
          finishedAt: "2026-03-12T10:01:00.000Z",
        },
        {
          ...created.steps[1]!,
          status: "running",
          childRunId: "delegation-run-1",
          childSessionId: "sess-child-1",
          childTurnId: "turn-child-1",
          startedAt: "2026-03-12T10:01:05.000Z",
        },
      ],
    });

    assert.equal(patched.status, "running");
    assert.equal(patched.summary, "Investigation is in progress.");
    assert.equal(patched.steps[0]?.status, "completed");
    assert.equal(patched.steps[1]?.childSessionId, "sess-child-1");

    const byTurn = repo.listByTurn("turn-1");
    assert.equal(byTurn.length, 1);
    assert.equal(byTurn[0]?.planId, created.planId);

    const bySession = repo.listBySession("sess-1");
    assert.equal(bySession.length, 1);
    assert.equal(bySession[0]?.steps[1]?.childRunId, "delegation-run-1");
  });

  it("allows repeated logical step ids across different plans", () => {
    const repo = createRepo();

    const first = repo.create({
      sessionId: "sess-a",
      turnId: "turn-a",
      mode: "cowork",
      planningMode: "off",
      source: "workflow_template",
      objective: "Plan A",
      summary: "First plan",
      steps: [
        {
          stepId: "orch-step-1",
          index: 0,
          objective: "Research",
          parallelizable: false,
          status: "pending",
        },
        {
          stepId: "orch-step-2",
          index: 1,
          objective: "Synthesize",
          dependsOnStepIds: ["orch-step-1"],
          parallelizable: false,
          status: "pending",
        },
      ],
    });

    const second = repo.create({
      sessionId: "sess-b",
      turnId: "turn-b",
      mode: "cowork",
      planningMode: "off",
      source: "workflow_template",
      objective: "Plan B",
      summary: "Second plan",
      steps: [
        {
          stepId: "orch-step-1",
          index: 0,
          objective: "Research",
          parallelizable: false,
          status: "pending",
        },
        {
          stepId: "orch-step-2",
          index: 1,
          objective: "Critique",
          dependsOnStepIds: ["orch-step-1"],
          parallelizable: false,
          status: "pending",
        },
      ],
    });

    assert.deepEqual(
      first.steps.map((step) => step.stepId),
      ["orch-step-1", "orch-step-2"],
    );
    assert.deepEqual(
      second.steps.map((step) => step.stepId),
      ["orch-step-1", "orch-step-2"],
    );
    assert.deepEqual(second.steps[1]?.dependsOnStepIds, ["orch-step-1"]);
  });

  it("supports execution plan writes inside an outer transaction", () => {
    const { repo, db } = createRepoWithDb();

    db.exec("BEGIN IMMEDIATE");
    try {
      const created = repo.create({
        sessionId: "sess-nested",
        turnId: "turn-nested",
        mode: "cowork",
        planningMode: "off",
        source: "planner",
        objective: "Nested write",
        summary: "Create a plan inside an outer transaction.",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            objective: "Write inside nested transaction",
            parallelizable: false,
            status: "pending",
          },
        ],
      });

      const patched = repo.patch(created.planId, {
        status: "running",
        summary: "Nested write succeeded.",
      });

      assert.equal(patched.status, "running");
      assert.equal(patched.steps[0]?.stepId, "step-1");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  it("reads old rows where step_id lacks the planId prefix", () => {
    const { repo, db } = createRepoWithDb();

    const planId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO chat_execution_plans (
        plan_id, session_id, turn_id, mode, planning_mode, status, source, advisory_only,
        objective, summary, created_at, updated_at
      ) VALUES (?, 'sess-old', 'turn-old', 'cowork', 'off', 'drafted', 'workflow_template', 0,
        'Legacy plan', 'Legacy summary', ?, ?)
    `,
    ).run(planId, now, now);

    // Insert step with OLD format: step_id is just the logical id, no planId prefix
    db.prepare(
      `
      INSERT INTO chat_execution_plan_steps (
        plan_id, step_id, step_index, objective, parallelizable, status
      ) VALUES (?, 'orch-step-1', 0, 'Old step', 0, 'pending')
    `,
    ).run(planId);

    const loaded = repo.get(planId);
    assert.equal(loaded.steps.length, 1);
    // toLogicalExecutionPlanStepId should return the raw value when no prefix matches
    assert.equal(loaded.steps[0]?.stepId, "orch-step-1");
  });

  it("uses the database transaction API for postgres writes", () => {
    const prepareSql: string[] = [];
    const execSql: string[] = [];
    const transactionModes: string[] = [];
    const rows = new Map<
      string,
      {
        plan_id: string;
        session_id: string;
        turn_id: string;
        mode: "cowork";
        planning_mode: "off";
        status: "drafted";
        source: "planner";
        advisory_only: number;
        objective: string;
        summary: string;
        created_at: string;
        updated_at: string;
        started_at: string | null;
        finished_at: string | null;
      }
    >();
    const stepsByPlan = new Map<
      string,
      Array<{
        plan_id: string;
        step_id: string;
        step_index: number;
        objective: string;
        success_criteria: string | null;
        suggested_tools_json: string | null;
        expected_output: string | null;
        parallelizable: number;
        depends_on_step_ids_json: string | null;
        delegated_role: string | null;
        status: "pending";
        summary: string | null;
        error: string | null;
        started_at: string | null;
        finished_at: string | null;
        child_run_id: string | null;
        durable_run_id: string | null;
        child_session_id: string | null;
        child_turn_id: string | null;
      }>
    >();

    const statement: DbStatement = {
      run(first?: unknown) {
        if (!first || typeof first !== "object") {
          return { changes: 0 };
        }
        const record = first as Record<string, unknown>;
        if (typeof record.planId === "string" && typeof record.sessionId === "string") {
          rows.set(record.planId, {
            plan_id: record.planId,
            session_id: String(record.sessionId),
            turn_id: String(record.turnId),
            mode: "cowork",
            planning_mode: "off",
            status: "drafted",
            source: "planner",
            advisory_only: Number(record.advisoryOnly ?? 0),
            objective: String(record.objective),
            summary: String(record.summary),
            created_at: String(record.createdAt),
            updated_at: String(record.updatedAt),
            started_at: record.startedAt ? String(record.startedAt) : null,
            finished_at: record.finishedAt ? String(record.finishedAt) : null,
          });
          return { changes: 1 };
        }
        if (typeof record.planId === "string" && typeof record.stepId === "string") {
          const existing = stepsByPlan.get(record.planId) ?? [];
          existing.push({
            plan_id: record.planId,
            step_id: record.stepId,
            step_index: Number(record.index ?? 0),
            objective: String(record.objective),
            success_criteria: record.successCriteria ? String(record.successCriteria) : null,
            suggested_tools_json: record.suggestedToolsJson ? String(record.suggestedToolsJson) : null,
            expected_output: record.expectedOutput ? String(record.expectedOutput) : null,
            parallelizable: Number(record.parallelizable ?? 0),
            depends_on_step_ids_json: record.dependsOnStepIdsJson ? String(record.dependsOnStepIdsJson) : null,
            delegated_role: record.delegatedRole ? String(record.delegatedRole) : null,
            status: "pending",
            summary: null,
            error: null,
            started_at: null,
            finished_at: null,
            child_run_id: null,
            durable_run_id: null,
            child_session_id: null,
            child_turn_id: null,
          });
          stepsByPlan.set(record.planId, existing);
          return { changes: 1 };
        }
        if (typeof first === "string") {
          stepsByPlan.set(first, []);
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get<T = unknown>(first?: unknown): T | undefined {
        if (typeof first === "string") {
          return rows.get(first) as T | undefined;
        }
        return undefined;
      },
      all<T = unknown>(first?: unknown): T[] {
        if (first && typeof first === "object") {
          const record = first as Record<string, unknown>;
          if (typeof record.planId === "string") {
            return (stepsByPlan.get(record.planId) ?? []) as T[];
          }
        }
        return [] as T[];
      },
    };

    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql: string) {
        prepareSql.push(sql);
        return statement;
      },
      exec(sql: string) {
        execSql.push(sql);
      },
      close() {},
      transaction(mode, callback) {
        transactionModes.push(mode);
        return callback();
      },
    };

    const repo = new ChatExecutionPlanRepository(db);
    const created = repo.create({
      sessionId: "sess-postgres",
      turnId: "turn-postgres",
      mode: "cowork",
      planningMode: "off",
      source: "planner",
      objective: "Postgres-safe write",
      summary: "Use the db transaction helper.",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          objective: "Persist the plan",
          parallelizable: false,
          status: "pending",
        },
      ],
    });

    assert.equal(created.sessionId, "sess-postgres");
    assert.deepEqual(transactionModes, ["immediate"]);
    assert.equal(execSql.length, 0);
    assert.ok(prepareSql.some((sql) => sql.includes("INSERT INTO chat_execution_plans")));
  });
});
