import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  MemoryMaintenanceChangeRecord,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceRunSourceRecord,
  MemoryMaintenanceStateRecord,
} from "@goatcitadel/contracts";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { createDatabase } from "./sqlite.js";

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

function createRepoWithDb(): { repo: MemoryMaintenanceRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-memory-maintenance-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new MemoryMaintenanceRepository(db),
    db,
  };
}

function basePolicy(overrides: Partial<MemoryMaintenancePolicyRecord> = {}): MemoryMaintenancePolicyRecord {
  return {
    workspaceId: "workspace-1",
    enabled: true,
    runMode: "hybrid",
    timingStrategy: "fixed",
    schedule: {
      frequency: "weekly",
      hour: 2,
      minute: 30,
      weekday: 1,
    },
    timeZone: "America/Los_Angeles",
    minHoursSinceLastSuccess: 24,
    minChangedSessions: 3,
    providerId: " openai ",
    model: " gpt-5.2 ",
    executionTarget: "cloud",
    unavailableModelPolicy: "skip",
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T10:00:00.000Z",
    ...overrides,
  };
}

function insertEligibleSession(input: {
  db: ReturnType<typeof createDatabase>;
  sessionId: string;
  workspaceId: string;
  finishedAt: string;
  includeInHistory?: number;
  origin?: string | null;
  assistantMessageId?: string | null;
}): void {
  const now = input.finishedAt;
  input.db
    .prepare(
      `
    INSERT INTO chat_session_meta (
      session_id,
      workspace_id,
      title,
      origin,
      include_in_history,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.sessionId,
      input.workspaceId,
      `Session ${input.sessionId}`,
      input.origin ?? "operator",
      input.includeInHistory ?? 1,
      now,
      now,
    );
  input.db
    .prepare(
      `
    INSERT INTO chat_session_bindings (
      session_id,
      transport,
      writable,
      created_at,
      updated_at
    ) VALUES (?, 'llm', 1, ?, ?)
  `,
    )
    .run(input.sessionId, now, now);
  input.db
    .prepare(
      `
    INSERT INTO chat_turn_traces (
      turn_id,
      session_id,
      user_message_id,
      assistant_message_id,
      status,
      mode,
      web_mode,
      memory_mode,
      thinking_level,
      routing_json,
      started_at,
      finished_at
    ) VALUES (?, ?, ?, ?, 'completed', 'chat', 'off', 'auto', 'standard', '{}', ?, ?)
  `,
    )
    .run(
      `turn-${input.sessionId}`,
      input.sessionId,
      `user-${input.sessionId}`,
      input.assistantMessageId ?? `assistant-${input.sessionId}`,
      now,
      input.finishedAt,
    );
}

describe("MemoryMaintenanceRepository", () => {
  it("tracks eligibility, policies, state, runs, sources, changes, and recommendations", () => {
    const { repo, db } = createRepoWithDb();

    assert.deepEqual(repo.listEnabledPolicyWorkspaceIds(), []);
    assert.equal(repo.findPolicy("workspace-1"), undefined);
    assert.throws(() => repo.requirePolicy("workspace-1"), /Memory maintenance policy/);
    assert.equal(repo.findState("workspace-1"), undefined);
    assert.throws(() => repo.requireState("workspace-1"), /Memory maintenance state/);
    assert.throws(() => repo.getRun("missing-run"), /Memory maintenance run/);
    assert.throws(() => repo.getRecommendation("missing-rec"), /Memory maintenance recommendation/);

    const storedPolicy = repo.upsertPolicy(basePolicy({ providerId: "  ", model: "" }));
    assert.deepEqual(storedPolicy, {
      ...basePolicy({ providerId: undefined, model: undefined }),
      providerId: undefined,
      model: undefined,
    });
    assert.deepEqual(repo.listEnabledPolicyWorkspaceIds(), ["workspace-1"]);

    const patchedPolicy = repo.patchPolicy(
      "workspace-1",
      {
        enabled: false,
        schedule: null,
        providerId: "anthropic",
        model: null,
        executionTarget: "local",
        unavailableModelPolicy: "error",
      },
      basePolicy(),
      "2026-03-20T11:00:00.000Z",
    );
    assert.equal(patchedPolicy.enabled, false);
    assert.equal(patchedPolicy.schedule, undefined);
    assert.equal(patchedPolicy.providerId, "anthropic");
    assert.equal(patchedPolicy.model, undefined);
    assert.equal(patchedPolicy.executionTarget, "local");
    assert.equal(patchedPolicy.updatedAt, "2026-03-20T11:00:00.000Z");
    assert.deepEqual(repo.listEnabledPolicyWorkspaceIds(), []);

    const defaultPolicy = basePolicy({ workspaceId: "workspace-2", enabled: true });
    const createdFromDefaults = repo.patchPolicy(
      "workspace-2",
      { minChangedSessions: 8 },
      defaultPolicy,
      "2026-03-20T12:00:00.000Z",
    );
    assert.equal(createdFromDefaults.workspaceId, "workspace-2");
    assert.equal(createdFromDefaults.minChangedSessions, 8);
    assert.equal(createdFromDefaults.createdAt, defaultPolicy.createdAt);

    const state: MemoryMaintenanceStateRecord = {
      workspaceId: "workspace-1",
      changedSessionCount: 2,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:00:00.000Z",
    };
    assert.deepEqual(repo.upsertState(state), {
      ...state,
      lastEligibilityAt: undefined,
      lastSuccessfulRunAt: undefined,
      activeRunId: undefined,
      lastRecommendationAt: undefined,
    });
    assert.deepEqual(
      repo.upsertState({
        ...state,
        lastEligibilityAt: "2026-03-20T10:05:00.000Z",
        lastSuccessfulRunAt: "2026-03-20T10:10:00.000Z",
        activeRunId: "run-active",
        lastRecommendationAt: "2026-03-20T10:15:00.000Z",
        updatedAt: "2026-03-20T10:20:00.000Z",
      }),
      {
        ...state,
        lastEligibilityAt: "2026-03-20T10:05:00.000Z",
        lastSuccessfulRunAt: "2026-03-20T10:10:00.000Z",
        activeRunId: "run-active",
        lastRecommendationAt: "2026-03-20T10:15:00.000Z",
        updatedAt: "2026-03-20T10:20:00.000Z",
      },
    );

    insertEligibleSession({
      db,
      sessionId: "sess-new",
      workspaceId: "workspace-1",
      finishedAt: "2026-03-20T10:30:00.000Z",
    });
    insertEligibleSession({
      db,
      sessionId: "sess-old",
      workspaceId: "workspace-1",
      finishedAt: "2026-03-19T10:30:00.000Z",
    });
    insertEligibleSession({
      db,
      sessionId: "sess-hidden",
      workspaceId: "workspace-1",
      finishedAt: "2026-03-20T10:35:00.000Z",
      includeInHistory: 0,
    });
    insertEligibleSession({
      db,
      sessionId: "sess-other",
      workspaceId: "workspace-2",
      finishedAt: "2026-03-20T10:40:00.000Z",
    });

    assert.equal(repo.countChangedSessions("workspace-1"), 2);
    assert.equal(repo.countChangedSessions("workspace-1", "2026-03-20T00:00:00.000Z"), 1);
    assert.deepEqual(repo.listEligibleSessions("workspace-1", undefined, 0), [
      {
        sessionId: "sess-new",
        modifiedAt: "2026-03-20T10:30:00.000Z",
      },
    ]);
    assert.deepEqual(repo.listEligibleSessions("workspace-1", "2026-03-20T00:00:00.000Z", 500), [
      {
        sessionId: "sess-new",
        modifiedAt: "2026-03-20T10:30:00.000Z",
      },
    ]);

    db.prepare(
      `
      INSERT INTO memory_items (
        item_id,
        namespace,
        title,
        content,
        metadata_json,
        pinned,
        ttl_override_seconds,
        expires_at,
        status,
        created_at,
        updated_at
      ) VALUES
        ('mem-1', 'workspace-1', 'Pinned memory', 'Remember this', '{"priority":"high"}', 1, 3600, NULL, 'active', '2026-03-20T09:00:00.000Z', '2026-03-20T10:00:00.000Z'),
        ('mem-2', 'workspace-1', 'Bad metadata', 'Fallback object', '[]', 0, NULL, NULL, 'active', '2026-03-20T09:05:00.000Z', '2026-03-20T09:50:00.000Z'),
        ('mem-expired', 'workspace-1', 'Expired', 'Ignore', '{}', 0, NULL, '2020-01-01T00:00:00.000Z', 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `,
    ).run();
    const memoryItems = repo.listActiveMemoryItems(999);
    assert.equal(memoryItems.length, 2);
    assert.equal(memoryItems[0]?.itemId, "mem-1");
    assert.equal(memoryItems[0]?.pinned, true);
    assert.equal(memoryItems[0]?.ttlOverrideSeconds, 3600);
    assert.deepEqual(memoryItems[0]?.metadata, { priority: "high" });
    assert.deepEqual(memoryItems[1]?.metadata, {});

    db.prepare(
      `
      INSERT INTO chat_tool_artifacts (
        artifact_id,
        session_id,
        turn_id,
        tool_run_id,
        tool_name,
        content_type,
        byte_length,
        snippet,
        storage_rel_path,
        created_at
      ) VALUES
        ('artifact-new', 'sess-new', 'turn-sess-new', 'tool-run-1', 'read_file', 'text/plain', 120, 'hello', 'artifacts/new.txt', '2026-03-20T10:31:00.000Z'),
        ('artifact-old', 'sess-old', 'turn-sess-old', 'tool-run-2', 'search', NULL, 80, NULL, 'artifacts/old.txt', '2026-03-19T10:31:00.000Z')
    `,
    ).run();
    assert.deepEqual(repo.listRecentToolArtifacts("workspace-1", undefined, 0), [
      {
        artifactId: "artifact-new",
        toolName: "read_file",
        sessionId: "sess-new",
        byteLength: 120,
        snippet: "hello",
        contentType: "text/plain",
        createdAt: "2026-03-20T10:31:00.000Z",
      },
    ]);
    assert.deepEqual(repo.listRecentToolArtifacts("workspace-1", "2026-03-20T00:00:00.000Z", 1000), [
      {
        artifactId: "artifact-new",
        toolName: "read_file",
        sessionId: "sess-new",
        byteLength: 120,
        snippet: "hello",
        contentType: "text/plain",
        createdAt: "2026-03-20T10:31:00.000Z",
      },
    ]);
    assert.equal(repo.listRecentToolArtifacts("workspace-1", undefined, 10)[1]?.snippet, undefined);

    const createdRun = repo.createRun({
      durableRunId: "  ",
      workspaceId: "workspace-1",
      triggerSource: "manual",
      status: "queued",
      providerId: "  ",
      model: "",
      policySnapshot: { version: 1 },
      sourceSessionCount: 2,
      changedArtifactCount: 1,
      summary: "",
      error: "  ",
      createdAt: "2026-03-20T10:45:00.000Z",
      updatedAt: "2026-03-20T10:45:00.000Z",
    });
    assert.match(createdRun.runId, /^mmrun_[a-f0-9]{24}$/);
    assert.equal(createdRun.providerId, undefined);
    assert.deepEqual(createdRun.policySnapshot, { version: 1 });

    const runWithDurableId = repo.createRun({
      runId: "run-durable",
      durableRunId: "durable-1",
      workspaceId: "workspace-1",
      triggerSource: "scheduled",
      status: "running",
      providerId: "openai",
      model: "gpt-5.2",
      policySnapshot: { version: 2 },
      sourceSessionCount: 1,
      changedArtifactCount: 0,
      summary: "started",
      error: undefined,
      createdAt: "2026-03-20T10:50:00.000Z",
      startedAt: "2026-03-20T10:51:00.000Z",
      updatedAt: "2026-03-20T10:51:00.000Z",
    });
    assert.deepEqual(repo.findRunByDurableRunId("durable-1"), runWithDurableId);

    const updatedRun: MemoryMaintenanceRunRecord = {
      ...runWithDurableId,
      status: "completed",
      changedArtifactCount: 2,
      summary: "completed",
      error: "none",
      finishedAt: "2026-03-20T11:00:00.000Z",
      updatedAt: "2026-03-20T11:00:00.000Z",
    };
    assert.deepEqual(repo.updateRun(updatedRun), updatedRun);
    assert.deepEqual(
      repo.listRuns("workspace-1", 1000).map((run) => run.runId),
      ["run-durable", createdRun.runId],
    );

    const sources: MemoryMaintenanceRunSourceRecord[] = [
      {
        sourceId: "source-1",
        runId: "run-durable",
        sourceKind: "transcript",
        sourceRef: "sess-new",
        modifiedAt: "2026-03-20T10:30:00.000Z",
        excerpt: "Conversation excerpt",
        tokenEstimate: 42,
        createdAt: "2026-03-20T10:52:00.000Z",
      },
      {
        sourceId: "source-2",
        runId: "run-durable",
        sourceKind: "artifact",
        sourceRef: "artifact-new",
        modifiedAt: undefined,
        excerpt: undefined,
        tokenEstimate: undefined,
        createdAt: "2026-03-20T10:53:00.000Z",
      },
    ];
    assert.deepEqual(repo.replaceRunSources("run-durable", sources), sources);
    assert.deepEqual(repo.replaceRunSources("run-durable", []), []);

    const changes: MemoryMaintenanceChangeRecord[] = [
      {
        changeId: "change-1",
        runId: "run-durable",
        changeKind: "updated",
        targetKind: "memory_item",
        targetRef: "mem-1",
        beforeRef: "before",
        afterRef: "after",
        summary: "Updated memory",
        createdAt: "2026-03-20T10:54:00.000Z",
      },
      {
        changeId: "change-2",
        runId: "run-durable",
        changeKind: "mirrored",
        targetKind: "file",
        targetRef: "notes.md",
        beforeRef: undefined,
        afterRef: undefined,
        summary: "Mirrored to file",
        createdAt: "2026-03-20T10:55:00.000Z",
      },
    ];
    assert.deepEqual(repo.replaceRunChanges("run-durable", changes), changes);
    assert.deepEqual(repo.replaceRunChanges("run-durable", []), []);

    const recommendation = repo.createRecommendation({
      workspaceId: "workspace-1",
      kind: "schedule_adjustment",
      status: "queued",
      summary: "Run weekly",
      proposedPatch: { timingStrategy: "fixed" },
      rationale: "Enough changes accumulated.",
      createdAt: "2026-03-20T11:05:00.000Z",
      updatedAt: "2026-03-20T11:05:00.000Z",
    });
    assert.match(recommendation.recommendationId, /^mmrec_[a-f0-9]{24}$/);

    const updatedRecommendation: MemoryMaintenanceRecommendationRecord = {
      ...recommendation,
      status: "applied",
      summary: "Run weekly after acceptance",
      proposedPatch: { minChangedSessions: 8 },
      rationale: undefined,
      appliedAt: "2026-03-20T11:10:00.000Z",
      updatedAt: "2026-03-20T11:10:00.000Z",
    };
    assert.deepEqual(repo.updateRecommendation(updatedRecommendation), updatedRecommendation);
    assert.deepEqual(repo.listRecommendations("workspace-1", 1000), [updatedRecommendation]);
  });

  it("preserves maintenance defaults and filters malformed adapter rows", () => {
    const { repo } = createRepoWithDb();
    const policy = repo.upsertPolicy(basePolicy());

    const preservedPolicy = repo.patchPolicy("workspace-1", {}, basePolicy(), "2026-03-21T00:00:00.000Z");
    assert.deepEqual(preservedPolicy, {
      ...policy,
      providerId: "openai",
      model: "gpt-5.2",
      updatedAt: "2026-03-21T00:00:00.000Z",
    });

    const clearedPolicy = repo.patchPolicy(
      "workspace-1",
      {
        providerId: null,
        model: null,
        schedule: null,
      },
      basePolicy(),
      "2026-03-21T00:05:00.000Z",
    );
    assert.equal(clearedPolicy.providerId, undefined);
    assert.equal(clearedPolicy.model, undefined);
    assert.equal(clearedPolicy.schedule, undefined);

    const state = repo.upsertState({
      workspaceId: "workspace-1",
      lastEligibilityAt: "2026-03-21T00:00:00.000Z",
      lastSuccessfulRunAt: "2026-03-21T00:01:00.000Z",
      changedSessionCount: 4,
      activeRunId: "run-active",
      lastRecommendationAt: "2026-03-21T00:02:00.000Z",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:03:00.000Z",
    });
    assert.equal(state.activeRunId, "run-active");

    const run = repo.createRun({
      runId: "run-defaults",
      durableRunId: "durable-defaults",
      workspaceId: "workspace-1",
      triggerSource: "manual",
      status: "running",
      providerId: "openai",
      model: "gpt-5.2",
      policySnapshot: undefined as unknown as Record<string, unknown>,
      sourceSessionCount: 0,
      changedArtifactCount: 0,
      summary: "running",
      error: undefined,
      createdAt: "2026-03-21T00:10:00.000Z",
      startedAt: "2026-03-21T00:10:00.000Z",
      updatedAt: "2026-03-21T00:10:00.000Z",
    });
    assert.deepEqual(run.policySnapshot, {});
    assert.deepEqual(
      repo.updateRun({
        ...run,
        policySnapshot: undefined as unknown as Record<string, unknown>,
        sourceSessionCount: 0,
        changedArtifactCount: 0,
        startedAt: undefined,
        finishedAt: undefined,
        updatedAt: "2026-03-21T00:11:00.000Z",
      }),
      {
        ...run,
        policySnapshot: {},
        sourceSessionCount: 0,
        changedArtifactCount: 0,
        startedAt: undefined,
        finishedAt: undefined,
        updatedAt: "2026-03-21T00:11:00.000Z",
      },
    );
    assert.deepEqual(
      repo.replaceRunSources("run-defaults", [
        {
          sourceId: "source-defaults",
          runId: "run-defaults",
          sourceKind: "transcript",
          sourceRef: "session-defaults",
          modifiedAt: undefined,
          excerpt: "   ",
          tokenEstimate: undefined,
          createdAt: "2026-03-21T00:12:00.000Z",
        },
      ]),
      [
        {
          sourceId: "source-defaults",
          runId: "run-defaults",
          sourceKind: "transcript",
          sourceRef: "session-defaults",
          modifiedAt: undefined,
          excerpt: undefined,
          tokenEstimate: undefined,
          createdAt: "2026-03-21T00:12:00.000Z",
        },
      ],
    );
    assert.deepEqual(
      repo.replaceRunChanges("run-defaults", [
        {
          changeId: "change-defaults",
          runId: "run-defaults",
          changeKind: "updated",
          targetKind: "memory_item",
          targetRef: "memory-defaults",
          beforeRef: "   ",
          afterRef: undefined,
          summary: "Updated memory defaults",
          createdAt: "2026-03-21T00:13:00.000Z",
        },
      ]),
      [
        {
          changeId: "change-defaults",
          runId: "run-defaults",
          changeKind: "updated",
          targetKind: "memory_item",
          targetRef: "memory-defaults",
          beforeRef: undefined,
          afterRef: undefined,
          summary: "Updated memory defaults",
          createdAt: "2026-03-21T00:13:00.000Z",
        },
      ],
    );

    const recommendation = repo.createRecommendation({
      recommendationId: "rec-defaults",
      workspaceId: "workspace-1",
      kind: "threshold_adjustment",
      status: "queued",
      summary: "Patch policy",
      proposedPatch: undefined as unknown as Record<string, unknown>,
      rationale: "  ",
      createdAt: "2026-03-21T00:15:00.000Z",
      updatedAt: "2026-03-21T00:15:00.000Z",
    });
    assert.deepEqual(recommendation.proposedPatch, {});
    assert.equal(recommendation.rationale, undefined);
    assert.deepEqual(
      repo.updateRecommendation({
        ...recommendation,
        proposedPatch: undefined as unknown as Record<string, unknown>,
        appliedAt: undefined,
        updatedAt: "2026-03-21T00:16:00.000Z",
      }),
      {
        ...recommendation,
        proposedPatch: {},
        appliedAt: undefined,
        updatedAt: "2026-03-21T00:16:00.000Z",
      },
    );

    const internal = repo as unknown as {
      getPolicyStmt: { get: (...args: unknown[]) => unknown };
      getStateStmt: { get: (...args: unknown[]) => unknown };
      getRunStmt: { get: (...args: unknown[]) => unknown };
      getRunByDurableRunStmt: { get: (...args: unknown[]) => unknown };
      listRunsStmt: { all: (...args: unknown[]) => unknown };
      listRunSourcesStmt: { all: (...args: unknown[]) => unknown };
      listRunChangesStmt: { all: (...args: unknown[]) => unknown };
      getRecommendationStmt: { get: (...args: unknown[]) => unknown };
      listRecommendationsStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.getPolicyStmt = { get: () => ({ workspace_id: 1 }) };
    internal.getStateStmt = { get: () => ({ workspace_id: 1 }) };
    internal.getRunStmt = { get: () => ({ run_id: 1 }) };
    internal.getRunByDurableRunStmt = { get: () => ({ run_id: 1 }) };
    internal.listRunsStmt = { all: () => ({ not: "an array" }) };
    internal.listRunSourcesStmt = { all: () => [null, { source_id: 1 }] };
    internal.listRunChangesStmt = { all: () => [null, { change_id: 1 }] };
    internal.getRecommendationStmt = { get: () => ({ recommendation_id: 1 }) };
    internal.listRecommendationsStmt = { all: () => ({ not: "an array" }) };

    assert.equal(repo.findPolicy("workspace-1"), undefined);
    assert.equal(repo.findState("workspace-1"), undefined);
    assert.throws(() => repo.getRun("run-defaults"), /Memory maintenance run/);
    assert.equal(repo.findRunByDurableRunId("durable-defaults"), undefined);
    assert.deepEqual(repo.listRuns("workspace-1"), []);
    assert.deepEqual(repo.listRunSources("run-defaults"), []);
    assert.deepEqual(repo.listRunChanges("run-defaults"), []);
    assert.throws(() => repo.getRecommendation("rec-defaults"), /Memory maintenance recommendation/);
    assert.deepEqual(repo.listRecommendations("workspace-1"), []);
  });
});
