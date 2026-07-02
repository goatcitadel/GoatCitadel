import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  AssemblyRunRecord,
  ImportedAgentCatalogRecord,
  MemoryMaintenanceRunRecord,
  OrchestrationPlan,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import { ApprovalEffectRepository } from "./approval-effect-repo.js";
import { AgentProfileRepository } from "./agent-profile-repo.js";
import { AssemblyRepository } from "./assembly-repo.js";
import { ChatDelegationRunRepository } from "./chat-delegation-run-repo.js";
import { ContextManifestRepository } from "./context-manifest-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { ImportedAgentCatalogRepository } from "./imported-agent-catalog-repo.js";
import { MemoryContextRepository } from "./memory-context-repo.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { OrchestrationRepository } from "./orchestration-repo.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore cleanup noise from locked temp handles.
    }
  }
});

function createDb(name: string): ReturnType<typeof createDatabase> {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-${name}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

function insertApproval(db: ReturnType<typeof createDatabase>, approvalId: string): void {
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id,
      kind,
      risk_level,
      status,
      payload_json,
      preview_json,
      explanation_status,
      created_at
    ) VALUES (?, 'tool_call', 'caution', 'approved', '{}', '{}', 'not_requested', ?)
  `,
  ).run(approvalId, "2026-05-14T10:00:00.000Z");
}

function assemblyRun(runId: string): AssemblyRunRecord {
  return {
    runId,
    title: "Tail matrix",
    status: "queued",
    currentStage: "S0_normalize",
    currentRoundIndex: 0,
    problem: {
      runId,
      domain: "coding",
      title: "Close branch tails",
      originalPrompt: "Close branch tails without changing behavior.",
      normalizedStatement: "Close branch tails without changing behavior.",
      objectives: [],
      constraints: [],
      evaluationCriteria: [],
      contextRefs: [],
      createdAt: "2026-05-14T10:00:00.000Z",
    },
    settings: {
      mode: "consensus",
      participantModels: [],
      maxRounds: 1,
      maxCritiquePasses: 0,
      maxInterModelExchanges: 0,
      convergenceThreshold: 0.8,
      stagnationWindow: 1,
      timeBudgetMs: 1000,
      tokenBudget: 1000,
      costBudgetUsd: 1,
      domainPreset: "coding",
      synthesisStyle: "balanced",
      exportTargets: [],
    },
    adversarialSettings: {
      enabled: false,
      reviewerCount: 0,
      selectionStrategy: "user_selected",
      strictness: "balanced",
      requireMitigations: true,
      requireEvidenceTags: true,
      defenseRoundEnabled: false,
      repetitiveObjectionCutoff: true,
      minorityReportRequired: true,
    },
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:00.000Z",
  };
}

function importedAgentRecord(entryId: string): ImportedAgentCatalogRecord {
  return {
    entryId,
    workspaceId: "workspace-loop7",
    division: "research",
    state: "approved",
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:00.000Z",
    definition: {
      definitionId: `definition-${entryId}`,
      slug: `agent-${entryId}`,
      frontmatter: {
        name: "Loop 7 Researcher",
        description: "Tests imported catalog tail defaults",
      },
      rawMarkdown: "# Loop 7 Researcher\n\nBody",
      bodyMarkdown: "Body",
      sectionOrder: ["purpose", "missing"],
      sectionMap: {
        purpose: {
          key: "purpose",
          slug: "purpose",
          heading: "Purpose",
          level: 2,
          kind: "persona",
          content: "Find source-backed branch-tail evidence.",
        },
      },
      parseStatus: "supported",
      parseWarnings: [],
      provenance: {
        provider: "manual",
        path: "agents/researcher.md",
        sha256: "sha-loop7",
        importedAt: "2026-05-14T10:00:00.000Z",
      },
    },
  };
}

describe("storage branch-tail matrices", () => {
  it("covers durable run optimistic updates, lease defaults, and adapter row fallbacks", () => {
    const repo = new DurableRunRepository(createDb("durable-loop7"));
    const run = repo.createRun({
      runId: "run-loop7",
      workflowKey: "loop7.tail",
      metadata: { owner: "loop7" },
      startedAt: "2026-05-14T10:00:00.000Z",
      now: "2026-05-14T10:00:00.000Z",
    });

    const updated = repo.updateRun({
      runId: run.runId,
      status: "running",
      attemptCount: 2.9,
      maxAttempts: 3.1,
      payload: { phase: "branch-tail" },
      metadata: null as never,
      lastError: "   ",
      clearLease: false,
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.attemptCount, 2);
    assert.equal(updated.maxAttempts, 3);
    assert.deepEqual(updated.metadata, undefined);
    assert.equal(updated.lastError, undefined);

    const queued = repo.createRun({
      runId: "run-loop7-queued",
      workflowKey: "loop7.lease",
      metadata: { lease: true },
      now: "2026-05-14T10:01:00.000Z",
    });
    const claimed = repo.tryClaimQueuedRun({
      runId: queued.runId,
      workerId: "worker-loop7",
      leaseHeartbeatAt: "2026-05-14T10:02:00.000Z",
      leaseExpiresAt: "2026-05-14T10:07:00.000Z",
    });
    assert.equal(claimed?.startedAt, "2026-05-14T10:02:00.000Z");
    assert.deepEqual(claimed?.metadata, { lease: true });

    const internal = repo as unknown as {
      statusCountsStmt: { all: () => unknown };
    };
    internal.statusCountsStmt = { all: () => [{ status: "queued", count: null }] };
    assert.deepEqual(repo.statusCounts(), { queued: 0 });
  });

  it("covers memory-maintenance null row values and empty source/change adapters", () => {
    const repo = new MemoryMaintenanceRepository(createDb("memory-maintenance-loop7"));
    const run: MemoryMaintenanceRunRecord = {
      runId: "mmrun-loop7",
      durableRunId: undefined,
      workspaceId: "workspace-loop7",
      triggerSource: "manual",
      status: "queued",
      providerId: undefined,
      model: undefined,
      policySnapshot: {},
      sourceSessionCount: 0,
      changedArtifactCount: 0,
      summary: undefined,
      error: undefined,
      createdAt: "2026-05-14T10:00:00.000Z",
      updatedAt: "2026-05-14T10:00:00.000Z",
    };
    const created = repo.createRun(run);
    assert.equal(created.runId, run.runId);
    assert.equal(created.startedAt, undefined);
    assert.equal(created.finishedAt, undefined);
    const completed = repo.updateRun({ ...run, status: "completed" });
    assert.equal(completed.status, "completed");
    assert.equal(completed.startedAt, undefined);
    assert.equal(completed.finishedAt, undefined);

    const internal = repo as unknown as {
      countChangedSessionsStmt: { get: () => unknown };
      listEligibleSessionsStmt: { all: () => unknown };
      listRunSourcesStmt: { all: () => unknown };
      listRunChangesStmt: { all: () => unknown };
    };
    internal.countChangedSessionsStmt = { get: () => ({ count: null }) };
    internal.listEligibleSessionsStmt = {
      all: () => [{ session_id: "session-loop7", modified_at: null }],
    };
    internal.listRunSourcesStmt = { all: () => ({ not: "rows" }) };
    internal.listRunChangesStmt = { all: () => ({ not: "rows" }) };

    assert.equal(repo.countChangedSessions("workspace-loop7"), 0);
    assert.deepEqual(repo.listEligibleSessions("workspace-loop7"), [
      { sessionId: "session-loop7", modifiedAt: new Date(0).toISOString() },
    ]);
    assert.deepEqual(repo.listRunSources(run.runId), []);
    assert.deepEqual(repo.listRunChanges(run.runId), []);
  });

  it("covers orchestration optional run fields and checkpoint adapter filters", () => {
    const repo = new OrchestrationRepository(createDb("orchestration-loop7"));
    const plan: OrchestrationPlan = {
      planId: "plan-loop7",
      goal: "Close tails",
      mode: "hitl",
      maxIterations: 1,
      maxRuntimeMinutes: 5,
      maxCostUsd: 1,
      waves: [],
    };
    repo.upsertPlan(plan);

    const run: OrchestrationRun = {
      runId: "run-loop7",
      planId: plan.planId,
      status: "running",
      startedAt: "2026-05-14T10:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
    };
    repo.createRun(run);
    const updatedWithEmptyOptionals = repo.updateRun({
      ...run,
      endedAt: undefined,
      currentWaveId: undefined,
      currentPhaseId: undefined,
      workspaceId: undefined,
      durableRunId: undefined,
      executionState: undefined,
      worktreePath: undefined,
      worktreeStatus: undefined,
      worktreeBaseRef: undefined,
      pendingApprovalPhaseId: undefined,
      pendingApprovedBy: undefined,
      pendingCostIncrementUsd: undefined,
      lastError: undefined,
    });
    assert.equal(updatedWithEmptyOptionals.workspaceId, undefined);
    assert.equal(updatedWithEmptyOptionals.pendingApprovalPhaseId, undefined);
    const completed = repo.updateRunIfCurrentState(
      { ...run, status: "completed" },
      { status: "running", executionState: undefined },
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.executionState, undefined);
    assert.equal(completed?.workspaceId, undefined);

    const internal = repo as unknown as {
      listCheckpointsStmt: { all: () => unknown };
    };
    internal.listCheckpointsStmt = { all: () => [{ checkpoint_id: 1 }, null] };
    assert.deepEqual(repo.listCheckpoints(run.runId), []);
  });

  it("covers prompt-pack inherited policy fallbacks and malformed adapter rows", () => {
    const repo = new PromptPackRepository(createDb("prompt-pack-loop7"));
    const stored = repo.replacePackTests({
      packId: "pack-loop7",
      name: "Loop 7 Pack",
      sourceLabel: undefined,
      tests: [
        {
          code: "TEST-L7",
          title: "Loop 7",
          prompt: "Exercise prompt-pack branch tails.",
          orderIndex: 0,
        },
      ],
      policySource: "pack_override",
    });
    assert.equal(stored.pack.sourceLabel, undefined);
    assert.equal(stored.tests[0]?.mode, undefined);
    assert.equal(stored.tests[0]?.toolTier, undefined);

    const internal = repo as unknown as {
      listPacksStmt: { all: () => unknown };
      listTestsStmt: { all: () => unknown };
    };
    internal.listPacksStmt = { all: () => ({ not: "rows" }) };
    internal.listTestsStmt = { all: () => [null, { test_id: 1 }] };
    assert.deepEqual(repo.listPacks(), []);
    assert.deepEqual(repo.listTests("pack-loop7"), []);
  });

  it("covers approval effect defaulting with legacy and current rows", () => {
    const db = createDb("approval-effect-loop7");
    const repo = new ApprovalEffectRepository(db);
    insertApproval(db, "approval-loop7");

    const pending = repo.upsert({
      approvalId: "approval-loop7",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-loop7",
      payload: undefined,
      result: undefined,
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.attemptCount, 0);
    assert.deepEqual(pending.payload, {});
    assert.deepEqual(pending.result, {});

    const internal = repo as unknown as {
      getByIdStmt: { get: () => unknown };
    };
    internal.getByIdStmt = {
      get: () => ({
        effect_id: "effect-legacy-detail-only",
        approval_id: "approval-loop7",
        effect_kind: "wake_durable_run",
        target_kind: null,
        target_id: "run-loop7",
        idempotency_key: null,
        status: "pending",
        outcome: null,
        detail: "detail only",
        details_json: null,
        attempt_count: null,
        payload_json: null,
        result_json: null,
        last_error: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        version: null,
        created_at: "2026-05-14T10:00:00.000Z",
        updated_at: "2026-05-14T10:00:00.000Z",
        completed_at: null,
      }),
    };
    assert.deepEqual(repo.get("effect-legacy-detail-only").result, { detail: "detail only" });
  });

  it("covers assembly fallback parsing and post-write lookup fallbacks", () => {
    const repo = new AssemblyRepository(createDb("assembly-loop7"));
    const run = assemblyRun("assembly-loop7");
    repo.createRun(run);

    const internal = repo as unknown as {
      listRounds: (runId: string) => ReturnType<AssemblyRepository["listRounds"]>;
      listReputations: (limit?: number) => ReturnType<AssemblyRepository["listReputations"]>;
    };
    internal.listRounds = () => [];
    assert.deepEqual(
      repo.saveRound({
        roundId: "round-loop7",
        runId: run.runId,
        roundIndex: 0,
        stage: "S1_submit",
        status: "running",
        participantIds: [],
        artifactIds: [],
        startedAt: "2026-05-14T10:01:00.000Z",
      }),
      {
        roundId: "round-loop7",
        runId: run.runId,
        roundIndex: 0,
        stage: "S1_submit",
        status: "running",
        participantIds: [],
        artifactIds: [],
        startedAt: "2026-05-14T10:01:00.000Z",
      },
    );

    internal.listReputations = () => [];
    const reputation = {
      modelRef: "openai:gpt-5.5",
      providerId: "openai",
      modelId: "gpt-5.5",
      overall: 0.5,
      byDomain: {},
      accuracy: 0.5,
      reasoningStrength: 0.5,
      critiqueQuality: 0.5,
      consensusLeadership: 0.5,
      stability: 0.5,
      adversarialUsefulness: 0.5,
      sampleCount: 1,
      updatedAt: "2026-05-14T10:02:00.000Z",
    };
    assert.deepEqual(repo.upsertReputation(reputation), reputation);
  });

  it("covers context manifest optional defaults, duplicate suppression, and malformed details", () => {
    const repo = new ContextManifestRepository(createDb("context-manifest-loop8"));
    const manifest = repo.ensure({
      scope: "chat_turn",
      turnId: "turn-loop8",
      createdAt: "2026-05-14T11:00:00.000Z",
    });
    assert.equal(manifest.sessionId, undefined);
    assert.equal(manifest.taskId, undefined);

    const entry = repo.appendEntry({
      manifestId: manifest.manifestId,
      kind: "memory_context",
      entryIndex: 0,
      metadata: [] as unknown as Record<string, unknown>,
      createdAt: "2026-05-14T11:00:01.000Z",
    });
    assert.equal(entry?.title, undefined);
    assert.equal(entry?.sourceRef, undefined);
    assert.equal(entry?.contentText, undefined);
    assert.deepEqual(entry?.metadata, []);

    const internal = repo as unknown as {
      insertEntryStmt: { run: (...args: unknown[]) => unknown };
      listEntriesStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.insertEntryStmt = { run: () => ({ changes: undefined }) };
    assert.equal(
      repo.appendEntry({
        manifestId: manifest.manifestId,
        kind: "memory_context",
        entryIndex: 1,
        contentText: "not inserted",
      }),
      undefined,
    );
    internal.listEntriesStmt = { all: () => ({ not: "rows" }) };
    assert.deepEqual(repo.listEntries(manifest.manifestId), []);
  });

  it("covers prompt-pack run optional create, profile patch, and adapter fallbacks", () => {
    const repo = new PromptPackRunRepository(createDb("prompt-pack-run-loop8"));
    const created = repo.create({
      runId: "pprun-loop8",
      packId: "pack-loop8",
      testId: "TEST-LOOP8",
      sessionId: "session-loop8",
      status: "queued",
      providerId: "openai",
      model: "gpt-5",
      mode: "cowork",
      toolTier: "implicit-tools",
      toolAutonomy: "safe_auto",
      webMode: "deep",
      memoryMode: "on",
      thinkingLevel: "extended",
      executionStyle: "agentic_surface",
      diagnosticMetadata: {
        capabilityTargets: ["coverage"],
        expectedRuntimeSignals: ["tail"],
        likelyFailureClasses: ["branch_miss"],
      },
      responseText: "response",
      derivedResponseText: "derived",
      derivedResponseSignals: ["signal"],
      trace: { turnId: "turn-loop8", sessionId: "session-loop8", status: "completed" } as never,
      citations: [{ citationId: "cite-loop8", title: "Source", url: "https://example.test/source" }],
      integrity: { validationStatus: "valid", signals: ["ok"] },
      error: "old error",
      startedAt: "2026-05-14T11:00:00.000Z",
      finishedAt: "2026-05-14T11:01:00.000Z",
    });
    assert.equal(created.providerId, "openai");
    assert.equal(created.executionStyle, "agentic_surface");

    const patched = repo.patch("pprun-loop8", {
      mode: null as never,
      toolTier: null as never,
      toolAutonomy: null as never,
      webMode: null as never,
      memoryMode: null as never,
      thinkingLevel: null as never,
      executionStyle: null as never,
      diagnosticMetadata: null as never,
      responseText: null as never,
      derivedResponseText: null as never,
      derivedResponseSignals: null as never,
      trace: null as never,
      citations: null as never,
      integrity: null as never,
      error: null as never,
      finishedAt: null as never,
    });
    assert.equal(patched.mode, undefined);
    assert.equal(patched.trace, null);
    assert.equal(patched.finishedAt, undefined);

    const internal = repo as unknown as {
      listByPackStmt: { all: (...args: unknown[]) => unknown };
      listByTestStmt: { all: (...args: unknown[]) => unknown };
      deleteByPackStmt: { run: (...args: unknown[]) => unknown };
    };
    internal.listByPackStmt = { all: () => ({ not: "rows" }) };
    internal.listByTestStmt = { all: () => [null] };
    internal.deleteByPackStmt = { run: () => ({ changes: undefined }) };
    assert.deepEqual(repo.listByPack("pack-loop8"), []);
    assert.deepEqual(repo.listByTest("TEST-LOOP8"), []);
    assert.equal(repo.deleteByPack("pack-loop8"), 0);
  });

  it("covers delegation run defaults and optional patch clearing branches", () => {
    const repo = new ChatDelegationRunRepository(createDb("delegation-run-loop8"));
    const created = repo.create({
      runId: "delegation-loop8",
      sessionId: "session-loop8",
      taskId: "task-loop8",
      objective: "Exercise delegation tails",
      roles: ["Researcher"],
      mode: "sequential",
    });
    assert.equal(created.providerId, undefined);
    assert.equal(created.status, "running");
    assert.equal(typeof created.startedAt, "string");

    const populated = repo.patch("delegation-loop8", {
      visibility: "explicit",
      workflowTemplate: "qa",
      executionPlanId: "plan-loop8",
      routeDecision: {
        modePolicy: "cowork",
        workflowTemplate: "qa",
        hidden: false,
        visibility: "explicit",
        intensity: "standard",
        providerPreference: "balanced",
        reviewDepth: "standard",
        parallelism: "sequential",
        selectedRoles: ["QA"],
        selectedProviders: [],
        triggerReason: "coverage",
      } as never,
      finalSummary: "summary",
      stitchedOutput: "stitched",
      citations: [{ citationId: "cite-loop8", title: "Source", url: "https://example.test/source" }],
      trace: { effectiveModel: "gpt-5" } as never,
      finishedAt: "2026-05-14T11:02:00.000Z",
    });
    assert.equal(populated.visibility, "explicit");

    const preserved = repo.patch("delegation-loop8", {});
    assert.equal(preserved.workflowTemplate, "qa");
    assert.equal(preserved.finishedAt, "2026-05-14T11:02:00.000Z");

    const empty = repo.create({
      runId: "delegation-empty-loop19",
      sessionId: "session-empty-loop19",
      taskId: "task-empty-loop19",
      objective: "Keep unset optional delegation fields explicit",
      roles: [],
      mode: "sequential",
    });
    const emptyPreserved = repo.patch(empty.runId, {});
    assert.equal(emptyPreserved.visibility, undefined);
    assert.equal(emptyPreserved.workflowTemplate, undefined);
    assert.equal(emptyPreserved.executionPlanId, undefined);
    assert.equal(emptyPreserved.finalSummary, undefined);
    assert.equal(emptyPreserved.finishedAt, undefined);
    assert.deepEqual(emptyPreserved.routeDecision, undefined);
    assert.equal(emptyPreserved.trace, undefined);
  });

  it("covers agent profile nullish create/update defaults without seeding hidden arrays", () => {
    const repo = new AgentProfileRepository(createDb("agent-profile-loop19"));
    const created = repo.create({
      roleId: "coverage-tail",
      name: "Coverage Tail",
      title: "Branch Tail Agent",
      summary: "Exercises optional profile defaults.",
    });
    assert.deepEqual(created.specialties, []);
    assert.deepEqual(created.defaultTools, []);
    assert.deepEqual(created.aliases, []);
    assert.equal(created.presetDefaults, undefined);

    const patched = repo.update(created.agentId, {
      presetDefaults: {
        presetLabel: "",
        presetSummary: "Summary fallback",
        promptFraming: "Frame follow-up work.",
      },
    });
    assert.deepEqual(patched.specialties, []);
    assert.deepEqual(patched.defaultTools, []);
    assert.deepEqual(patched.aliases, []);
    assert.deepEqual(patched.presetDefaults, {
      presetLabel: undefined,
      presetSummary: "Summary fallback",
      routeHint: undefined,
      preferredProviderId: undefined,
      preferredModel: undefined,
      toolsPosture: undefined,
      knowledgeAttachmentIds: [],
      promptFraming: "Frame follow-up work.",
    });

    const preserved = repo.update(created.agentId, {});
    assert.deepEqual(preserved.presetDefaults, patched.presetDefaults);
  });

  it("covers imported agent catalog search/defaults and lifecycle timestamp preservation", () => {
    const repo = new ImportedAgentCatalogRepository(createDb("imported-agent-loop8"));
    const [created] = repo.upsertMany([importedAgentRecord("loop8")]);
    assert.equal(created?.definition.provenance.repoUrl, undefined);

    assert.deepEqual(
      repo.list({ workspaceId: " workspace-loop7 ", search: "researcher", limit: 0 }).map((row) => row.entryId),
      ["loop8"],
    );
    assert.deepEqual(repo.list({ workspaceId: "workspace-loop7", state: "all", parseStatus: "all", search: "   " }), [
      created,
    ]);

    const active = repo.patchState("loop8", { state: "active" }, "2026-05-14T11:03:00.000Z");
    const activeAgain = repo.patchState("loop8", { state: "active" }, "2026-05-14T11:04:00.000Z");
    assert.equal(activeAgain.activatedAt, active.activatedAt);
    const retired = repo.patchState("loop8", { state: "retired" }, "2026-05-14T11:05:00.000Z");
    const retiredAgain = repo.patchState("loop8", { state: "retired" }, "2026-05-14T11:06:00.000Z");
    assert.equal(retiredAgain.retiredAt, retired.retiredAt);
    assert.throws(() => repo.list({ workspaceId: "bad workspace" }), /workspaceId contains unsupported characters/);
  });

  it("covers memory context scoped cache defaults, malformed rows, and prune fallbacks", () => {
    const repo = new MemoryContextRepository(createDb("memory-context-loop8"));
    const created = repo.upsert({
      cacheKey: "cache-loop8",
      scope: "chat",
      queryHash: "query-loop8",
      sourcesHash: "sources-loop8",
      contextText: "distilled memory",
      citations: [],
      quality: { status: "generated" },
      originalTokenEstimate: 100,
      distilledTokenEstimate: 40,
      createdAt: "2026-05-14T11:00:00.000Z",
      expiresAt: "2026-05-15T11:00:00.000Z",
    });
    assert.equal(created.sessionId, undefined);
    assert.equal(repo.findFreshByCacheKey({ cacheKey: "missing", scope: "chat" }), undefined);

    const internal = repo as unknown as {
      getByCacheKeyStmt: { get: (...args: unknown[]) => unknown };
      listRecentStmt: { all: (...args: unknown[]) => unknown };
      listByRunStmt: { all: (...args: unknown[]) => unknown };
      pruneExpiredStmt: { run: (...args: unknown[]) => unknown };
      pruneOlderThanStmt: { run: (...args: unknown[]) => unknown };
    };
    internal.getByCacheKeyStmt = { get: () => ({ context_id: 1 }) };
    assert.equal(repo.findFreshByCacheKey({ cacheKey: "bad", scope: "chat" }), undefined);
    internal.listRecentStmt = { all: () => ({ not: "rows" }) };
    internal.listByRunStmt = { all: () => [null] };
    internal.pruneExpiredStmt = { run: () => ({ changes: undefined }) };
    internal.pruneOlderThanStmt = { run: () => ({ changes: undefined }) };
    assert.deepEqual(repo.listRecent(), []);
    assert.deepEqual(repo.listByRun("run-loop8"), []);
    assert.equal(repo.pruneExpired("2026-05-16T00:00:00.000Z"), 0);
    assert.equal(repo.pruneOlderThan("2026-05-01T00:00:00.000Z"), 0);
  });

  it("covers approval effect existing-row defaults and zero-change terminal updates", () => {
    const db = createDb("approval-effect-loop8");
    const repo = new ApprovalEffectRepository(db);
    insertApproval(db, "approval-loop8");
    const created = repo.upsert({
      approvalId: "approval-loop8",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-loop8",
      payload: { keep: true },
      result: { previous: true },
      status: "running",
      attemptCount: 2,
      claimedBy: "worker-a",
      claimedAt: "2026-05-14T11:00:00.000Z",
      leaseExpiresAt: "2026-05-14T11:05:00.000Z",
      version: 3,
      completedAt: "2026-05-14T11:06:00.000Z",
    });
    const preserved = repo.upsert({
      approvalId: "approval-loop8",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-loop8",
    });
    assert.deepEqual(preserved.payload, created.payload);
    assert.deepEqual(preserved.result, created.result);
    assert.equal(preserved.claimedBy, "worker-a");

    const internal = repo as unknown as {
      completeEffectStmt: { run: (...args: unknown[]) => unknown };
      skipEffectStmt: { run: (...args: unknown[]) => unknown };
      failEffectStmt: { run: (...args: unknown[]) => unknown };
      recoverExpiredStmt: { run: (...args: unknown[]) => unknown };
      renewLeaseStmt: { run: (...args: unknown[]) => unknown };
    };
    internal.completeEffectStmt = { run: () => ({ changes: undefined }) };
    internal.skipEffectStmt = { run: () => ({ changes: undefined }) };
    internal.failEffectStmt = { run: () => ({ changes: undefined }) };
    internal.recoverExpiredStmt = { run: () => ({ changes: undefined }) };
    internal.renewLeaseStmt = { run: () => ({ changes: undefined }) };
    assert.equal(repo.completeEffect(created.effectId, "worker-a", preserved.version, {}), undefined);
    assert.equal(repo.skipEffect(created.effectId, "worker-a", preserved.version, {}), undefined);
    assert.equal(repo.failEffect(created.effectId, "worker-a", preserved.version, { lastError: "failed" }), undefined);
    assert.equal(repo.recoverExpiredEffect(created.effectId, preserved.version, "2026-05-14T11:07:00.000Z"), undefined);
    assert.equal(
      repo.renewEffectLease(
        created.effectId,
        "worker-a",
        preserved.version,
        "2026-05-14T11:08:00.000Z",
        "2026-05-14T11:09:00.000Z",
      ),
      undefined,
    );
  });
});
