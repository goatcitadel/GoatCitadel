import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssemblyRepository } from "./assembly-repo.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { ChatExecutionPlanRepository } from "./chat-execution-plan-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import type { DatabaseClient, DbStatement } from "./db.js";

function statement(rows: unknown[] = [], row?: unknown): DbStatement {
  return {
    run: () => ({ changes: 1 }),
    get: <T = unknown>() => row as T | undefined,
    all: <T = unknown>() => rows as T[],
  };
}

function fakeDb(resolve: (sql: string) => DbStatement): DatabaseClient {
  return {
    dialect: "sqlite",
    prepare: (sql) => resolve(sql),
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
}

function durableRunRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-1",
    workflow_key: "chat.turn",
    status: "queued",
    attempt_count: 0,
    max_attempts: 3,
    payload_json: "{}",
    metadata_json: null,
    started_at: null,
    finished_at: null,
    last_error: null,
    lease_owner_id: null,
    lease_expires_at: null,
    lease_heartbeat_at: null,
    version: 1,
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: "plan-1",
    session_id: "session-1",
    turn_id: "turn-1",
    mode: "cowork",
    planning_mode: "advisory",
    status: "drafted",
    source: "planner",
    advisory_only: 0,
    objective: "Plan branch tails",
    summary: "",
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function stepRow(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: "plan-1",
    step_id: "plan-1:step-1",
    step_index: 0,
    objective: "Exercise mapper defaults",
    success_criteria: null,
    suggested_tools_json: null,
    expected_output: null,
    parallelizable: 0,
    depends_on_step_ids_json: null,
    delegated_role: null,
    status: "pending",
    summary: null,
    error: null,
    started_at: null,
    finished_at: null,
    child_run_id: null,
    durable_run_id: null,
    child_session_id: null,
    child_turn_id: null,
    ...overrides,
  };
}

function channelDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: "draft-1",
    revision: 1,
    catalog_id: "channel.slack",
    connection_id: null,
    lifecycle_mode: "setup",
    label: null,
    enabled: 0,
    draft_json: "{}",
    secret_refs_json: "{}",
    hydration_json: null,
    content_version: "content.v1",
    adapter_version: "adapter.v1",
    validation_version: "validation.v1",
    test_version: "test.v1",
    last_validated_at: null,
    last_tested_at: null,
    last_failure_category: null,
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function assemblyRunRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "assembly-1",
    workspace_id: null,
    source_session_id: null,
    source_task_id: null,
    source_turn_id: null,
    run_kind: "assembly",
    generation: 0,
    lease_owner_id: null,
    lease_expires_at: null,
    council_resolution_json: null,
    council_evidence_json: null,
    title: "Assembly branch tail",
    status: "running",
    current_stage: "proposal",
    current_round_index: 0,
    problem_json: "{}",
    settings_json: "{}",
    adversarial_settings_json: "{}",
    result_json: null,
    stop_reason: null,
    usage_json: null,
    error_text: null,
    created_at: "2026-05-14T00:00:00.000Z",
    started_at: "2026-05-14T00:00:00.000Z",
    finished_at: null,
    updated_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function assemblyArtifactRow(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: "artifact-1",
    run_id: "assembly-1",
    round_index: 0,
    stage: "proposal",
    artifact_type: "proposal",
    participant_model_ref: null,
    blinded_author_token: null,
    payload_json: "[]",
    created_at: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("storage loop 23 branch tails", () => {
  it("maps durable run rows with malformed JSON fallbacks and filters invalid rows", () => {
    const repo = new DurableRunRepository(
      fakeDb((sql) => {
        if (sql.includes("SELECT * FROM durable_runs") && sql.includes("ORDER BY created_at DESC")) {
          return statement([durableRunRow({ payload_json: "[]", metadata_json: "[]" }), { run_id: 42 }]);
        }
        return statement([], durableRunRow());
      }),
    );

    const runs = repo.listRuns(0);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]?.payload, {});
    assert.equal(runs[0]?.metadata, undefined);
  });

  it("filters execution plan and step rows while preserving explicit false/null mapper defaults", () => {
    const repo = new ChatExecutionPlanRepository(
      fakeDb((sql) => {
        if (sql.includes("WHERE session_id = @sessionId")) {
          return statement([planRow({ advisory_only: 0 }), { plan_id: 1 }]);
        }
        if (sql.includes("WHERE plan_id IN")) {
          return statement([
            stepRow({ step_id: "plan-1:child", parallelizable: 0 }),
            { plan_id: "plan-1", step_id: 1 },
          ]);
        }
        if (sql.includes("WHERE turn_id = @turnId")) {
          return statement([{ plan_id: 1 }]);
        }
        return statement([]);
      }),
    );

    const plans = repo.listBySession("session-1", -1);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.advisoryOnly, false);
    assert.equal(plans[0]?.steps.length, 1);
    assert.equal(plans[0]?.steps[0]?.stepId, "child");
    assert.equal(plans[0]?.steps[0]?.parallelizable, false);
    assert.equal(plans[0]?.steps[0]?.successCriteria, undefined);
    assert.deepEqual(repo.listByTurn("turn-1"), []);
  });

  it("rejects malformed channel setup rows but maps null and explicit false fields", () => {
    const validRepo = new ChannelSetupDraftRepository(
      fakeDb((sql) => {
        if (sql.includes("WHERE catalog_id = @catalogId")) {
          return statement([channelDraftRow()]);
        }
        return statement([]);
      }),
    );

    const [draft] = validRepo.listByCatalog("channel.slack");
    assert.equal(draft?.enabled, false);
    assert.equal(draft?.label, undefined);
    assert.equal(draft?.connectionId, undefined);
    assert.equal(draft?.hydration, undefined);

    const malformedRepo = new ChannelSetupDraftRepository(
      fakeDb((sql) => {
        if (sql.includes("WHERE connection_id = @connectionId")) {
          return statement([channelDraftRow({ label: 5 })]);
        }
        return statement([]);
      }),
    );

    assert.throws(() => malformedRepo.listByConnection("connection-1"), /Unexpected channel setup draft row shape/);
  });

  it("filters assembly rows and falls back when artifact payloads are not records", () => {
    const repo = new AssemblyRepository(
      fakeDb((sql) => {
        if (sql.includes("FROM assembly_runs") && sql.includes("ORDER BY updated_at DESC")) {
          return statement([assemblyRunRow({ result_json: "{bad", usage_json: "{bad" }), { run_id: 1 }]);
        }
        if (sql.includes("FROM assembly_artifacts")) {
          return statement([assemblyArtifactRow({ payload_json: "{bad" }), { artifact_id: 1 }]);
        }
        return statement([]);
      }),
    );

    const runs = repo.listRuns(-10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.result, undefined);
    assert.equal(runs[0]?.usage, undefined);

    const artifacts = repo.listArtifacts("assembly-1");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.artifactType, "proposal");
    assert.deepEqual(artifacts[0]?.payload, {});
  });
});
